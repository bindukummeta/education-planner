/*
 * EduStore — a Promise-wrapped IndexedDB abstraction (the storage seam).
 * app.js only ever calls window.EduStore.* so a future cloud-storage.js can
 * implement the same interface without any UI/logic rewrite.
 */
(function () {
  "use strict";

  const DB_NAME = "eduplanner";
  const DB_VERSION = 6;
  const DEFAULT_STUDENT_ID = "student-1";
  const STORES = {
    schools: "schools",
    entries: "entries",
    blobs: "blobs",
    meta: "meta",
    homework: "homework",
    reading: "reading",
    mocks: "mocks",
    events: "events",
    students: "students",
    projects: "projects",
    curiosity: "curiosity",
    analyses: "analyses",
  };

  let dbPromise = null;

  function uid() {
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  // Shown as-is in the UI. A failed write must not delete data that is already stored.
  const STORAGE_QUOTA_CODE = "storage_quota";
  const STORAGE_QUOTA_MESSAGE = "This device is out of space for Education Planner. Export a backup, then remove old worksheet photos you no longer need. Nothing already saved was deleted.";

  function isQuotaExceeded(error) {
    if (!error) return false;
    const name = error.name || "";
    return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED" || error.code === 22;
  }

  function storageQuotaError() {
    const err = new Error(STORAGE_QUOTA_MESSAGE);
    err.name = "EduStorageQuotaError";
    err.code = STORAGE_QUOTA_CODE;
    err.publicMessage = STORAGE_QUOTA_MESSAGE;
    return err;
  }

  function wrapStorageError(error) {
    return isQuotaExceeded(error) ? storageQuotaError() : error;
  }

  function isStorageQuotaError(error) {
    return !!(error && (error.code === STORAGE_QUOTA_CODE || error.name === "EduStorageQuotaError"));
  }

  function reqP(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(wrapStorageError(request.error));
    });
  }

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORES.schools)) {
          const s = db.createObjectStore(STORES.schools, { keyPath: "id" });
          s.createIndex("name", "name", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.entries)) {
          const s = db.createObjectStore(STORES.entries, { keyPath: "id" });
          s.createIndex("subject", "subject", { unique: false });
          s.createIndex("date", "date", { unique: false });
          s.createIndex("subject_date", ["subject", "date"], { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.blobs)) {
          db.createObjectStore(STORES.blobs, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(STORES.meta)) {
          db.createObjectStore(STORES.meta, { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains(STORES.homework)) {
          const s = db.createObjectStore(STORES.homework, { keyPath: "id" });
          s.createIndex("dueDate", "dueDate", { unique: false });
          s.createIndex("done", "done", { unique: false });
          s.createIndex("subject", "subject", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.reading)) {
          const s = db.createObjectStore(STORES.reading, { keyPath: "id" });
          s.createIndex("date", "date", { unique: false });
          s.createIndex("title", "title", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.mocks)) {
          const s = db.createObjectStore(STORES.mocks, { keyPath: "id" });
          s.createIndex("date", "date", { unique: false });
          s.createIndex("subject", "subject", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.events)) {
          const s = db.createObjectStore(STORES.events, { keyPath: "id" });
          s.createIndex("date", "date", { unique: false });
          s.createIndex("type", "type", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.students)) {
          const s = db.createObjectStore(STORES.students, { keyPath: "id" });
          s.createIndex("name", "name", { unique: false });
          // Seed the first student (L) exactly once, on first creation of this store.
          // The contains() guard guarantees this never re-runs, so an existing L
          // profile is never overwritten. DEFAULT_STUDENT_ID keeps the id stable.
          s.put({ id: DEFAULT_STUDENT_ID, name: "L", createdAt: Date.now(), order: 1 });
        }
        if (!db.objectStoreNames.contains(STORES.projects)) {
          const s = db.createObjectStore(STORES.projects, { keyPath: "id" });
          s.createIndex("status", "status", { unique: false });
          s.createIndex("updatedAt", "updatedAt", { unique: false });
          s.createIndex("category", "category", { unique: false });
          s.createIndex("studentId", "studentId", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.curiosity)) {
          const s = db.createObjectStore(STORES.curiosity, { keyPath: "id" });
          s.createIndex("studentId", "studentId", { unique: false });
          s.createIndex("kind", "kind", { unique: false });
          s.createIndex("status", "status", { unique: false });
          s.createIndex("topic", "topic", { unique: false });
          s.createIndex("subject", "subject", { unique: false });
          s.createIndex("author", "author", { unique: false });
          s.createIndex("updatedAt", "updatedAt", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.analyses)) {
          const s = db.createObjectStore(STORES.analyses, { keyPath: "id" });
          s.createIndex("studentId", "studentId", { unique: false });
          s.createIndex("source", "source", { unique: false });
          s.createIndex("subject", "subject", { unique: false });
          s.createIndex("createdAt", "createdAt", { unique: false });
          s.createIndex("linkedId", "linkedId", { unique: false });
        }
        // v6 (sync): a delete log (tombstones) and a push queue (dirty). Both are
        // keyed by "<store>:<id>". Guarded so all existing v5 data is preserved.
        if (!db.objectStoreNames.contains("_tombstones")) db.createObjectStore("_tombstones", { keyPath: "key" });
        if (!db.objectStoreNames.contains("_dirty")) db.createObjectStore("_dirty", { keyPath: "key" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function tx(store, mode) {
    const db = await openDB();
    return db.transaction(store, mode).objectStore(store);
  }

  // ---- sync seam (internal) ----
  // These power the optional cloud sync layer (sync.js). The PUBLIC EduStore
  // surface is unchanged; app.js never needs to touch anything below.
  const listeners = new Set();
  function onChange(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }
  function emitChange(store, id) {
    listeners.forEach((fn) => { try { fn({ store: store, id: id }); } catch (_) {} });
  }
  // Mark a record as needing push (the write queue) and notify listeners.
  async function markDirty(store, id, updatedAt) {
    const s = await tx("_dirty", "readwrite");
    await reqP(s.put({ key: store + ":" + id, store: store, id: id, updatedAt: updatedAt }));
    emitChange(store, id);
  }
  // Record a delete so it can propagate to other devices.
  async function writeTombstone(store, id, updatedAt) {
    const t = await tx("_tombstones", "readwrite");
    await reqP(t.put({ key: store + ":" + id, store: store, id: id, updatedAt: updatedAt }));
  }
  async function getDirty() {
    const s = await tx("_dirty", "readonly");
    return reqP(s.getAll());
  }
  async function clearDirty(keys) {
    if (!keys || !keys.length) return;
    const s = await tx("_dirty", "readwrite");
    for (const k of keys) await reqP(s.delete(k));
  }
  async function getTombstones(since) {
    const s = await tx("_tombstones", "readonly");
    const rows = await reqP(s.getAll());
    return since ? rows.filter((r) => (r.updatedAt || 0) > since) : rows;
  }
  async function getRecord(store, id) {
    const s = await tx(store, "readonly");
    return reqP(s.get(id));
  }
  // LWW upsert from a remote row. NEVER re-marks dirty (this is an inbound merge),
  // and only overwrites when the remote copy is strictly newer.
  async function applyRemote(store, record) {
    if (!record || !record.id) return false;
    const s = await tx(store, "readonly");
    const cur = await reqP(s.get(record.id));
    if (cur && (cur.updatedAt || 0) >= (record.updatedAt || 0)) return false;
    const rw = await tx(store, "readwrite");
    await reqP(rw.put(record));
    emitChange(store, record.id);
    return true;
  }
  // Remote delete: remove the local record without creating a tombstone/dirty.
  async function applyRemoteDelete(store, id) {
    const rw = await tx(store, "readwrite");
    await reqP(rw.delete(id));
    emitChange(store, id);
  }
  async function clearTombstone(store, id) {
    const t = await tx("_tombstones", "readwrite");
    await reqP(t.delete(store + ":" + id));
  }
  // Cloud row is older than an import, or its blob bytes are gone. Record a
  // delete to push later. The timestamp is strictly newer than the remote row
  // and any tombstone already stored, so another device pulls the delete.
  // Never removes a local row.
  async function queueStaleCloudDelete(store, id, remoteUpdatedAt) {
    if (!store || id == null || id === "") return false;
    const cur = await getRecord(store, id);
    if (cur) return false;
    const remote = typeof remoteUpdatedAt === "number" && isFinite(remoteUpdatedAt) ? remoteUpdatedAt : 0;
    let current = 0;
    const existing = await getTombstones(0);
    for (let i = 0; i < existing.length; i++) {
      const row = existing[i];
      if (row && row.store === store && row.id === id && (row.updatedAt || 0) > current) current = row.updatedAt;
    }
    let ts = Math.max(Date.now(), remote + 1, current + 1);
    if (!(ts > remote && ts > current)) ts = Math.max(remote, current) + 1;
    await writeTombstone(store, id, ts);
    await markDirty(store, id, ts);
    return true;
  }

  // ---- schools ----
  async function getSchools() {
    const store = await tx(STORES.schools, "readonly");
    const rows = await reqP(store.getAll());
    return rows.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }
  async function getSchool(id) {
    const store = await tx(STORES.schools, "readonly");
    return reqP(store.get(id));
  }
  async function saveSchool(school) {
    const now = Date.now();
    const record = Object.assign({}, school);
    if (!record.id) {
      record.id = uid();
      record.createdAt = now;
    }
    record.updatedAt = now;
    const store = await tx(STORES.schools, "readwrite");
    await reqP(store.put(record));
    await markDirty(STORES.schools, record.id, record.updatedAt);
    return record;
  }
  async function deleteSchool(id) {
    const now = Date.now();
    const store = await tx(STORES.schools, "readwrite");
    await reqP(store.delete(id));
    await writeTombstone(STORES.schools, id, now);
    await markDirty(STORES.schools, id, now);
  }

  // ---- entries ----
  async function getEntries(filter) {
    filter = filter || {};
    const store = await tx(STORES.entries, "readonly");
    let rows = await reqP(store.getAll());
    // Scope to the active child (records made before profiles existed have no
    // studentId, so treat a missing one as the default student). `*ALL*` opts out.
    if (filter.studentId !== "*ALL*") {
      const sid = filter.studentId || (await getActiveStudentId());
      rows = rows.filter((r) => (r.studentId || DEFAULT_STUDENT_ID) === sid);
    }
    if (filter.subject) rows = rows.filter((r) => r.subject === filter.subject);
    if (filter.from) rows = rows.filter((r) => r.date >= filter.from);
    if (filter.to) rows = rows.filter((r) => r.date <= filter.to);
    return rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }
  async function addEntry(entry) {
    const now = Date.now();
    const record = Object.assign({ id: uid(), studentId: DEFAULT_STUDENT_ID, createdAt: now, updatedAt: now }, entry);
    const store = await tx(STORES.entries, "readwrite");
    await reqP(store.put(record));
    await markDirty(STORES.entries, record.id, record.updatedAt);
    return record;
  }
  async function deleteEntry(id) {
    const now = Date.now();
    const store = await tx(STORES.entries, "readonly");
    const entry = await reqP(store.get(id));
    if (entry && entry.blobId) await deleteBlob(entry.blobId);
    const rw = await tx(STORES.entries, "readwrite");
    await reqP(rw.delete(id));
    await writeTombstone(STORES.entries, id, now);
    await markDirty(STORES.entries, id, now);
  }

  // ---- homework ----
  async function getHomework(filter) {
    filter = filter || {};
    const store = await tx(STORES.homework, "readonly");
    let rows = await reqP(store.getAll());
    if (filter.studentId !== "*ALL*") {
      const sid = filter.studentId || (await getActiveStudentId());
      rows = rows.filter((r) => (r.studentId || DEFAULT_STUDENT_ID) === sid);
    }
    if (filter.subject) rows = rows.filter((r) => r.subject === filter.subject);
    if (typeof filter.done === "number") rows = rows.filter((r) => (r.done ? 1 : 0) === filter.done);
    return rows.sort((a, b) => ((a.dueDate || "") < (b.dueDate || "") ? -1 : (a.dueDate || "") > (b.dueDate || "") ? 1 : 0));
  }
  async function addHomework(rec) {
    const now = Date.now();
    const record = Object.assign({ id: uid(), studentId: DEFAULT_STUDENT_ID, done: 0, doneAt: null, createdAt: now, updatedAt: now }, rec);
    const store = await tx(STORES.homework, "readwrite");
    await reqP(store.put(record));
    await markDirty(STORES.homework, record.id, record.updatedAt);
    return record;
  }
  async function updateHomework(id, patch) {
    const store = await tx(STORES.homework, "readonly");
    const cur = await reqP(store.get(id));
    if (!cur) return null;
    const record = Object.assign({}, cur, patch, { updatedAt: Date.now() });
    const rw = await tx(STORES.homework, "readwrite");
    await reqP(rw.put(record));
    await markDirty(STORES.homework, record.id, record.updatedAt);
    return record;
  }
  async function deleteHomework(id) {
    const now = Date.now();
    const store = await tx(STORES.homework, "readwrite");
    await reqP(store.delete(id));
    await writeTombstone(STORES.homework, id, now);
    await markDirty(STORES.homework, id, now);
  }

  // ---- reading ----
  async function getReading(filter) {
    filter = filter || {};
    const store = await tx(STORES.reading, "readonly");
    let rows = await reqP(store.getAll());
    if (filter.studentId !== "*ALL*") {
      const sid = filter.studentId || (await getActiveStudentId());
      rows = rows.filter((r) => (r.studentId || DEFAULT_STUDENT_ID) === sid);
    }
    if (filter.from) rows = rows.filter((r) => r.date >= filter.from);
    if (filter.to) rows = rows.filter((r) => r.date <= filter.to);
    return rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }
  async function addReading(rec) {
    const now = Date.now();
    const record = Object.assign({ id: uid(), studentId: DEFAULT_STUDENT_ID, createdAt: now, updatedAt: now }, rec);
    const store = await tx(STORES.reading, "readwrite");
    await reqP(store.put(record));
    await markDirty(STORES.reading, record.id, record.updatedAt);
    return record;
  }
  async function updateReading(id, patch) {
    const store = await tx(STORES.reading, "readonly");
    const cur = await reqP(store.get(id));
    if (!cur) return null;
    const record = Object.assign({}, cur, patch, { updatedAt: Date.now() });
    const rw = await tx(STORES.reading, "readwrite");
    await reqP(rw.put(record));
    await markDirty(STORES.reading, record.id, record.updatedAt);
    return record;
  }
  async function deleteReading(id) {
    const now = Date.now();
    const store = await tx(STORES.reading, "readwrite");
    await reqP(store.delete(id));
    await writeTombstone(STORES.reading, id, now);
    await markDirty(STORES.reading, id, now);
  }

  // ---- mocks ----
  async function getMocks(filter) {
    filter = filter || {};
    const store = await tx(STORES.mocks, "readonly");
    let rows = await reqP(store.getAll());
    if (filter.studentId !== "*ALL*") {
      const sid = filter.studentId || (await getActiveStudentId());
      rows = rows.filter((r) => (r.studentId || DEFAULT_STUDENT_ID) === sid);
    }
    if (filter.subject) rows = rows.filter((r) => r.subject === filter.subject);
    if (filter.from) rows = rows.filter((r) => r.date >= filter.from);
    if (filter.to) rows = rows.filter((r) => r.date <= filter.to);
    return rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }
  async function addMocks(rec) {
    const now = Date.now();
    const record = Object.assign({ id: uid(), studentId: DEFAULT_STUDENT_ID, createdAt: now, updatedAt: now }, rec);
    const store = await tx(STORES.mocks, "readwrite");
    await reqP(store.put(record));
    await markDirty(STORES.mocks, record.id, record.updatedAt);
    return record;
  }
  async function updateMocks(id, patch) {
    const store = await tx(STORES.mocks, "readonly");
    const cur = await reqP(store.get(id));
    if (!cur) return null;
    const record = Object.assign({}, cur, patch, { updatedAt: Date.now() });
    const rw = await tx(STORES.mocks, "readwrite");
    await reqP(rw.put(record));
    await markDirty(STORES.mocks, record.id, record.updatedAt);
    return record;
  }
  async function deleteMocks(id) {
    const now = Date.now();
    const store = await tx(STORES.mocks, "readonly");
    const rec = await reqP(store.get(id));
    if (rec && rec.blobId) await deleteBlob(rec.blobId);
    const rw = await tx(STORES.mocks, "readwrite");
    await reqP(rw.delete(id));
    await writeTombstone(STORES.mocks, id, now);
    await markDirty(STORES.mocks, id, now);
  }

  // ---- events (calendar) ----
  async function getEvents(filter) {
    filter = filter || {};
    const store = await tx(STORES.events, "readonly");
    let rows = await reqP(store.getAll());
    if (filter.from) rows = rows.filter((r) => r.date >= filter.from);
    if (filter.to) rows = rows.filter((r) => r.date <= filter.to);
    if (filter.type) rows = rows.filter((r) => r.type === filter.type);
    return rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }
  async function addEvent(rec) {
    const now = Date.now();
    const record = Object.assign({ id: uid(), createdAt: now, updatedAt: now }, rec);
    const store = await tx(STORES.events, "readwrite");
    await reqP(store.put(record));
    await markDirty(STORES.events, record.id, record.updatedAt);
    return record;
  }
  async function updateEvent(id, patch) {
    const store = await tx(STORES.events, "readonly");
    const cur = await reqP(store.get(id));
    if (!cur) return null;
    const record = Object.assign({}, cur, patch, { updatedAt: Date.now() });
    const rw = await tx(STORES.events, "readwrite");
    await reqP(rw.put(record));
    await markDirty(STORES.events, record.id, record.updatedAt);
    return record;
  }
  async function deleteEvent(id) {
    const now = Date.now();
    const store = await tx(STORES.events, "readwrite");
    await reqP(store.delete(id));
    await writeTombstone(STORES.events, id, now);
    await markDirty(STORES.events, id, now);
  }

  // ---- students (multi-student foundation; L = student 1) ----
  async function getStudents() {
    const store = await tx(STORES.students, "readonly");
    const rows = await reqP(store.getAll());
    return rows.sort((a, b) => (a.order || 0) - (b.order || 0));
  }
  async function getActiveStudentId() {
    // Persisted preference; falls back to the seeded default student.
    const v = await getMeta("activeStudentId");
    return v || DEFAULT_STUDENT_ID;
  }
  async function setActiveStudentId(id) { return setMeta("activeStudentId", id); }
  async function addStudent(rec) {
    const now = Date.now();
    const record = Object.assign({ id: uid(), createdAt: now, updatedAt: now, order: now }, rec);
    const store = await tx(STORES.students, "readwrite");
    await reqP(store.put(record));
    await markDirty(STORES.students, record.id, record.updatedAt);
    return record;
  }
  async function updateStudent(id, patch) {
    const store = await tx(STORES.students, "readonly");
    const cur = await reqP(store.get(id));
    if (!cur) return null;
    const record = Object.assign({}, cur, patch, { updatedAt: Date.now() });
    const rw = await tx(STORES.students, "readwrite");
    await reqP(rw.put(record));
    await markDirty(STORES.students, record.id, record.updatedAt);
    return record;
  }
  async function deleteStudent(id) {
    // Never allow removing the last child — the app always needs one active student.
    const all = await getStudents();
    if (all.length <= 1) throw new Error("Can't remove the last child");
    const now = Date.now();
    const store = await tx(STORES.students, "readwrite");
    await reqP(store.delete(id));
    await writeTombstone(STORES.students, id, now);
    await markDirty(STORES.students, id, now);
    // If the removed child was active, fall back to the first remaining child.
    const active = await getActiveStudentId();
    if (active === id) {
      const next = all.find((s) => s.id !== id);
      if (next) await setActiveStudentId(next.id);
    }
  }

  // ---- projects (Play & Create) ----
  async function getProjects(filter) {
    filter = filter || {};
    const store = await tx(STORES.projects, "readonly");
    let rows = await reqP(store.getAll());
    // Scope to the active student by default (records created before studentId
    // existed have none, so treat a missing studentId as the default student).
    const all = filter.studentId === "*ALL*";
    if (!all) {
      const sid = filter.studentId || (await getActiveStudentId());
      rows = rows.filter((r) => (r.studentId || DEFAULT_STUDENT_ID) === sid);
    }
    if (filter.status) rows = rows.filter((r) => r.status === filter.status);
    if (filter.category) rows = rows.filter((r) => r.category === filter.category);
    return rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  async function addProject(rec) {
    const now = Date.now();
    const record = Object.assign(
      { id: uid(), studentId: DEFAULT_STUDENT_ID, createdAt: now, updatedAt: now },
      rec
    );
    const store = await tx(STORES.projects, "readwrite");
    await reqP(store.put(record));
    await markDirty(STORES.projects, record.id, record.updatedAt);
    return record;
  }
  async function updateProject(id, patch) {
    const store = await tx(STORES.projects, "readonly");
    const cur = await reqP(store.get(id));
    if (!cur) return null;
    const record = Object.assign({}, cur, patch, { updatedAt: Date.now() });
    const rw = await tx(STORES.projects, "readwrite");
    await reqP(rw.put(record));
    await markDirty(STORES.projects, record.id, record.updatedAt);
    return record;
  }
  async function deleteProject(id) {
    const now = Date.now();
    const store = await tx(STORES.projects, "readwrite");
    await reqP(store.delete(id));
    await writeTombstone(STORES.projects, id, now);
    await markDirty(STORES.projects, id, now);
  }

  // ---- curiosity (capture + connect; local patterns computed in app.js) ----
  async function getCuriosity(filter) {
    filter = filter || {};
    const store = await tx(STORES.curiosity, "readonly");
    let rows = await reqP(store.getAll());
    const all = filter.studentId === "*ALL*";
    if (!all) {
      const sid = filter.studentId || (await getActiveStudentId());
      rows = rows.filter((r) => (r.studentId || DEFAULT_STUDENT_ID) === sid);
    }
    if (filter.kind) rows = rows.filter((r) => r.kind === filter.kind);
    if (filter.status) rows = rows.filter((r) => r.status === filter.status);
    if (filter.topic) rows = rows.filter((r) => r.topic === filter.topic);
    if (filter.subject) rows = rows.filter((r) => r.subject === filter.subject);
    if (filter.author) rows = rows.filter((r) => (r.author || "child") === filter.author);
    return rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  async function addCuriosity(rec) {
    const now = Date.now();
    const record = Object.assign(
      { id: uid(), studentId: DEFAULT_STUDENT_ID, createdAt: now, updatedAt: now },
      rec
    );
    const store = await tx(STORES.curiosity, "readwrite");
    await reqP(store.put(record));
    await markDirty(STORES.curiosity, record.id, record.updatedAt);
    return record;
  }
  async function updateCuriosity(id, patch) {
    const store = await tx(STORES.curiosity, "readonly");
    const cur = await reqP(store.get(id));
    if (!cur) return null;
    const record = Object.assign({}, cur, patch, { updatedAt: Date.now() });
    const rw = await tx(STORES.curiosity, "readwrite");
    await reqP(rw.put(record));
    await markDirty(STORES.curiosity, record.id, record.updatedAt);
    return record;
  }
  async function deleteCuriosity(id) {
    const now = Date.now();
    const store = await tx(STORES.curiosity, "readwrite");
    await reqP(store.delete(id));
    await writeTombstone(STORES.curiosity, id, now);
    await markDirty(STORES.curiosity, id, now);
  }

  // ---- analyses (Homework Analyzer; persists a WorksheetAnalysis per capture) ----
  async function getAnalyses(filter) {
    filter = filter || {};
    const store = await tx(STORES.analyses, "readonly");
    let rows = await reqP(store.getAll());
    const all = filter.studentId === "*ALL*";
    if (!all) {
      const sid = filter.studentId || (await getActiveStudentId());
      rows = rows.filter((r) => (r.studentId || DEFAULT_STUDENT_ID) === sid);
    }
    if (filter.source) rows = rows.filter((r) => r.source === filter.source);
    if (filter.schoolId) rows = rows.filter((r) => r.schoolId === filter.schoolId);
    if (filter.subject) rows = rows.filter((r) => (r.overall && r.overall.subject) === filter.subject);
    return rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }
  async function addAnalysis(rec) {
    const now = Date.now();
    const record = Object.assign(
      { id: uid(), studentId: DEFAULT_STUDENT_ID, createdAt: now, updatedAt: now },
      rec
    );
    const store = await tx(STORES.analyses, "readwrite");
    await reqP(store.put(record));
    await markDirty(STORES.analyses, record.id, record.updatedAt);
    return record;
  }
  async function updateAnalysis(id, patch) {
    const store = await tx(STORES.analyses, "readonly");
    const cur = await reqP(store.get(id));
    if (!cur) return null;
    const record = Object.assign({}, cur, patch, { updatedAt: Date.now() });
    const rw = await tx(STORES.analyses, "readwrite");
    await reqP(rw.put(record));
    await markDirty(STORES.analyses, record.id, record.updatedAt);
    return record;
  }
  async function deleteAnalysis(id) {
    const now = Date.now();
    const store = await tx(STORES.analyses, "readonly");
    const rec = await reqP(store.get(id));
    // Clean up every page photo: the new blobIds[] list plus the legacy single
    // blobId, de-duplicated so a shared pointer is only deleted once.
    if (rec) {
      const ids = [];
      if (Array.isArray(rec.blobIds)) rec.blobIds.forEach((b) => { if (b) ids.push(b); });
      if (rec.blobId && ids.indexOf(rec.blobId) === -1) ids.push(rec.blobId);
      for (const b of ids) await deleteBlob(b);
    }
    const rw = await tx(STORES.analyses, "readwrite");
    await reqP(rw.delete(id));
    await writeTombstone(STORES.analyses, id, now);
    await markDirty(STORES.analyses, id, now);
  }

  // ---- blobs ----
  async function putBlob(blob, type) {
    const now = Date.now();
    const record = { id: uid(), blob: blob, type: type || "image/jpeg", createdAt: now, updatedAt: now };
    const store = await tx(STORES.blobs, "readwrite");
    await reqP(store.put(record));
    await markDirty(STORES.blobs, record.id, record.updatedAt);
    return record.id;
  }
  async function getBlob(id) {
    if (!id) return null;
    const store = await tx(STORES.blobs, "readonly");
    return reqP(store.get(id));
  }
  async function deleteBlob(id) {
    const now = Date.now();
    const store = await tx(STORES.blobs, "readwrite");
    await reqP(store.delete(id));
    await writeTombstone(STORES.blobs, id, now);
    await markDirty(STORES.blobs, id, now);
  }

  // ---- meta classification ----
  // Backup format version matches the IndexedDB schema version (DB_VERSION).
  //
  // Synced and included in Export backup (promised per-child progress):
  //   student.yearGroup
  //   vocabMastery.<studentId>  ninjaMastery.<studentId>
  //   spellMastery.<studentId>  practiceMastery.<studentId>
  //
  // Device-only / internal. Not synced, not written into a backup, and kept
  // on this device across import:
  //   activeStudentId — which child this device has open
  //   analyzer.enhancedAi.enabled — Enhanced AI consent (stays on the device)
  //   coach.audience — parent or child coach view on this device
  //   geo.<lookup> — geocode cache
  //   seedIntroducedNames — preset-school watermark
  //   lastPulledAt — sync cursor
  //   importReconcileAt — watermark used once after import
  //   any other key (unknown keys stay device-only until they are classified)
  // Family Sync sign-in (auth) is the Supabase session, not a meta row.
  //
  // Import cloud reconciliation (see importAll / sync.js pullRemote):
  //   Import replaces local records. It clears _dirty and _tombstones, then
  //   rebuilds _dirty only from the restored rows so a pre-import delete cannot
  //   be pushed. lastPulledAt is reset to 0. importReconcileAt is the backup's
  //   exportedAt (or the import time when an older file has none). The next
  //   sync pulls the full account before it pushes. A cloud row at or before
  //   that watermark which is not in the backup is tombstoned and pushed as a
  //   delete — it is not copied back onto the device. A cloud delete at or
  //   before the watermark does not remove restored rows. A cloud change after
  //   the watermark merges by updatedAt (last write wins).
  const BACKUP_VERSION = DB_VERSION;
  const BACKUP_LIMITS = {
    recordsPerStore: 5000,
    blobs: 400,
    blobChars: 8000000,
    metaEntries: 400,
    metaValueChars: 100000,
    idChars: 128,
  };
  const BACKUP_STORES = ["schools", "entries", "homework", "reading", "mocks", "events", "students", "projects", "curiosity", "analyses"];
  const SYNCED_META_EXACT = { "student.yearGroup": true };
  const SYNCED_META_PREFIXES = ["vocabMastery.", "ninjaMastery.", "spellMastery.", "practiceMastery."];
  const DEVICE_META_EXACT = {
    activeStudentId: true,
    lastPulledAt: true,
    "analyzer.enhancedAi.enabled": true,
    "coach.audience": true,
    seedIntroducedNames: true,
    importReconcileAt: true,
  };
  const DEVICE_META_PREFIXES = ["geo."];

  function isSyncedMetaKey(key) {
    if (typeof key !== "string" || !key) return false;
    if (SYNCED_META_EXACT[key]) return true;
    for (let i = 0; i < SYNCED_META_PREFIXES.length; i++) {
      const prefix = SYNCED_META_PREFIXES[i];
      if (key.indexOf(prefix) === 0 && key.length > prefix.length) return true;
    }
    return false;
  }
  function isKnownDeviceMetaKey(key) {
    if (typeof key !== "string" || !key) return false;
    if (DEVICE_META_EXACT[key]) return true;
    for (let i = 0; i < DEVICE_META_PREFIXES.length; i++) {
      const prefix = DEVICE_META_PREFIXES[i];
      if (key.indexOf(prefix) === 0 && key.length > prefix.length) return true;
    }
    return false;
  }
  // Unknown keys are device-only so a new setting cannot leak into sync or a backup.
  function isDeviceMetaKey(key) {
    return !!key && !isSyncedMetaKey(key);
  }

  async function getMeta(key) {
    const store = await tx(STORES.meta, "readonly");
    const row = await reqP(store.get(key));
    return row ? row.value : undefined;
  }
  async function listMeta() {
    const store = await tx(STORES.meta, "readonly");
    return reqP(store.getAll());
  }
  async function setMeta(key, value) {
    if (typeof key !== "string" || !key) throw new Error("Invalid meta key");
    const row = { key: key, value: value };
    if (isSyncedMetaKey(key)) {
      row.id = key;
      row.updatedAt = Date.now();
    }
    const store = await tx(STORES.meta, "readwrite");
    await reqP(store.put(row));
    if (isSyncedMetaKey(key)) await markDirty(STORES.meta, key, row.updatedAt);
  }

  // ---- backup ----
  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }
  function dataURLToBlob(dataURL) {
    const parts = String(dataURL).split(",");
    const head = parts[0] || "";
    const body = parts[1];
    if (!body) throw new Error("Invalid backup file");
    const mime = (head.match(/:(.*?);/) || [])[1] || "image/jpeg";
    const bin = atob(body);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  function invalidBackup() {
    const err = new Error("Invalid backup file");
    err.code = "invalid_backup";
    return err;
  }
  function backupTooLarge() {
    const err = new Error("Backup is too large");
    err.code = "backup_too_large";
    return err;
  }
  function assertId(id) {
    if (typeof id !== "string" || !id || id.length > BACKUP_LIMITS.idChars) throw invalidBackup();
  }
  function assertRecordList(list, present) {
    if (!present) return;
    if (!Array.isArray(list)) throw invalidBackup();
    if (list.length > BACKUP_LIMITS.recordsPerStore) throw backupTooLarge();
    for (let i = 0; i < list.length; i++) {
      const row = list[i];
      if (!row || typeof row !== "object" || Array.isArray(row)) throw invalidBackup();
      assertId(row.id);
    }
  }
  function assertBackup(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw invalidBackup();
    const allowed = {
      version: true, exportedAt: true, blobs: true, meta: true,
    };
    BACKUP_STORES.forEach((name) => { allowed[name] = true; });
    const keys = Object.keys(payload);
    for (let i = 0; i < keys.length; i++) {
      if (!allowed[keys[i]]) throw invalidBackup();
    }
    if (typeof payload.version !== "number" || !isFinite(payload.version) ||
        Math.floor(payload.version) !== payload.version || payload.version < 1 ||
        payload.version > BACKUP_VERSION) {
      throw invalidBackup();
    }
    if (payload.exportedAt != null && (typeof payload.exportedAt !== "number" || !isFinite(payload.exportedAt) || payload.exportedAt < 0)) {
      throw invalidBackup();
    }
    for (let i = 0; i < BACKUP_STORES.length; i++) {
      const name = BACKUP_STORES[i];
      assertRecordList(payload[name], Object.prototype.hasOwnProperty.call(payload, name) && payload[name] != null);
    }
    if (payload.blobs != null) {
      if (!Array.isArray(payload.blobs)) throw invalidBackup();
      if (payload.blobs.length > BACKUP_LIMITS.blobs) throw backupTooLarge();
      for (let i = 0; i < payload.blobs.length; i++) {
        const blob = payload.blobs[i];
        if (!blob || typeof blob !== "object") throw invalidBackup();
        assertId(blob.id);
        if (typeof blob.dataURL !== "string" || blob.dataURL.indexOf("data:") !== 0) throw invalidBackup();
        if (blob.dataURL.length > BACKUP_LIMITS.blobChars) throw backupTooLarge();
        if (blob.createdAt != null && typeof blob.createdAt !== "number") throw invalidBackup();
        if (blob.updatedAt != null && typeof blob.updatedAt !== "number") throw invalidBackup();
      }
    }
    if (payload.meta != null) {
      if (!Array.isArray(payload.meta)) throw invalidBackup();
      if (payload.meta.length > BACKUP_LIMITS.metaEntries) throw backupTooLarge();
      const seen = {};
      for (let i = 0; i < payload.meta.length; i++) {
        const row = payload.meta[i];
        if (!row || typeof row !== "object") throw invalidBackup();
        if (typeof row.key !== "string" || !isSyncedMetaKey(row.key) || seen[row.key]) throw invalidBackup();
        seen[row.key] = true;
        if (row.updatedAt != null && (typeof row.updatedAt !== "number" || !isFinite(row.updatedAt))) throw invalidBackup();
        let encoded;
        try { encoded = JSON.stringify(row.value); } catch (_) { throw invalidBackup(); }
        if (typeof encoded !== "string") throw invalidBackup();
        if (encoded.length > BACKUP_LIMITS.metaValueChars) throw backupTooLarge();
      }
    }
  }
  function decodeBackupBlobs(list) {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const blob = list[i];
      let bytes;
      try { bytes = dataURLToBlob(blob.dataURL); } catch (_) { throw invalidBackup(); }
      const createdAt = typeof blob.createdAt === "number" ? blob.createdAt : 0;
      out.push({
        id: blob.id,
        blob: bytes,
        type: typeof blob.type === "string" && blob.type ? blob.type : (bytes.type || "image/jpeg"),
        createdAt: createdAt,
        updatedAt: typeof blob.updatedAt === "number" ? blob.updatedAt : createdAt,
      });
    }
    return out;
  }

  async function exportAll() {
    const schools = await getSchools();
    const entries = await getEntries({ studentId: "*ALL*" });
    const homework = await getHomework({ studentId: "*ALL*" });
    const reading = await getReading({ studentId: "*ALL*" });
    const mocks = await getMocks({ studentId: "*ALL*" });
    const events = await getEvents();
    const students = await getStudents();
    const projects = await getProjects({ studentId: "*ALL*" });
    const curiosity = await getCuriosity({ studentId: "*ALL*" });
    const analyses = await getAnalyses({ studentId: "*ALL*" });
    const blobStore = await tx(STORES.blobs, "readonly");
    const rawBlobs = await reqP(blobStore.getAll());
    const blobs = [];
    for (const b of rawBlobs) {
      blobs.push({
        id: b.id,
        type: b.type,
        createdAt: b.createdAt,
        updatedAt: b.updatedAt,
        dataURL: await blobToDataURL(b.blob),
      });
    }
    const metaRows = await listMeta();
    const meta = [];
    for (let i = 0; i < metaRows.length; i++) {
      const row = metaRows[i];
      if (!row || !isSyncedMetaKey(row.key)) continue;
      meta.push({ key: row.key, value: row.value, updatedAt: row.updatedAt });
    }
    return {
      version: BACKUP_VERSION,
      exportedAt: Date.now(),
      schools, entries, homework, reading, mocks, events, students, projects, curiosity, analyses, blobs, meta,
    };
  }

  async function importAll(payload) {
    // Validate and decode before any delete. A bad file leaves the device as it was.
    // Writes share one transaction, so a quota error aborts the replace and keeps
    // the previous data.
    assertBackup(payload);
    const decodedBlobs = decodeBackupBlobs(payload.blobs || []);
    const hasMeta = Object.prototype.hasOwnProperty.call(payload, "meta") && payload.meta != null;
    const reconcileAt = (typeof payload.exportedAt === "number" && payload.exportedAt > 0) ? payload.exportedAt : Date.now();
    const previousMeta = await listMeta();
    const incomingStudents = payload.students || [];
    const students = incomingStudents.length
      ? incomingStudents
      : [{ id: DEFAULT_STUDENT_ID, name: "L", createdAt: reconcileAt, order: 1 }];
    const studentIds = {};
    students.forEach((student) => { studentIds[student.id] = true; });

    const db = await openDB();
    const names = BACKUP_STORES.concat([STORES.blobs, STORES.meta, "_dirty", "_tombstones"]);
    const transaction = db.transaction(names, "readwrite");
    const pending = [];
    function os(name) { return transaction.objectStore(name); }
    function putRecord(storeName, record) {
      const updatedAt = typeof record.updatedAt === "number" ? record.updatedAt : reconcileAt;
      const stored = record.updatedAt === updatedAt ? record : Object.assign({}, record, { updatedAt: updatedAt });
      pending.push(reqP(os(storeName).put(stored)));
      pending.push(reqP(os("_dirty").put({
        key: storeName + ":" + stored.id,
        store: storeName,
        id: stored.id,
        updatedAt: updatedAt,
      })));
    }
    function putMetaRow(row, dirty) {
      pending.push(reqP(os(STORES.meta).put(row)));
      if (!dirty) return;
      pending.push(reqP(os("_dirty").put({
        key: "meta:" + row.key,
        store: "meta",
        id: row.key,
        updatedAt: row.updatedAt || reconcileAt,
      })));
    }

    names.forEach((name) => { pending.push(reqP(os(name).clear())); });
    BACKUP_STORES.forEach((name) => {
      const rows = name === "students" ? students : (payload[name] || []);
      for (let i = 0; i < rows.length; i++) putRecord(name, rows[i]);
    });
    for (let i = 0; i < decodedBlobs.length; i++) putRecord(STORES.blobs, decodedBlobs[i]);

    for (let i = 0; i < previousMeta.length; i++) {
      const row = previousMeta[i];
      if (!row || row.key === "lastPulledAt" || row.key === "importReconcileAt") continue;
      const keepDevice = isDeviceMetaKey(row.key) && !isSyncedMetaKey(row.key);
      const keepLegacySynced = !hasMeta && isSyncedMetaKey(row.key);
      if (!keepDevice && !keepLegacySynced) continue;
      if (row.key === "activeStudentId" && !studentIds[row.value]) continue;
      putMetaRow(keepLegacySynced ? row : { key: row.key, value: row.value }, keepLegacySynced);
    }
    if (hasMeta) {
      for (let i = 0; i < payload.meta.length; i++) {
        const row = payload.meta[i];
        const updatedAt = typeof row.updatedAt === "number" ? row.updatedAt : reconcileAt;
        putMetaRow({ key: row.key, value: row.value, id: row.key, updatedAt: updatedAt }, true);
      }
    }
    putMetaRow({ key: "lastPulledAt", value: 0 }, false);
    putMetaRow({ key: "importReconcileAt", value: reconcileAt }, false);
    await Promise.all(pending);
    emitChange("meta", "import");
    return true;
  }

  async function ready() {
    await openDB();
    return true;
  }

  window.EduStore = {
    ready,
    getSchools, getSchool, saveSchool, deleteSchool,
    getEntries, addEntry, deleteEntry,
    getHomework, addHomework, updateHomework, deleteHomework,
    getReading, addReading, updateReading, deleteReading,
    getMocks, addMocks, updateMocks, deleteMocks,
    getEvents, addEvent, updateEvent, deleteEvent,
    getStudents, getActiveStudentId, setActiveStudentId, addStudent, updateStudent, deleteStudent,
    getProjects, addProject, updateProject, deleteProject,
    getCuriosity, addCuriosity, updateCuriosity, deleteCuriosity,
    getAnalyses, addAnalysis, updateAnalysis, deleteAnalysis,
    getBlob, putBlob, deleteBlob,
    getMeta, setMeta,
    exportAll, importAll,
    BACKUP_VERSION, BACKUP_LIMITS, STORAGE_QUOTA_MESSAGE,
    isSyncedMetaKey, isKnownDeviceMetaKey, isDeviceMetaKey, isStorageQuotaError,
    // Internal sync surface (used by sync.js only; not part of the app API).
    onChange, getDirty, clearDirty, getTombstones, getRecord,
    applyRemote, applyRemoteDelete, clearTombstone, queueStaleCloudDelete,
  };
})();
