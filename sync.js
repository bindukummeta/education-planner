/*
 * EduSync — an optional, offline-first cloud-sync layer on top of EduStore.
 *
 * IndexedDB stays the local source-of-truth; this only mirrors changes to a
 * shared Supabase project (one generic `records` table + a `blobs` bucket).
 * Conflicts resolve last-write-wins by the client-authored `updatedAt`.
 * Pulls use a composite cursor (updated_at, store, id), saved after each
 * fully applied row. A numeric lastPulledAt from an older build is still
 * accepted and means "start at that timestamp". A confirmed missing photo is
 * tombstoned and sync continues. A transient download error stops the cursor
 * on the previous row so the next sync retries it. After an import,
 * pull runs first: cloud rows at or before importReconcileAt that are not on
 * the device are deleted in the cloud instead of being copied back.
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
  const PULL_PAGE_SIZE = 100;
  const PULL_MAX_PAGES = 50;
  const SESSION_ABSOLUTE_MS = 4 * 60 * 60 * 1000;
  const SESSION_IDLE_MS = 30 * 60 * 1000;
  const SESSION_STARTED_KEY = "edu.session.startedAt";
  const SESSION_ACTIVITY_KEY = "edu.session.lastActivityAt";
  const BLOB_PULL_ERROR = "A cloud photo could not be downloaded. Sync will retry this photo before newer changes.";
  const BLOB_MISSING_WARNING = "A cloud photo is missing from storage. Sync marked that photo deleted and continued.";
  let locking = false;
  // Access token rejected by the absolute or idle limit. A second apply of
  // that same token must not start a new window after the clock is cleared.
  let rejectedToken = "";
  let currentToken = "";
  // Must match the unique (owner, store, id) constraint in the isolation migration.
  const OWNER_CONFLICT = "owner,store,id";
  const NO_UID_ERROR = "Sync refused: signed-in session has no user id";

  let sb = null;
  let debounceTimer = null;
  let inFlight = null;
  const listeners = new Set();
  const status = { enabled: false, signedIn: false, email: null, syncing: false, lastSyncedAt: 0, error: null, warning: null };

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
      if (session && status.signedIn) {
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
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) return;
      noteActivity(Date.now());
      if (status.signedIn) syncNow();
    });
    window.addEventListener("pointerdown", function () { noteActivity(Date.now()); });
    window.addEventListener("keydown", function () { noteActivity(Date.now()); });
    // Restore a persisted session on boot.
    sb.auth.getSession().then(function (res) {
      const session = res && res.data ? res.data.session : null;
      applySession(session);
      if (session && status.signedIn) syncNow();
    });
    notify();
  }

  function clockStore() {
    try {
      if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
    } catch (_) { /* private mode */ }
    if (!window.__eduSessionClock) window.__eduSessionClock = {};
    const mem = window.__eduSessionClock;
    return {
      getItem: function (key) { return Object.prototype.hasOwnProperty.call(mem, key) ? mem[key] : null; },
      setItem: function (key, value) { mem[key] = String(value); },
      removeItem: function (key) { delete mem[key]; },
    };
  }

  function readStamp(key) {
    const raw = clockStore().getItem(key);
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function writeStamp(key, value) {
    try { clockStore().setItem(key, String(value)); } catch (_) {}
  }

  function clearSessionClock() {
    try {
      const store = clockStore();
      store.removeItem(SESSION_STARTED_KEY);
      store.removeItem(SESSION_ACTIVITY_KEY);
    } catch (_) {}
  }

  function sessionExpired(now) {
    const started = readStamp(SESSION_STARTED_KEY);
    if (!started) return "";
    if (now - started >= SESSION_ABSOLUTE_MS) return "absolute";
    const activity = readStamp(SESSION_ACTIVITY_KEY) || started;
    if (now - activity >= SESSION_IDLE_MS) return "idle";
    return "";
  }

  function lockMessage(reason) {
    if (reason === "idle") return "Signed out after 30 minutes of inactivity.";
    return "Signed out because the 4 hour sign-in limit was reached.";
  }

  function sessionToken(session) {
    const token = session && session.access_token;
    return typeof token === "string" ? token : "";
  }

  async function lockSession(reason, token) {
    if (locking) return;
    locking = true;
    if (token) rejectedToken = token;
    currentToken = "";
    status.signedIn = false;
    status.email = null;
    status.error = lockMessage(reason);
    status.warning = null;
    notify();
    try { if (sb) await sb.auth.signOut(); } catch (_) {}
    clearSessionClock();
    locking = false;
  }

  function noteActivity(now) {
    if (!status.signedIn) return;
    const reason = sessionExpired(now);
    if (reason) { lockSession(reason, currentToken); return; }
    const previous = readStamp(SESSION_ACTIVITY_KEY);
    if (!previous || now - previous >= 15000) writeStamp(SESSION_ACTIVITY_KEY, now);
  }

  async function applySession(session) {
    if (!session) {
      status.signedIn = false;
      status.email = null;
      if (!locking) clearSessionClock();
      notify();
      return;
    }
    const token = sessionToken(session);
    if (locking || (token && token === rejectedToken)) {
      status.signedIn = false;
      status.email = null;
      notify();
      return;
    }
    const now = Date.now();
    const reason = sessionExpired(now);
    if (reason) { await lockSession(reason, token); return; }
    if (!readStamp(SESSION_STARTED_KEY)) writeStamp(SESSION_STARTED_KEY, now);
    if (!readStamp(SESSION_ACTIVITY_KEY)) writeStamp(SESSION_ACTIVITY_KEY, now);
    rejectedToken = "";
    currentToken = token;
    status.signedIn = true;
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
    clearSessionClock();
    status.signedIn = false;
    status.email = null;
    if (!sb) { notify(); return; }
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
    if (!session) return;
    await applySession(session);
    if (!status.signedIn) return;
    // Every row is scoped to the signed-in user so unrelated parents never see
    // each other's data. RLS enforces this server-side; owner is stamped here so
    // the write satisfies the policy and the pull can filter to just our rows.
    // No uid → fail closed. Do not write an unscoped row and do not pull.
    const uid = assertUid(session.user && session.user.id);
    status.syncing = true; status.error = null; status.warning = null; notify();
    // Pull first so a newer cloud edit lands before this device uploads.
    // importReconcileAt is set by importAll. It stays until pull and push both finish.
    const reconcileAt = await window.EduStore.getMeta("importReconcileAt");
    const reconciling = typeof reconcileAt === "number" && reconcileAt > 0;
    await pullRemote(uid, reconciling ? reconcileAt : 0);
    await pushLocal(uid);
    if (reconciling) await window.EduStore.setMeta("importReconcileAt", 0);
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
      if (d.store === "meta" && (!window.EduStore.isSyncedMetaKey || !window.EduStore.isSyncedMetaKey(d.id))) {
        done.push(d.key);
        continue;
      }
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

  function rowTime(row) {
    const ts = new Date(row && row.updated_at).getTime();
    if (!ts) throw new Error("Sync pull stopped because a remote row has no updated time.");
    return ts;
  }

  function readCursor(raw) {
    if (raw && typeof raw === "object" && typeof raw.updatedAt === "number" && isFinite(raw.updatedAt)) {
      return {
        updatedAt: raw.updatedAt,
        store: typeof raw.store === "string" ? raw.store : "",
        id: raw.id == null ? "" : String(raw.id),
        legacy: false,
      };
    }
    const n = typeof raw === "number" && isFinite(raw) ? raw : 0;
    return { updatedAt: n, store: "", id: "", legacy: true };
  }

  function quotePg(value) {
    return '"' + String(value).replace(/"/g, '""') + '"';
  }

  async function commitPullCursor(cursor) {
    if (!cursor || cursor.legacy) return;
    await window.EduStore.setMeta("lastPulledAt", {
      updatedAt: cursor.updatedAt,
      store: cursor.store,
      id: cursor.id,
    });
  }

  function confirmedBlobMissing(dl) {
    const err = dl && dl.error;
    if (!err) return false;
    const statusCode = err.statusCode != null ? err.statusCode : err.status;
    if (String(statusCode) === "404") return true;
    const name = String(err.error || err.code || err.name || "");
    if (name === "NotFound" || name === "not_found" || name === "NotFoundError") return true;
    const message = String(err.message || "").toLowerCase();
    return message === "not found" || message.indexOf("object not found") !== -1;
  }

  async function applyPulledRow(uid, row, ts, tombs, reconciling, reconcileAt) {
    if (!row || !row.store || row.id == null || row.id === "") {
      throw new Error("Sync pull stopped because a remote row is missing its id.");
    }
    const key = row.store + ":" + row.id;
    const tomb = tombs[key];
    if (row.deleted) {
      // A delete from before the backup must not wipe rows the import just restored.
      if (reconciling && ts <= reconcileAt) return;
      if (tomb && (tomb.updatedAt || 0) > ts) return;
      await window.EduStore.applyRemoteDelete(row.store, row.id);
      if (window.EduStore.clearTombstone) await window.EduStore.clearTombstone(row.store, row.id);
      if (window.EduStore.clearDirty) await window.EduStore.clearDirty([key]);
      return;
    }
    // A newer local delete wins. Leave it dirty so push sends the tombstone.
    if (tomb && (tomb.updatedAt || 0) >= ts) return;
    if (reconciling && ts <= reconcileAt) {
      const local = row.store === BUCKET
        ? await window.EduStore.getBlob(row.id)
        : await window.EduStore.getRecord(row.store, row.id);
      if (!local && window.EduStore.queueStaleCloudDelete) {
        await window.EduStore.queueStaleCloudDelete(row.store, row.id, ts);
        return;
      }
    }
    if (row.store === "meta") {
      // Consent, the active child, the cursor, and the geocode cache never move.
      if (!window.EduStore.isSyncedMetaKey || !window.EduStore.isSyncedMetaKey(row.id)) return;
      const data = Object.assign({}, row.data, { id: row.id, key: (row.data && row.data.key) || row.id, updatedAt: ts });
      const applied = await window.EduStore.applyRemote("meta", data);
      if (applied && window.EduStore.clearDirty) await window.EduStore.clearDirty([key]);
      return;
    }
    if (row.store === BUCKET) {
      const existing = await window.EduStore.getBlob(row.id);
      const localTs = existing && typeof existing.updatedAt === "number" ? existing.updatedAt : 0;
      if (existing && localTs >= ts) return;
      const dl = await sb.storage.from(BUCKET).download(blobPath(uid, row.id));
      if (confirmedBlobMissing(dl)) {
        if (window.EduStore.queueStaleCloudDelete) {
          await window.EduStore.queueStaleCloudDelete(row.store, row.id, Math.max(ts, Date.now()));
        }
        status.warning = BLOB_MISSING_WARNING;
        notify();
        return;
      }
      if (!dl || dl.error || !dl.data) throw new Error(BLOB_PULL_ERROR);
      const meta = row.data || {};
      const applied = await window.EduStore.applyRemote(BUCKET, {
        id: row.id,
        blob: dl.data,
        type: meta.type || dl.data.type || "image/jpeg",
        createdAt: meta.createdAt || ts,
        updatedAt: ts,
      });
      if (applied && window.EduStore.clearDirty) await window.EduStore.clearDirty([key]);
      return;
    }
    const data = Object.assign({}, row.data, { id: row.id, updatedAt: ts });
    const applied = await window.EduStore.applyRemote(row.store, data);
    if (applied) {
      if (window.EduStore.clearDirty) await window.EduStore.clearDirty([key]);
      if (tomb && window.EduStore.clearTombstone) await window.EduStore.clearTombstone(row.store, row.id);
    }
  }

  function fetchPullPage(uid, cursor) {
    let query = sb.from(TABLE).select("*").eq("owner", uid);
    if (!cursor || cursor.legacy) {
      query = query.gte("updated_at", new Date(cursor && cursor.updatedAt ? cursor.updatedAt : 0).toISOString());
    } else {
      const iso = quotePg(new Date(cursor.updatedAt).toISOString());
      const store = quotePg(cursor.store);
      const id = quotePg(cursor.id);
      query = query.or(
        "updated_at.gt." + iso +
        ",and(updated_at.eq." + iso + ",store.gt." + store + ")" +
        ",and(updated_at.eq." + iso + ",store.eq." + store + ",id.gt." + id + ")"
      );
    }
    return query
      .order("updated_at", { ascending: true })
      .order("store", { ascending: true })
      .order("id", { ascending: true })
      .range(0, PULL_PAGE_SIZE - 1);
  }

  async function pullRemote(uid, reconcileAt) {
    assertUid(uid);
    let cursor = readCursor(await window.EduStore.getMeta("lastPulledAt"));
    const reconciling = typeof reconcileAt === "number" && reconcileAt > 0;
    const tombRows = window.EduStore.getTombstones ? ((await window.EduStore.getTombstones(0)) || []) : [];
    const tombs = {};
    for (let i = 0; i < tombRows.length; i++) {
      const tomb = tombRows[i];
      if (tomb && tomb.store && tomb.id != null) tombs[tomb.store + ":" + tomb.id] = tomb;
    }
    for (let page = 0; page < PULL_MAX_PAGES; page++) {
      let res;
      try {
        res = await fetchPullPage(uid, cursor);
      } catch (err) {
        throw err;
      }
      if (!res || res.error) {
        const message = res && res.error && res.error.message ? res.error.message : "Sync pull failed";
        throw new Error(message);
      }
      const rows = res.data || [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const ts = rowTime(row);
        await applyPulledRow(uid, row, ts, tombs, reconciling, reconcileAt);
        cursor = { updatedAt: ts, store: String(row.store), id: String(row.id), legacy: false };
        await commitPullCursor(cursor);
      }
      if (rows.length < PULL_PAGE_SIZE) return;
    }
    throw new Error("Sync pull stopped because the remote change set is too large. It will continue on the next sync.");
  }

  window.EduSync = {
    init: init,
    signInWithEmail: signInWithEmail,
    verifyOtpCode: verifyOtpCode,
    signOut: signOut,
    getStatus: getStatus,
    getAccessToken: getAccessToken,
    syncNow: syncNow,
    onChange: onChange,
    PULL_PAGE_SIZE: PULL_PAGE_SIZE,
    PULL_MAX_PAGES: PULL_MAX_PAGES,
    SESSION_ABSOLUTE_MS: SESSION_ABSOLUTE_MS,
    SESSION_IDLE_MS: SESSION_IDLE_MS,
  };
})();
