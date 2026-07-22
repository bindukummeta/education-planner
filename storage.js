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

  function reqP(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
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
    if (filter.subject) rows = rows.filter((r) => r.subject === filter.subject);
    if (filter.from) rows = rows.filter((r) => r.date >= filter.from);
    if (filter.to) rows = rows.filter((r) => r.date <= filter.to);
    return rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }
  async function addEntry(entry) {
    const now = Date.now();
    const record = Object.assign({ id: uid(), createdAt: now, updatedAt: now }, entry);
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
    if (filter.subject) rows = rows.filter((r) => r.subject === filter.subject);
    if (typeof filter.done === "number") rows = rows.filter((r) => (r.done ? 1 : 0) === filter.done);
    return rows.sort((a, b) => ((a.dueDate || "") < (b.dueDate || "") ? -1 : (a.dueDate || "") > (b.dueDate || "") ? 1 : 0));
  }
  async function addHomework(rec) {
    const now = Date.now();
    const record = Object.assign({ id: uid(), done: 0, doneAt: null, createdAt: now, updatedAt: now }, rec);
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
    if (filter.from) rows = rows.filter((r) => r.date >= filter.from);
    if (filter.to) rows = rows.filter((r) => r.date <= filter.to);
    return rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }
  async function addReading(rec) {
    const now = Date.now();
    const record = Object.assign({ id: uid(), createdAt: now, updatedAt: now }, rec);
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
    if (filter.subject) rows = rows.filter((r) => r.subject === filter.subject);
    if (filter.from) rows = rows.filter((r) => r.date >= filter.from);
    if (filter.to) rows = rows.filter((r) => r.date <= filter.to);
    return rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }
  async function addMocks(rec) {
    const now = Date.now();
    const record = Object.assign({ id: uid(), createdAt: now, updatedAt: now }, rec);
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

  // ---- meta ----
  async function getMeta(key) {
    const store = await tx(STORES.meta, "readonly");
    const row = await reqP(store.get(key));
    return row ? row.value : undefined;
  }
  async function setMeta(key, value) {
    const store = await tx(STORES.meta, "readwrite");
    return reqP(store.put({ key: key, value: value }));
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
    const [head, body] = dataURL.split(",");
    const mime = (head.match(/:(.*?);/) || [])[1] || "image/jpeg";
    const bin = atob(body);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  async function exportAll() {
    const schools = await getSchools();
    const entries = await getEntries();
    const homework = await getHomework();
    const reading = await getReading();
    const mocks = await getMocks();
    const events = await getEvents();
    const students = await getStudents();
    const projects = await getProjects({ studentId: "*ALL*" });
    const curiosity = await getCuriosity({ studentId: "*ALL*" });
    const analyses = await getAnalyses({ studentId: "*ALL*" });
    const blobStore = await tx(STORES.blobs, "readonly");
    const rawBlobs = await reqP(blobStore.getAll());
    const blobs = [];
    for (const b of rawBlobs) {
      blobs.push({ id: b.id, type: b.type, createdAt: b.createdAt, dataURL: await blobToDataURL(b.blob) });
    }
    return { version: 5, exportedAt: Date.now(), schools, entries, homework, reading, mocks, events, students, projects, curiosity, analyses, blobs };
  }

  async function clearStore(name) {
    const store = await tx(name, "readwrite");
    return reqP(store.clear());
  }

  async function importAll(payload) {
    if (!payload || !payload.version) throw new Error("Invalid backup file");
    await clearStore(STORES.schools);
    await clearStore(STORES.entries);
    await clearStore(STORES.blobs);
    await clearStore(STORES.homework);
    await clearStore(STORES.reading);
    await clearStore(STORES.mocks);
    await clearStore(STORES.events);
    await clearStore(STORES.students);
    await clearStore(STORES.projects);
    await clearStore(STORES.curiosity);
    await clearStore(STORES.analyses);
    for (const s of payload.schools || []) {
      const store = await tx(STORES.schools, "readwrite");
      await reqP(store.put(s));
    }
    for (const e of payload.entries || []) {
      const store = await tx(STORES.entries, "readwrite");
      await reqP(store.put(e));
    }
    for (const h of payload.homework || []) {
      const store = await tx(STORES.homework, "readwrite");
      await reqP(store.put(h));
    }
    for (const r of payload.reading || []) {
      const store = await tx(STORES.reading, "readwrite");
      await reqP(store.put(r));
    }
    for (const m of payload.mocks || []) {
      const store = await tx(STORES.mocks, "readwrite");
      await reqP(store.put(m));
    }
    for (const ev of payload.events || []) {
      const store = await tx(STORES.events, "readwrite");
      await reqP(store.put(ev));
    }
    // Import students first so projects' studentId references resolve.
    for (const st of payload.students || []) {
      const store = await tx(STORES.students, "readwrite");
      await reqP(store.put(st));
    }
    for (const p of payload.projects || []) {
      const store = await tx(STORES.projects, "readwrite");
      await reqP(store.put(p));
    }
    // The `|| []` keeps v1–v3 backups (no curiosity key) importing cleanly.
    for (const c of payload.curiosity || []) {
      const store = await tx(STORES.curiosity, "readwrite");
      await reqP(store.put(c));
    }
    // The `|| []` keeps v1–v4 backups (no analyses key) importing cleanly.
    for (const a of payload.analyses || []) {
      const store = await tx(STORES.analyses, "readwrite");
      await reqP(store.put(a));
    }
    // Post-import safety: re-seed the default student if the backup carried none
    // (e.g. a v1/v2 backup), so the app always has an active student.
    const stu = await getStudents();
    if (!stu.length) {
      const store = await tx(STORES.students, "readwrite");
      await reqP(store.put({ id: DEFAULT_STUDENT_ID, name: "L", createdAt: Date.now(), order: 1 }));
    }
    for (const b of payload.blobs || []) {
      const store = await tx(STORES.blobs, "readwrite");
      await reqP(store.put({ id: b.id, blob: dataURLToBlob(b.dataURL), type: b.type, createdAt: b.createdAt }));
    }
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
    getStudents, getActiveStudentId, setActiveStudentId, addStudent,
    getProjects, addProject, updateProject, deleteProject,
    getCuriosity, addCuriosity, updateCuriosity, deleteCuriosity,
    getAnalyses, addAnalysis, updateAnalysis, deleteAnalysis,
    getBlob, putBlob, deleteBlob,
    getMeta, setMeta,
    exportAll, importAll,
    // Internal sync surface (used by sync.js only; not part of the app API).
    onChange, getDirty, clearDirty, getTombstones, getRecord,
    applyRemote, applyRemoteDelete,
  };
})();
