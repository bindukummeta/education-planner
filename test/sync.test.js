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
      put: (rec) => req(() => { map.set(rec[kp], rec); return rec[kp]; }),
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

function loadStorage() {
  const src = fs.readFileSync(path.join(__dirname, "..", "storage.js"), "utf8");
  const sandbox = { window: {}, indexedDB: makeIDB(), Date, Math, Promise, console };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "storage.js" });
  return sandbox.window.EduStore;
}

async function partA() {
  const S = loadStorage();
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

  // applyRemoteDelete removes locally without recording dirty.
  const e2 = await S.addEntry({ subject: "vr", date: "2026-02-02" });
  await S.clearDirty((await S.getDirty()).map((d) => d.key));
  await S.applyRemoteDelete("entries", e2.id);
  check("applyRemoteDelete removes the record", (await S.getRecord("entries", e2.id)) === undefined);
  check("applyRemoteDelete records nothing dirty", (await S.getDirty()).length === 0);
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
      select: () => ({ eq: (col, val) => { sbCallsEq.push({ col: col, val: val }); return { gte: () => ({ order: async () => ({ data: remoteRows, error: null }) }) }; } }),
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
  check("pull advances lastPulledAt to the max updated_at", meta.lastPulledAt === T + 40);
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
  const verifyStatements = verifyCode.split(";").map((s) => s.trim()).filter(Boolean);
  check("verifier is a single read-only statement", verifyStatements.length === 1 && /^\s*with\b/i.test(verifyStatements[0]));
  check("verifier does not mutate", !/\b(insert|update|delete|drop|alter|create|grant|revoke|truncate)\b/i.test(verifyCode));
}

(async function main() {
  await partA();
  await partB();
  await partC();
  await partD();
  partE();
  console.log("sync.test.js: " + passed + " assertions passed");
})().catch((e) => { console.error(e); process.exit(1); });

