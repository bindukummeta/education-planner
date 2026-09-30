/*
 * EduSync — an optional, offline-first cloud-sync layer on top of EduStore.
 *
 * IndexedDB stays the local source-of-truth; this only mirrors changes to a
 * shared Supabase project (one generic `records` table + a `blobs` bucket).
 * Conflicts resolve last-write-wins by the client-authored `updatedAt`.
 *
 * If supabase-js failed to load, no config is present, or the config still
 * holds the placeholder values, EVERY method is a safe no-op and the app runs
 * exactly as it does offline. app.js only needs window.EduSync (guarded).
 *
 * A signed-in session with no user id fails closed: nothing is pushed or pulled.
 * Upserts target the owner-scoped key (owner, store, id) from
 * supabase/2026-per-account-isolation.sql. Blob objects live at "<uid>/<id>".
 */
(function () {
  "use strict";

  const TABLE = "records";
  const BUCKET = "blobs";
  const DEBOUNCE_MS = 3000;
  // Must match the unique (owner, store, id) constraint in the isolation migration.
  const OWNER_CONFLICT = "owner,store,id";
  const NO_UID_ERROR = "Sync refused: signed-in session has no user id";

  let sb = null;
  let debounceTimer = null;
  let inFlight = null;
  const listeners = new Set();
  const status = { enabled: false, signedIn: false, email: null, syncing: false, lastSyncedAt: 0, error: null };

  function getStatus() { return Object.assign({}, status); }
  function onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); }
  function notify() { listeners.forEach((fn) => { try { fn(getStatus()); } catch (_) {} }); }

  // Treat unset/placeholder config as "not configured" so a template file boots cleanly.
  function looksConfigured(c) {
    return !!c && typeof c.url === "string" && typeof c.anonKey === "string" &&
      c.url.indexOf("http") === 0 && c.url.indexOf("<") === -1 &&
      c.anonKey.length > 0 && c.anonKey.indexOf("<") === -1;
  }

  function init(config) {
    const cfg = config || (typeof window !== "undefined" && window.EDU_SYNC_CONFIG);
    if (typeof window === "undefined" || !window.supabase || !looksConfigured(cfg)) {
      status.enabled = false; notify(); return;
    }
    status.enabled = true;
    sb = window.supabase.createClient(cfg.url, cfg.anonKey, {
      auth: { persistSession: true, detectSessionInUrl: true, autoRefreshToken: true },
    });
    sb.auth.onAuthStateChange((_evt, session) => {
      applySession(session);
      if (session) {
        // Strip the magic-link token fragment from the URL after it's consumed.
        if (location.hash && location.hash.indexOf("access_token") !== -1) {
          try { history.replaceState(null, "", location.pathname + location.search); } catch (_) {}
        }
        syncNow();
      }
    });
    // Local mutations → debounced push/pull; foreground/online → immediate.
    if (window.EduStore && window.EduStore.onChange) window.EduStore.onChange(scheduleSync);
    window.addEventListener("online", function () { syncNow(); });
    document.addEventListener("visibilitychange", function () { if (!document.hidden) syncNow(); });
    // Restore a persisted session on boot.
    sb.auth.getSession().then(function (res) {
      const session = res && res.data ? res.data.session : null;
      applySession(session);
      if (session) syncNow();
    });
    notify();
  }

  function applySession(session) {
    status.signedIn = !!session;
    status.email = session && session.user ? session.user.email : null;
    notify();
  }

  async function signInWithEmail(email) {
    if (!sb) return { error: { message: "Sync not configured" } };
    return sb.auth.signInWithOtp({ email: email, options: { emailRedirectTo: location.origin + location.pathname } });
  }

  // Fallback for installed PWAs (esp. iOS) where the email link opens the system
  // browser instead of this app: the user pastes the 6-digit code from the same
  // email, and the resulting session lands in THIS context's storage.
  async function verifyOtpCode(email, code) {
    if (!sb) return { error: { message: "Sync not configured" } };
    const token = String(code || "").trim();
    const res = await sb.auth.verifyOtp({ email: email, token: token, type: "email" });
    if (res && !res.error) applySession(res.data ? res.data.session : null);
    return res;
  }

  async function getAccessToken() {
    if (!sb) return null;
    try {
      const res = await sb.auth.getSession();
      const session = res && res.data ? res.data.session : null;
      const token = session && session.access_token;
      return typeof token === "string" && token ? token : null;
    } catch (_) {
      return null;
    }
  }

  async function signOut() {
    if (!sb) return;
    await sb.auth.signOut();
    applySession(null);
  }

  function scheduleSync() {
    if (!sb) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () { debounceTimer = null; syncNow(); }, DEBOUNCE_MS);
  }

  // push then pull; overlapping calls coalesce into the single in-flight promise.
  function syncNow() {
    if (!sb) return Promise.resolve(getStatus());
    if (inFlight) return inFlight;
    inFlight = doSync()
      .catch(function (e) { status.error = (e && e.message) || String(e); })
      .then(function () { status.syncing = false; inFlight = null; notify(); return getStatus(); });
    return inFlight;
  }

  async function doSync() {
    const res = await sb.auth.getSession();
    const session = res && res.data ? res.data.session : null;
    if (!session) return; // signed out → no-op
    // Every row is scoped to the signed-in user so unrelated parents never see
    // each other's data. RLS enforces this server-side; owner is stamped here so
    // the write satisfies the policy and the pull can filter to just our rows.
    // No uid → fail closed. Do not write an unscoped row and do not pull.
    const uid = assertUid(session.user && session.user.id);
    status.syncing = true; status.error = null; notify();
    await pushLocal(uid);
    await pullRemote(uid);
    status.lastSyncedAt = Date.now();
  }

  function assertUid(uid) {
    if (!uid) throw new Error(NO_UID_ERROR);
    return uid;
  }

  // Storage object path for a blob, namespaced by user so image bytes are also
  // per-account (the bucket's RLS restricts each user to their own uid/ folder).
  function blobPath(uid, id) { return uid + "/" + id; }

  function upsertOwned(row) {
    return sb.from(TABLE).upsert(row, { onConflict: OWNER_CONFLICT });
  }

  async function pushLocal(uid) {
    assertUid(uid);
    const dirty = await window.EduStore.getDirty();
    if (!dirty || !dirty.length) return;
    const done = [];
    for (const d of dirty) {
      const rec = await window.EduStore.getRecord(d.store, d.id);
      const iso = new Date(d.updatedAt || (rec && rec.updatedAt) || Date.now()).toISOString();
      if (rec) {
        let data = rec;
        if (d.store === BUCKET) {
          const up = await sb.storage.from(BUCKET).upload(blobPath(uid, rec.id), rec.blob, { upsert: true, contentType: rec.type });
          if (up && up.error) throw up.error;
          data = { id: rec.id, type: rec.type, createdAt: rec.createdAt, updatedAt: rec.updatedAt };
        }
        const r = await upsertOwned({ owner: uid, store: d.store, id: d.id, data: data, updated_at: iso, deleted: false });
        if (r && r.error) throw r.error;
      } else {
        const r = await upsertOwned({ owner: uid, store: d.store, id: d.id, data: {}, updated_at: iso, deleted: true });
        if (r && r.error) throw r.error;
        if (d.store === BUCKET) { try { await sb.storage.from(BUCKET).remove([blobPath(uid, d.id)]); } catch (_) {} }
      }
      done.push(d.key);
    }
    await window.EduStore.clearDirty(done);
  }

  async function pullRemote(uid) {
    assertUid(uid);
    const since = (await window.EduStore.getMeta("lastPulledAt")) || 0;
    const res = await sb.from(TABLE).select("*").eq("owner", uid).gte("updated_at", new Date(since).toISOString()).order("updated_at", { ascending: true });
    if (res && res.error) throw res.error;
    const rows = (res && res.data) || [];
    let maxTs = since;
    for (const row of rows) {
      const ts = new Date(row.updated_at).getTime();
      if (ts > maxTs) maxTs = ts;
      if (row.deleted) { await window.EduStore.applyRemoteDelete(row.store, row.id); continue; }
      if (row.store === BUCKET) {
        const existing = await window.EduStore.getBlob(row.id);
        if (existing) continue;
        const dl = await sb.storage.from(BUCKET).download(blobPath(uid, row.id));
        if (!dl || dl.error || !dl.data) continue;
        const meta = row.data || {};
        await window.EduStore.applyRemote(BUCKET, { id: row.id, blob: dl.data, type: meta.type || dl.data.type || "image/jpeg", createdAt: meta.createdAt || ts, updatedAt: ts });
      } else {
        await window.EduStore.applyRemote(row.store, row.data);
      }
    }
    await window.EduStore.setMeta("lastPulledAt", maxTs);
  }

  window.EduSync = { init: init, signInWithEmail: signInWithEmail, verifyOtpCode: verifyOtpCode, signOut: signOut, getStatus: getStatus, getAccessToken: getAccessToken, syncNow: syncNow, onChange: onChange };
})();
