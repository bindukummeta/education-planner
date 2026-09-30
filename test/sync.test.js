/*
 * Tests for the optional cloud-sync layer:
 *   Part A — storage.js sync seam (LWW applyRemote, applyRemoteDelete, dirty
 *            queue, tombstones) run against a tiny in-memory IndexedDB shim.
 *   Part B — sync.js push/pull engine run with a mocked EduStore + Supabase.
 * Both load the REAL shipped source (via vm), so no logic is duplicated here.
 * Zero external deps — run with `npm test` or `node test/sync.test.js`.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

let passed = 0;
function check(desc, cond) { assert.ok(cond, desc); passed++; }

// ---- minimal in-memory IndexedDB shim (only what storage.js uses) ----
function makeIDB() {
  const data = {}, keyPaths = {};
  const quota = { once: false };
  function req(resultFn) {
    const r = {};
    Promise.resolve().then(() => {
      try { r.result = resultFn(); if (r.onsuccess) r.onsuccess({ target: { result: r.result } }); }
      catch (e) { r.error = e; if (r.onerror) r.onerror({ target: { error: e } }); }
    });
    return r;
  }
  function proxy(name) {
    const kp = keyPaths[name] || "id";
    const map = data[name] || (data[name] = new Map());
    return {
      get: (id) => req(() => map.get(id)),
      getAll: () => req(() => Array.from(map.values())),
      put: (rec) => req(() => {
        if (quota.once) {
          quota.once = false;
          const err = new Error("QuotaExceededError");
          err.name = "QuotaExceededError";
          throw err;
        }
        map.set(rec[kp], rec);
        return rec[kp];
      }),
      delete: (id) => req(() => { map.delete(id); return undefined; }),
      clear: () => req(() => { map.clear(); return undefined; }),
    };
  }
  const db = {
    objectStoreNames: { contains: (n) => Object.prototype.hasOwnProperty.call(data, n) },
    createObjectStore: (name, opts) => {
      data[name] = new Map(); keyPaths[name] = (opts && opts.keyPath) || "id";
      return { createIndex: () => {}, put: (rec) => { data[name].set(rec[keyPaths[name]], rec); } };
    },
    transaction: () => ({ objectStore: (n) => proxy(n) }),
  };
  return {
    quota: quota,
    open: () => {
      const r = {};
      Promise.resolve().then(() => {
        r.result = db;
        if (r.onupgradeneeded) r.onupgradeneeded({ target: { result: db } });
        if (r.onsuccess) r.onsuccess({ target: { result: db } });
      });
      return r;
    },
  };
}

function FileReaderShim() {}
FileReaderShim.prototype.readAsDataURL = function (blob) {
  const fr = this;
  const type = (blob && blob.type) || "application/octet-stream";
  Promise.resolve().then(() => {
    fr.result = "data:" + type + ";base64,QQ==";
    if (fr.onload) fr.onload();
  });
};

function loadStorage() {
  const idb = makeIDB();
  const src = fs.readFileSync(path.join(__dirname, "..", "storage.js"), "utf8");
  const sandbox = {
    window: {}, indexedDB: idb, Date, Math, Promise, console,
    Blob: Blob, atob: atob, btoa: btoa, FileReader: FileReaderShim,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "storage.js" });
  return { S: sandbox.window.EduStore, quota: idb.quota };
}

async function partA() {
  const loaded = loadStorage();
  const S = loaded.S;
  await S.ready();

  const e = await S.addEntry({ subject: "maths", date: "2026-01-01" });
  check("addEntry stamps updatedAt", typeof e.updatedAt === "number");
  let dirty = await S.getDirty();
  check("add marks the record dirty", dirty.some((d) => d.key === "entries:" + e.id));

  // LWW: an older remote copy is ignored.
  const older = Object.assign({}, e, { updatedAt: e.updatedAt - 1000, note: "old" });
  const a1 = await S.applyRemote("entries", older);
  check("applyRemote ignores older remote", a1 === false);
  const kept = await S.getRecord("entries", e.id);
  check("older remote does not overwrite local", kept.note === undefined);

  // LWW: a newer remote copy wins.
  const newer = Object.assign({}, e, { updatedAt: e.updatedAt + 1000, note: "new" });
  const a2 = await S.applyRemote("entries", newer);
  check("applyRemote accepts newer remote", a2 === true);
  const upd = await S.getRecord("entries", e.id);
  check("newer remote overwrites local", upd.note === "new");
  check("applyRemote never marks dirty", !(await S.getDirty()).some((d) => d.note));

  // clearDirty empties the queue.
  await S.clearDirty((await S.getDirty()).map((d) => d.key));
  check("clearDirty empties the queue", (await S.getDirty()).length === 0);

  // delete writes a tombstone and marks dirty.
  await S.deleteEntry(e.id);
  const ts = await S.getTombstones(0);
  check("delete writes a tombstone", ts.some((t) => t.id === e.id));
  check("delete marks dirty", (await S.getDirty()).some((d) => d.key === "entries:" + e.id));
  check("delete removes the local record", (await S.getRecord("entries", e.id)) === undefined);

  const future = Date.now() + 600000;
  check("stale cloud delete is queued", await S.queueStaleCloudDelete("entries", "stale-cloud", future) === true);
  const staleTomb = (await S.getTombstones(0)).find((t) => t.id === "stale-cloud");
  check("stale cloud delete is strictly newer than the remote time", staleTomb && staleTomb.updatedAt > future);
  const againTs = staleTomb.updatedAt;
  check("a second stale delete is queued", await S.queueStaleCloudDelete("entries", "stale-cloud", future) === true);
  const newerTomb = (await S.getTombstones(0)).find((t) => t.id === "stale-cloud");
  check("a repeated stale delete is strictly newer than the current tombstone", newerTomb.updatedAt > againTs);

  // applyRemoteDelete removes locally without recording dirty.
  const e2 = await S.addEntry({ subject: "vr", date: "2026-02-02" });
  await S.clearDirty((await S.getDirty()).map((d) => d.key));
  await S.applyRemoteDelete("entries", e2.id);
  check("applyRemoteDelete removes the record", (await S.getRecord("entries", e2.id)) === undefined);
  check("applyRemoteDelete records nothing dirty", (await S.getDirty()).length === 0);

  check("backup version matches the schema version", S.BACKUP_VERSION === 6);
  check("mastery meta is synced", S.isSyncedMetaKey("vocabMastery.student-1") && S.isSyncedMetaKey("practiceMastery.abc"));
  check("year group is synced progress", S.isSyncedMetaKey("student.yearGroup") === true);
  check("active child, consent, cursor, and geocode stay device-only",
    S.isDeviceMetaKey("activeStudentId") && S.isDeviceMetaKey("analyzer.enhancedAi.enabled") &&
    S.isDeviceMetaKey("lastPulledAt") && S.isDeviceMetaKey("geo.TW131AA") &&
    !S.isSyncedMetaKey("activeStudentId") && !S.isSyncedMetaKey("analyzer.enhancedAi.enabled"));
  check("unknown meta stays device-only", S.isDeviceMetaKey("not-a-classified-key") && !S.isSyncedMetaKey("not-a-classified-key"));
  check("consent key is a known device key", S.isKnownDeviceMetaKey("analyzer.enhancedAi.enabled") === true);

  await S.setMeta("vocabMastery.student-1", { cat: { seen: 2, correct: 1 } });
  await S.setMeta("student.yearGroup", "y5");
  await S.setMeta("analyzer.enhancedAi.enabled", true);
  await S.setMeta("activeStudentId", "student-1");
  await S.setMeta("geo.TW131AA", { lat: 1, lon: 2 });
  await S.setMeta("lastPulledAt", 4242);
  await S.setMeta("coach.audience", "child");
  const masteryDirty = await S.getDirty();
  check("synced mastery is queued", masteryDirty.some((d) => d.key === "meta:vocabMastery.student-1"));
  check("consent is not queued for sync", !masteryDirty.some((d) => d.id === "analyzer.enhancedAi.enabled"));
  check("geocode cache is not queued for sync", !masteryDirty.some((d) => String(d.id || "").indexOf("geo.") === 0));

  const blobId = await S.putBlob(new Blob(["A"], { type: "image/png" }), "image/png");
  const live = await S.addEntry({ subject: "vr", date: "2026-05-05", studentId: "student-1" });
  const exported = await S.exportAll();
  check("export uses the schema backup version", exported.version === S.BACKUP_VERSION);
  check("export keeps approved meta", exported.meta.some((m) => m.key === "vocabMastery.student-1" && m.value.cat.correct === 1));
  check("export keeps the school year", exported.meta.some((m) => m.key === "student.yearGroup" && m.value === "y5"));
  check("export omits consent, active child, cursor, and geocode cache",
    !exported.meta.some((m) => m.key === "analyzer.enhancedAi.enabled" || m.key === "activeStudentId" || m.key === "lastPulledAt" || m.key.indexOf("geo.") === 0));
  check("export carries blob updatedAt", exported.blobs.some((b) => b.id === blobId && typeof b.updatedAt === "number" && b.dataURL.indexOf("data:image/png") === 0));

  await S.setMeta("vocabMastery.student-1", { cat: { seen: 9, correct: 9 } });
  await S.setMeta("analyzer.enhancedAi.enabled", true);
  const ghost = await S.addEntry({ subject: "english", date: "2026-03-03", studentId: "student-1" });
  await S.deleteEntry(ghost.id);
  check("pre-import tombstone exists", (await S.getTombstones(0)).some((t) => t.id === ghost.id));
  await S.importAll(exported);
  check("round trip restores mastery", (await S.getMeta("vocabMastery.student-1")).cat.correct === 1);
  check("round trip restores the school year", (await S.getMeta("student.yearGroup")) === "y5");
  check("import keeps Enhanced AI consent on the device", (await S.getMeta("analyzer.enhancedAi.enabled")) === true);
  check("import keeps the active child", (await S.getMeta("activeStudentId")) === "student-1");
  check("import keeps the geocode cache", (await S.getMeta("geo.TW131AA")).lat === 1);
  check("import resets the sync cursor", (await S.getMeta("lastPulledAt")) === 0);
  check("import records the reconcile watermark", (await S.getMeta("importReconcileAt")) === exported.exportedAt);
  const afterDirty = await S.getDirty();
  check("import drops the pre-import tombstone", !(await S.getTombstones(0)).some((t) => t.id === ghost.id));
  check("import does not queue the stale delete", !afterDirty.some((d) => d.id === ghost.id));
  check("import queues the restored entry", afterDirty.some((d) => d.store === "entries" && d.id === live.id));
  const restoredBlob = await S.getBlob(blobId);
  check("round trip keeps the blob", !!restoredBlob && restoredBlob.type === "image/png");

  const keptId = (await S.getEntries({ studentId: "*ALL*" }))[0].id;
  let rejected = false;
  try { await S.importAll({ version: 7, schools: [] }); } catch (err) { rejected = err && err.code === "invalid_backup"; }
  check("a newer backup version is rejected", rejected === true);
  check("a rejected import does not wipe existing rows", (await S.getRecord("entries", keptId)) != null);
  let tooBig = false;
  const schools = [];
  for (let i = 0; i < S.BACKUP_LIMITS.recordsPerStore + 1; i++) schools.push({ id: "s" + i, name: "N" });
  try { await S.importAll({ version: 6, schools: schools }); } catch (err) { tooBig = err && err.code === "backup_too_large"; }
  check("an oversized backup is rejected", tooBig === true);
  check("an oversized backup does not wipe existing rows", (await S.getRecord("entries", keptId)) != null);
  let deviceMeta = false;
  try {
    await S.importAll({ version: 6, meta: [{ key: "analyzer.enhancedAi.enabled", value: false }] });
  } catch (err) { deviceMeta = err && err.code === "invalid_backup"; }
  check("a backup cannot import Enhanced AI consent", deviceMeta === true);
  check("rejected consent import leaves the switch on", (await S.getMeta("analyzer.enhancedAi.enabled")) === true);

  const legacy = { version: 5, schools: [{ id: "legacy-school", name: "Old" }], entries: [] };
  const masteryBeforeLegacy = await S.getMeta("vocabMastery.student-1");
  await S.importAll(legacy);
  check("a v5 backup still imports", (await S.getSchools()).some((s) => s.id === "legacy-school"));
  check("a v5 backup keeps mastery it could not represent", (await S.getMeta("vocabMastery.student-1")).cat.correct === masteryBeforeLegacy.cat.correct);
  check("a v5 backup still resets the cursor and tombstones",
    (await S.getMeta("lastPulledAt")) === 0 && (await S.getTombstones(0)).length === 0);

  const beforeQuota = (await S.getSchools()).length;
  loaded.quota.once = true;
  let quotaErr = null;
  try { await S.addEntry({ subject: "maths", date: "2026-04-04" }); } catch (err) { quotaErr = err; }
  check("quota failure is a stable public error", !!quotaErr && quotaErr.code === "storage_quota" && quotaErr.name === "EduStorageQuotaError" && quotaErr.publicMessage === S.STORAGE_QUOTA_MESSAGE);
  check("quota failure does not remove saved rows", (await S.getSchools()).length === beforeQuota);
}

// ---- Part B: sync.js push/pull engine with mocked EduStore + Supabase ----
function loadSync(win, globals) {
  const src = fs.readFileSync(path.join(__dirname, "..", "sync.js"), "utf8");
  const sandbox = Object.assign({ window: win, console, Promise, Date, setTimeout, clearTimeout }, globals);
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "sync.js" });
  return win.EduSync;
}

async function partB() {
  const T = 1000; // base timestamp
  // Mock local store: one live entry, one deleted entry (no local record), one blob.
  let dirtyQ = [
    { key: "entries:e1", store: "entries", id: "e1", updatedAt: T + 5 },
    { key: "entries:gone", store: "entries", id: "gone", updatedAt: T + 6 },
    { key: "blobs:b1", store: "blobs", id: "b1", updatedAt: T + 7 },
  ];
  const local = { entries: { e1: { id: "e1", updatedAt: T + 5, note: "hi" } }, blobs: { b1: { id: "b1", blob: { fake: true }, type: "image/png", createdAt: T, updatedAt: T + 7 } } };
  const meta = {};
  const applied = [], deletes = [];
  const store = {
    onChange: () => {},
    getDirty: async () => dirtyQ.slice(),
    getRecord: async (s, id) => (local[s] || {})[id],
    clearDirty: async (keys) => { dirtyQ = dirtyQ.filter((d) => keys.indexOf(d.key) < 0); },
    getMeta: async (k) => meta[k],
    setMeta: async (k, v) => { meta[k] = v; },
    getBlob: async (id) => (local.blobs || {})[id],
    applyRemote: async (s, rec) => { applied.push({ store: s, rec: rec }); },
    applyRemoteDelete: async (s, id) => { deletes.push({ store: s, id: id }); },
  };

  // Mock Supabase client.
  const sbCalls = { upserts: [], upsertOpts: [], uploads: [], removes: [] };
  const remoteRows = [
    { store: "entries", id: "r1", data: { id: "r1", updatedAt: T + 20 }, updated_at: new Date(T + 20).toISOString(), deleted: false },
    { store: "entries", id: "r2", data: {}, updated_at: new Date(T + 30).toISOString(), deleted: true },
    { store: "blobs", id: "rb", data: { type: "image/jpeg", createdAt: T }, updated_at: new Date(T + 40).toISOString(), deleted: false },
  ];
  const UID = "user-123";
  const sbCallsEq = [];
  const sb = {
    auth: {
      onAuthStateChange: () => {},
      getSession: async () => ({ data: { session: { access_token: "sess-token", user: { id: UID, email: "fam@x.com" } } } }),
      signInWithOtp: async () => ({}),
      signOut: async () => ({}),
    },
    from: () => ({
      upsert: async (row, opts) => { sbCalls.upserts.push(row); sbCalls.upsertOpts.push(opts || null); return { error: null }; },
      // Pull is now scoped by owner: select(...).eq("owner", uid).gte(...).order(...)
      select: () => {
        const api = {
          eq: (col, val) => { sbCallsEq.push({ col: col, val: val }); return api; },
          gte: () => api,
          or: () => api,
          order: () => api,
          range: (from, to) => Promise.resolve({ data: remoteRows.slice(from, to + 1), error: null }),
        };
        return api;
      },
    }),
    storage: {
      from: () => ({
        upload: async (id, blob, opts) => { sbCalls.uploads.push({ id: id, opts: opts }); return { error: null }; },
        download: async (id) => { sbCalls.downloads = sbCalls.downloads || []; sbCalls.downloads.push(id); return { data: { type: "image/jpeg" }, error: null }; },
        remove: async (ids) => { sbCalls.removes.push(ids); return { error: null }; },
      }),
    },
  };

  const win = {
    supabase: { createClient: () => sb },
    EduStore: store,
    EDU_SYNC_CONFIG: { url: "https://ref.supabase.co", anonKey: "anon-key-123" },
    addEventListener: () => {},
  };
  const globals = {
    document: { addEventListener: () => {}, hidden: false },
    location: { origin: "http://localhost", pathname: "/", search: "", hash: "" },
    history: { replaceState: () => {} },
  };
  const EduSync = loadSync(win, globals);

  EduSync.init(win.EDU_SYNC_CONFIG);
  check("getStatus reports enabled with valid config", EduSync.getStatus().enabled === true);
  check("getAccessToken returns the session access token", (await EduSync.getAccessToken()) === "sess-token");
  await EduSync.syncNow();

  // Push: three upserts (2 live incl. blob, 1 tombstone) and the queue is cleared.
  check("push upserts the live entry", sbCalls.upserts.some((u) => u.store === "entries" && u.id === "e1" && u.deleted === false));
  check("push upserts a tombstone for the deleted record", sbCalls.upserts.some((u) => u.id === "gone" && u.deleted === true));
  check("blob push uploads bytes with the id + upsert", sbCalls.uploads.some((u) => u.id === UID + "/b1" && u.opts && u.opts.upsert === true));
  check("blob upsert carries no binary in data", sbCalls.upserts.some((u) => u.store === "blobs" && u.data && u.data.blob === undefined));
  check("clearDirty empties the push queue", dirtyQ.length === 0);

  // Owner scoping: every upsert is stamped with the signed-in user's id.
  check("every push upsert stamps owner = uid", sbCalls.upserts.length > 0 && sbCalls.upserts.every((u) => u.owner === UID));
  check("every push upsert uses onConflict owner,store,id", sbCalls.upsertOpts.length === sbCalls.upserts.length && sbCalls.upsertOpts.every((o) => o && o.onConflict === "owner,store,id"));
  check("blob object path is namespaced by uid", sbCalls.uploads.every((u) => u.id.indexOf(UID + "/") === 0));

  // Pull: live row applied, deleted row → applyRemoteDelete, blob downloaded+applied.
  check("pull filters the records query by owner = uid", sbCallsEq.some((e) => e.col === "owner" && e.val === UID));
  check("pull applies the live remote row", applied.some((a) => a.store === "entries" && a.rec.id === "r1"));
  check("pull routes deleted rows to applyRemoteDelete", deletes.some((d) => d.id === "r2"));
  check("pull downloads + applies a missing blob", applied.some((a) => a.store === "blobs" && a.rec.id === "rb"));
  check("pull downloads the blob from the uid-scoped path", (sbCalls.downloads || []).some((p) => p === UID + "/rb"));
  check("pull advances lastPulledAt to the max updated_at", meta.lastPulledAt && meta.lastPulledAt.updatedAt === T + 40 && meta.lastPulledAt.store === "blobs" && meta.lastPulledAt.id === "rb");
}

// ---- disabled/no-op guard ----
async function partC() {
  const win = { EDU_SYNC_CONFIG: { url: "https://ref.supabase.co", anonKey: "k" }, addEventListener: () => {} };
  // No window.supabase → must stay disabled and every call is a safe no-op.
  const EduSync = loadSync(win, { document: { addEventListener: () => {}, hidden: false }, location: { origin: "", pathname: "/", search: "", hash: "" }, history: {} });
  EduSync.init(win.EDU_SYNC_CONFIG);
  check("no supabase → sync stays disabled", EduSync.getStatus().enabled === false);
  check("syncNow is a safe no-op when disabled", (await EduSync.syncNow()).enabled === false);
  check("getAccessToken is null when sync is disabled", (await EduSync.getAccessToken()) === null);
}

// Signed-in session with no user id must not push, pull, or clear the dirty queue.
async function partD() {
  let dirtyQ = [{ key: "entries:e1", store: "entries", id: "e1", updatedAt: 5 }];
  const sbCalls = { upserts: [], uploads: [], downloads: [], eqs: [] };
  const sb = {
    auth: {
      onAuthStateChange: () => {},
      getSession: async () => ({ data: { session: { user: { email: "fam@x.com" } } } }),
    },
    from: () => ({
      upsert: async (row) => { sbCalls.upserts.push(row); return { error: null }; },
      select: () => ({ eq: (col, val) => { sbCalls.eqs.push({ col: col, val: val }); return { gte: () => ({ order: async () => ({ data: [], error: null }) }) }; } }),
    }),
    storage: {
      from: () => ({
        upload: async (id) => { sbCalls.uploads.push(id); return { error: null }; },
        download: async (id) => { sbCalls.downloads.push(id); return { data: null, error: null }; },
        remove: async () => ({ error: null }),
      }),
    },
  };
  const store = {
    onChange: () => {},
    getDirty: async () => dirtyQ.slice(),
    getRecord: async () => ({ id: "e1", updatedAt: 5, note: "local" }),
    clearDirty: async (keys) => { dirtyQ = dirtyQ.filter((d) => keys.indexOf(d.key) < 0); },
    getMeta: async () => 0,
    setMeta: async () => {},
    getBlob: async () => undefined,
    applyRemote: async () => {},
    applyRemoteDelete: async () => {},
  };
  const win = {
    supabase: { createClient: () => sb },
    EduStore: store,
    EDU_SYNC_CONFIG: { url: "https://ref.supabase.co", anonKey: "anon-key-123" },
    addEventListener: () => {},
  };
  const globals = {
    document: { addEventListener: () => {}, hidden: false },
    location: { origin: "http://localhost", pathname: "/", search: "", hash: "" },
    history: { replaceState: () => {} },
  };
  const EduSync = loadSync(win, globals);
  EduSync.init(win.EDU_SYNC_CONFIG);
  const st = await EduSync.syncNow();
  check("no uid → status records the refusal", st.error && st.error.indexOf("no user id") !== -1);
  check("no uid → no upserts", sbCalls.upserts.length === 0);
  check("no uid → no owner filter / pull", sbCalls.eqs.length === 0);
  check("no uid → no blob upload or download", sbCalls.uploads.length === 0 && sbCalls.downloads.length === 0);
  check("no uid → dirty queue is kept", dirtyQ.length === 1);
  check("no uid → lastSyncedAt stays unset", !st.lastSyncedAt);
  check("getAccessToken is null without an access token", (await EduSync.getAccessToken()) === null);
}

function iso(ms) { return new Date(ms).toISOString(); }

function unquotePg(token) {
  if (!token) return "";
  if (token.charAt(0) === '"') return token.slice(1, -1).replace(/""/g, '"');
  return token;
}

function rowAfter(row, cursor) {
  const ts = new Date(row.updated_at).getTime();
  if (!cursor || cursor.legacy) return ts >= (cursor ? cursor.updatedAt : 0);
  if (ts !== cursor.updatedAt) return ts > cursor.updatedAt;
  if (row.store !== cursor.store) return row.store > cursor.store;
  return String(row.id) > String(cursor.id);
}

function filteredQuery(rows, calls) {
  let cursor = { updatedAt: 0, store: "", id: "", legacy: true };
  const api = {
    eq: (col, val) => { calls.eqs.push({ col: col, val: val }); return api; },
    gte: (_col, val) => {
      cursor = { updatedAt: new Date(val).getTime() || 0, store: "", id: "", legacy: true };
      calls.gtes.push(cursor.updatedAt);
      return api;
    },
    or: (expr) => {
      calls.ors = calls.ors || [];
      calls.ors.push(expr);
      const iso = /updated_at\.gt\.("(?:[^"]|"")*"|[^,)]+)/.exec(expr);
      const storeEq = /store\.eq\.("(?:[^"]|"")*"|[^,)]+)/.exec(expr);
      const idGt = /id\.gt\.("(?:[^"]|"")*"|[^,)]+)/.exec(expr);
      cursor = {
        updatedAt: new Date(unquotePg(iso && iso[1])).getTime(),
        store: unquotePg(storeEq && storeEq[1]),
        id: unquotePg(idGt && idGt[1]),
        legacy: false,
      };
      return api;
    },
    order: () => api,
    range: (from, to) => {
      calls.ranges.push([from, to]);
      const pageSize = to - from + 1;
      if (calls.failFrom != null && calls.ranges.length > 1 && from === 0 && pageSize === calls.failFrom) {
        return Promise.resolve({ data: null, error: { message: "page failed" } });
      }
      if (calls.failFrom != null && from >= calls.failFrom) {
        return Promise.resolve({ data: null, error: { message: "page failed" } });
      }
      const filtered = rows.filter((row) => rowAfter(row, cursor)).sort((a, b) => {
        const ta = new Date(a.updated_at).getTime();
        const tb = new Date(b.updated_at).getTime();
        if (ta !== tb) return ta - tb;
        if (a.store !== b.store) return a.store < b.store ? -1 : 1;
        if (String(a.id) !== String(b.id)) return String(a.id) < String(b.id) ? -1 : 1;
        return 0;
      });
      return Promise.resolve({ data: filtered.slice(from, to + 1), error: null });
    },
  };
  return api;
}

async function runSync(opts) {
  const dirtyQ = (opts.dirty || []).map((row) => Object.assign({}, row));
  const local = {
    entries: Object.assign({}, (opts.local && opts.local.entries) || {}),
    blobs: Object.assign({}, (opts.local && opts.local.blobs) || {}),
    meta: Object.assign({}, (opts.local && opts.local.meta) || {}),
  };
  const meta = Object.assign({}, opts.meta || {});
  const applied = [];
  const deletes = [];
  const stale = [];
  const store = {
    onChange: () => {},
    getDirty: async () => dirtyQ.slice(),
    getRecord: async (s, id) => (local[s] || {})[id],
    clearDirty: async (keys) => {
      for (let i = dirtyQ.length - 1; i >= 0; i--) if (keys.indexOf(dirtyQ[i].key) >= 0) dirtyQ.splice(i, 1);
    },
    getMeta: async (k) => meta[k],
    setMeta: async (k, v) => { meta[k] = v; },
    getBlob: async (id) => (local.blobs || {})[id],
    getTombstones: async () => (opts.tombstones || []).slice(),
    applyRemote: async (s, rec) => {
      if (!local[s]) local[s] = {};
      const cur = local[s][rec.id];
      if (cur && (cur.updatedAt || 0) >= (rec.updatedAt || 0)) return false;
      local[s][rec.id] = rec;
      applied.push({ store: s, rec: rec });
      return true;
    },
    applyRemoteDelete: async (s, id) => {
      if (local[s]) delete local[s][id];
      deletes.push({ store: s, id: id });
    },
    clearTombstone: async () => {},
    queueStaleCloudDelete: async (s, id, ts) => {
      if ((local[s] || {})[id]) return false;
      const stamped = Math.max(Date.now(), (typeof ts === "number" ? ts : 0) + 1);
      stale.push({ store: s, id: id, updatedAt: stamped });
      dirtyQ.push({ key: s + ":" + id, store: s, id: id, updatedAt: stamped });
      return true;
    },
    isSyncedMetaKey: (k) => k === "student.yearGroup" || (typeof k === "string" && k.indexOf("vocabMastery.") === 0 && k.length > "vocabMastery.".length),
  };
  const calls = { eqs: [], gtes: [], ranges: [], upserts: [], uploads: [], downloads: [], failFrom: opts.failFrom };
  const scripted = opts.downloads || {};
  const sb = {
    auth: {
      onAuthStateChange: () => {},
      getSession: async () => ({ data: { session: { access_token: "tok", user: { id: "user-1", email: "fam@x.com" } } } }),
    },
    from: () => ({
      upsert: async (row) => { calls.upserts.push(row); return { error: null }; },
      select: () => filteredQuery(opts.rows || [], calls),
    }),
    storage: {
      from: () => ({
        upload: async (id, blob, upOpts) => { calls.uploads.push({ id: id, opts: upOpts }); return { error: null }; },
        download: async (id) => {
          calls.downloads.push(id);
          if (Object.prototype.hasOwnProperty.call(scripted, id)) return scripted[id];
          return { data: { type: "image/jpeg", byte: 1 }, error: null };
        },
        remove: async () => ({ error: null }),
      }),
    },
  };
  const win = {
    supabase: { createClient: () => sb },
    EduStore: store,
    EDU_SYNC_CONFIG: { url: "https://ref.supabase.co", anonKey: "anon-key-123" },
    addEventListener: () => {},
  };
  const globals = {
    document: { addEventListener: () => {}, hidden: false },
    location: { origin: "http://localhost", pathname: "/", search: "", hash: "" },
    history: { replaceState: () => {} },
  };
  const EduSync = loadSync(win, globals);
  EduSync.init(win.EDU_SYNC_CONFIG);
  const status = await EduSync.syncNow();
  return { status: status, meta: meta, local: local, applied: applied, deletes: deletes, stale: stale, calls: calls, dirtyQ: dirtyQ, EduSync: EduSync };
}

async function partF() {
  const newerLocal = await runSync({
    dirty: [{ key: "entries:a", store: "entries", id: "a", updatedAt: 300 }],
    local: { entries: { a: { id: "a", updatedAt: 300, note: "local-new" } } },
    rows: [{ store: "entries", id: "a", data: { id: "a", note: "remote-old" }, updated_at: iso(200), deleted: false }],
  });
  check("two devices: the newer local edit is kept", newerLocal.local.entries.a.note === "local-new");
  check("two devices: the newer local edit is pushed", newerLocal.calls.upserts.some((u) => u.id === "a" && u.data.note === "local-new" && u.deleted === false));

  const newerRemote = await runSync({
    dirty: [{ key: "entries:a", store: "entries", id: "a", updatedAt: 100 }],
    local: { entries: { a: { id: "a", updatedAt: 100, note: "local-old" } } },
    rows: [{ store: "entries", id: "a", data: { id: "a", note: "remote-new" }, updated_at: iso(200), deleted: false }],
  });
  check("two devices: the newer cloud edit replaces the local copy", newerRemote.local.entries.a.note === "remote-new");
  check("two devices: a stale local edit is not pushed back", !newerRemote.calls.upserts.some((u) => u.id === "a" && u.data && u.data.note === "local-old"));

  const deletedLocally = await runSync({
    dirty: [{ key: "entries:a", store: "entries", id: "a", updatedAt: 500 }],
    tombstones: [{ store: "entries", id: "a", updatedAt: 500 }],
    rows: [{ store: "entries", id: "a", data: { id: "a", note: "cloud" }, updated_at: iso(200), deleted: false }],
  });
  check("two devices: a newer local delete is not revived", !deletedLocally.local.entries.a && deletedLocally.applied.length === 0);
  check("two devices: the newer local delete is pushed", deletedLocally.calls.upserts.some((u) => u.id === "a" && u.deleted === true));

  const pageSize = newerLocal.EduSync.PULL_PAGE_SIZE;
  const many = [];
  for (let i = 0; i < 250; i++) many.push({ store: "entries", id: "p" + i, data: { id: "p" + i }, updated_at: iso(1000 + i), deleted: false });
  const paged = await runSync({ rows: many });
  check("pull requests bounded pages", paged.calls.ranges.length === 3 && paged.calls.ranges[0][1] - paged.calls.ranges[0][0] + 1 === pageSize);
  check("pull applies every page", paged.applied.length === 250 && paged.meta.lastPulledAt.updatedAt === 1000 + 249 && paged.meta.lastPulledAt.id === "p249" && !paged.status.error);

  const partialRows = [];
  for (let i = 0; i < 150; i++) partialRows.push({ store: "entries", id: "q" + i, data: { id: "q" + i }, updated_at: iso(1000 + i), deleted: false });
  const partial = await runSync({ rows: partialRows, failFrom: pageSize });
  check("a failed later page does not advance the cursor past it", partial.meta.lastPulledAt.updatedAt === 1000 + pageSize - 1 && partial.meta.lastPulledAt.id === "q" + (pageSize - 1) && partial.applied.length === pageSize);
  check("a failed later page is reported", partial.status.error && partial.status.error.indexOf("page failed") !== -1);
  check("rows on the failed page are not applied", !partial.applied.some((a) => a.rec.id === "q" + pageSize));

  const capRows = [];
  const capCount = pageSize * newerLocal.EduSync.PULL_MAX_PAGES + 1;
  for (let i = 0; i < capCount; i++) capRows.push({ store: "entries", id: "c" + i, data: { id: "c" + i }, updated_at: iso(2000 + i), deleted: false });
  const capped = await runSync({ rows: capRows });
  check("a pull that hits the page cap stops and keeps the error", capped.status.error && capped.status.error.indexOf("too large") !== -1);
  check("the page cap still records only the rows it finished", capped.applied.length === pageSize * newerLocal.EduSync.PULL_MAX_PAGES && capped.meta.lastPulledAt.updatedAt === 2000 + capped.applied.length - 1 && capped.meta.lastPulledAt.id === "c" + (capped.applied.length - 1));
  const continued = await runSync({ rows: capRows, meta: { lastPulledAt: capped.meta.lastPulledAt } });
  check("the next pull continues after the cap instead of skipping", continued.applied.some((a) => a.rec.id === "c" + (capCount - 1)) && !continued.status.error);

  const staleBlob = await runSync({
    local: { blobs: { b: { id: "b", updatedAt: 500, type: "image/png" } } },
    rows: [{ store: "blobs", id: "b", data: { type: "image/png" }, updated_at: iso(400), deleted: false }],
  });
  check("an older cloud photo is not downloaded", staleBlob.calls.downloads.length === 0 && staleBlob.meta.lastPulledAt.updatedAt === 400 && staleBlob.meta.lastPulledAt.id === "b");

  const freshBlob = await runSync({
    local: { blobs: { b: { id: "b", updatedAt: 400, type: "image/png" } } },
    rows: [{ store: "blobs", id: "b", data: { type: "image/png", createdAt: 1 }, updated_at: iso(500), deleted: false }],
  });
  check("a newer cloud photo is downloaded and applied", freshBlob.calls.downloads.indexOf("user-1/b") !== -1 && freshBlob.local.blobs.b.updatedAt === 500 && freshBlob.local.blobs.b.blob);

  const transientBlob = await runSync({
    rows: [
      { store: "entries", id: "before", data: { id: "before" }, updated_at: iso(10), deleted: false },
      { store: "blobs", id: "gone", data: { type: "image/jpeg" }, updated_at: iso(20), deleted: false },
      { store: "entries", id: "after", data: { id: "after" }, updated_at: iso(30), deleted: false },
    ],
    downloads: { "user-1/gone": { data: null, error: { message: "timeout", statusCode: 503 } } },
  });
  check("a transient photo does not move the cursor past it", transientBlob.meta.lastPulledAt.updatedAt === 10 && transientBlob.meta.lastPulledAt.id === "before");
  check("a transient photo does not apply later rows", transientBlob.applied.some((a) => a.rec.id === "before") && !transientBlob.applied.some((a) => a.rec.id === "after"));
  check("a transient photo is reported for retry", transientBlob.status.error && transientBlob.status.error.indexOf("could not be downloaded") !== -1);

  const missingBlob = await runSync({
    rows: [
      { store: "entries", id: "before", data: { id: "before" }, updated_at: iso(10), deleted: false },
      { store: "blobs", id: "gone", data: { type: "image/jpeg" }, updated_at: iso(20), deleted: false },
      { store: "entries", id: "after", data: { id: "after" }, updated_at: iso(30), deleted: false },
    ],
    downloads: { "user-1/gone": { data: null, error: { message: "Object not found", statusCode: 404 } } },
  });
  check("a confirmed missing photo advances past that row", missingBlob.meta.lastPulledAt.id === "after" && missingBlob.applied.some((a) => a.rec.id === "after"));
  check("a confirmed missing photo is tombstoned with a newer time", missingBlob.stale.some((s) => s.id === "gone" && s.updatedAt > 20));
  check("a confirmed missing photo is described without blocking", missingBlob.status.warning && missingBlob.status.warning.indexOf("missing") !== -1 && !missingBlob.status.error);

  const sameCount = pageSize * newerLocal.EduSync.PULL_MAX_PAGES + 1;
  const sameTs = iso(9000);
  const same = [];
  for (let i = 0; i < sameCount; i++) {
    const id = "s" + String(i).padStart(5, "0");
    same.push({ store: "entries", id: id, data: { id: id }, updated_at: sameTs, deleted: false });
  }
  const identical = await runSync({ rows: same });
  const identicalLast = "s" + String(pageSize * newerLocal.EduSync.PULL_MAX_PAGES - 1).padStart(5, "0");
  check("identical timestamps still stop at the page cap", identical.status.error && identical.status.error.indexOf("too large") !== -1);
  check("identical timestamps save the last applied key", identical.meta.lastPulledAt.updatedAt === 9000 && identical.meta.lastPulledAt.id === identicalLast);
  const identicalNext = await runSync({ rows: same, meta: { lastPulledAt: identical.meta.lastPulledAt } });
  check("identical timestamps continue on the next sync", identicalNext.applied.some((a) => a.rec.id === "s" + String(sameCount - 1).padStart(5, "0")) && !identicalNext.status.error);

  const legacy = await runSync({
    meta: { lastPulledAt: 1500 },
    rows: [
      { store: "entries", id: "old", data: { id: "old" }, updated_at: iso(1400), deleted: false },
      { store: "entries", id: "edge", data: { id: "edge" }, updated_at: iso(1500), deleted: false },
      { store: "entries", id: "new", data: { id: "new" }, updated_at: iso(1600), deleted: false },
    ],
  });
  check("a numeric cursor still includes that timestamp", !legacy.applied.some((a) => a.rec.id === "old") && legacy.applied.some((a) => a.rec.id === "edge") && legacy.applied.some((a) => a.rec.id === "new"));

  const imported = await runSync({
    meta: { importReconcileAt: 1000 },
    local: { entries: { kept: { id: "kept", updatedAt: 100, note: "restored" }, dropped: { id: "dropped", updatedAt: 100 } } },
    rows: [
      { store: "entries", id: "ghost", data: { id: "ghost", note: "stale" }, updated_at: iso(500), deleted: false },
      { store: "entries", id: "kept", data: {}, updated_at: iso(400), deleted: true },
      { store: "entries", id: "fresh", data: { id: "fresh", note: "after" }, updated_at: iso(1500), deleted: false },
      { store: "entries", id: "dropped", data: {}, updated_at: iso(1800), deleted: true },
    ],
  });
  check("import reconcile does not revive a stale cloud row", !imported.local.entries.ghost && imported.stale.some((s) => s.id === "ghost"));
  check("import reconcile pushes a delete for that stale cloud row", imported.calls.upserts.some((u) => u.id === "ghost" && u.deleted === true));
  check("import reconcile ignores a stale cloud delete", imported.local.entries.kept && imported.local.entries.kept.note === "restored" && !imported.deletes.some((d) => d.id === "kept"));
  check("import reconcile still merges a newer cloud edit and delete", imported.local.entries.fresh.note === "after" && !imported.local.entries.dropped);
  check("import reconcile clears its watermark after a full sync", imported.meta.importReconcileAt === 0);

  const metaPull = await runSync({
    rows: [
      { store: "meta", id: "analyzer.enhancedAi.enabled", data: { value: true }, updated_at: iso(50), deleted: false },
      { store: "meta", id: "activeStudentId", data: { value: "other" }, updated_at: iso(55), deleted: false },
      { store: "meta", id: "vocabMastery.student-1", data: { key: "vocabMastery.student-1", value: { cat: { correct: 3 } } }, updated_at: iso(60), deleted: false },
    ],
  });
  check("pull does not apply consent or the active child", !metaPull.applied.some((a) => a.rec.id === "analyzer.enhancedAi.enabled" || a.rec.id === "activeStudentId"));
  check("pull does apply per-child mastery", metaPull.applied.some((a) => a.rec.id === "vocabMastery.student-1" && a.rec.value.cat.correct === 3));

  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const inventory = fs.readFileSync(path.join(__dirname, "..", "docs", "data-inventory.md"), "utf8");
  check("quota failures reach a recovery message", app.indexOf("isStorageQuotaError") !== -1 && app.indexOf("showStorageQuota") !== -1 && html.indexOf("storage-quota-message") !== -1);
  check("the inventory documents synced mastery and device-only consent", inventory.indexOf("Per-child mastery") !== -1 && inventory.indexOf("Enhanced AI consent") !== -1);
}

function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
}

function stripSqlLiterals(sql) {
  return stripSqlComments(sql).replace(/'(?:''|[^'])*'/g, "''");
}

// Static guards for the Dashboard migration and the read-only verifier.
function partE() {
  const migration = fs.readFileSync(path.join(__dirname, "..", "supabase", "2026-per-account-isolation.sql"), "utf8");
  const verify = fs.readFileSync(path.join(__dirname, "..", "supabase", "verify-account-isolation.sql"), "utf8");
  const migrationCode = stripSqlComments(migration);
  const verifyCode = stripSqlLiterals(verify);
  check("migration has no psql metacommand", migrationCode.indexOf("\\") === -1 && migration.indexOf(":'owner_uid'") === -1);
  check("legacy owner defaults to empty", /legacy_owner_text\s+text\s*:=\s*''/.test(migration));
  check("legacy claim defaults to empty", /legacy_claim_confirmed\s+text\s*:=\s*'';/.test(migration));
  check("legacy claim requires single-family confirmation", migration.indexOf("single-family") !== -1);
  check("migration quarantines unowned rows instead of a blanket owner update", migration.indexOf("records_legacy_unowned") !== -1 && migration.indexOf("where owner is null") !== -1);
  check("migration drops every public.records policy via pg_policies", /pg_policies[\s\S]*tablename = 'records'/.test(migration));
  check("migration drops blob-scoped storage policies", /storage\.objects/.test(migration) && /%blobs%/.test(migration));
  check("migration adds owner,store,id uniqueness", migration.indexOf("unique (owner, store, id)") !== -1 || migration.indexOf("primary key (owner, store, id)") !== -1);
  check("migration adds owner, updated_at index", migration.indexOf("records_owner_updated_at_idx") !== -1 && /on public\.records \(owner, updated_at\)/.test(migration));
  check("isolation rerun keeps the beta helper", migration.indexOf("sync_access_allowed") !== -1 && migration.indexOf("to_regprocedure('public.beta_access_allowed(uuid)')") !== -1 && migration.indexOf("public.sync_access_allowed(auth.uid())") !== -1);
  const verifyStatements = verifyCode.split(";").map((s) => s.trim()).filter(Boolean);
  check("verifier is a single read-only statement", verifyStatements.length === 1 && /^\s*with\b/i.test(verifyStatements[0]));
  check("verifier does not mutate", !/\b(insert|update|delete|drop|alter|create|grant|revoke|truncate)\b/i.test(verifyCode));
}

function memoryStorage(initial) {
  const data = Object.assign({}, initial || {});
  return {
    getItem: (key) => (Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value); },
    removeItem: (key) => { delete data[key]; },
  };
}

async function bootSession(storage) {
  let signedOut = 0;
  const api = { eq: () => api, gte: () => api, or: () => api, order: () => api, range: () => Promise.resolve({ data: [], error: null }) };
  const sb = {
    auth: {
      onAuthStateChange: () => {},
      getSession: async () => ({ data: { session: { access_token: "tok", user: { id: "user-1", email: "fam@x.com" } } } }),
      signOut: async () => { signedOut += 1; },
    },
    from: () => ({ upsert: async () => ({ error: null }), select: () => api }),
    storage: { from: () => ({ upload: async () => ({ error: null }), download: async () => ({ data: null, error: null }), remove: async () => ({ error: null }) }) },
  };
  const win = {
    supabase: { createClient: () => sb },
    localStorage: storage,
    EDU_SYNC_CONFIG: { url: "https://ref.supabase.co", anonKey: "anon-key-123" },
    addEventListener: () => {},
    EduStore: {
      onChange: () => {},
      getDirty: async () => [],
      getRecord: async () => null,
      clearDirty: async () => {},
      getMeta: async () => 0,
      setMeta: async () => {},
      getBlob: async () => null,
      getTombstones: async () => [],
      applyRemote: async () => false,
      applyRemoteDelete: async () => {},
      isSyncedMetaKey: () => false,
    },
  };
  const globals = {
    document: { addEventListener: () => {}, hidden: false },
    location: { origin: "http://localhost", pathname: "/", search: "", hash: "" },
    history: { replaceState: () => {} },
  };
  const EduSync = loadSync(win, globals);
  EduSync.init(win.EDU_SYNC_CONFIG);
  return { EduSync: EduSync, signedOut: () => signedOut, storage: storage };
}

async function partSession() {
  const fresh = await bootSession(memoryStorage({}));
  const freshStatus = await fresh.EduSync.syncNow();
  check("a new session stays signed in", freshStatus.signedIn === true && !freshStatus.error);
  check("a new session records its start", fresh.storage.getItem("edu.session.startedAt"));
  await fresh.EduSync.signOut();
  check("sign out clears the session clock", fresh.storage.getItem("edu.session.startedAt") === null && fresh.signedOut() === 1);

  const absolute = await bootSession(memoryStorage({
    "edu.session.startedAt": String(Date.now() - fresh.EduSync.SESSION_ABSOLUTE_MS - 1000),
    "edu.session.lastActivityAt": String(Date.now()),
  }));
  const absoluteStatus = await absolute.EduSync.syncNow();
  check("a session older than 4 hours signs out", absoluteStatus.signedIn === false && absoluteStatus.error.indexOf("4 hour") !== -1 && absolute.signedOut() === 1);
  check("the absolute lock clears the stored session", absolute.storage.getItem("edu.session.startedAt") === null);

  const idle = await bootSession(memoryStorage({
    "edu.session.startedAt": String(Date.now() - 60 * 60 * 1000),
    "edu.session.lastActivityAt": String(Date.now() - fresh.EduSync.SESSION_IDLE_MS - 1000),
  }));
  const idleStatus = await idle.EduSync.syncNow();
  check("30 minutes idle signs out", idleStatus.signedIn === false && idleStatus.error.indexOf("30 minutes") !== -1 && idle.signedOut() === 1);
}

(async function main() {
  await partA();
  await partB();
  await partC();
  await partD();
  partE();
  await partF();
  await partSession();
  console.log("sync.test.js: " + passed + " assertions passed");
})().catch((e) => { console.error(e); process.exit(1); });

