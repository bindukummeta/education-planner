/*
 * EduStore — a Promise-wrapped IndexedDB abstraction (the storage seam).
 * app.js only ever calls window.EduStore.* so a future cloud-storage.js can
 * implement the same interface without any UI/logic rewrite.
 */
(function () {
  "use strict";

  const DB_NAME = "eduplanner";
  const DB_VERSION = 2;
  const STORES = {
    schools: "schools",
    entries: "entries",
    blobs: "blobs",
    meta: "meta",
    homework: "homework",
    reading: "reading",
    mocks: "mocks",
    events: "events",
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
    return record;
  }
  async function deleteSchool(id) {
    const store = await tx(STORES.schools, "readwrite");
    return reqP(store.delete(id));
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
    const record = Object.assign({ id: uid(), createdAt: Date.now() }, entry);
    const store = await tx(STORES.entries, "readwrite");
    await reqP(store.put(record));
    return record;
  }
  async function deleteEntry(id) {
    const store = await tx(STORES.entries, "readonly");
    const entry = await reqP(store.get(id));
    if (entry && entry.blobId) await deleteBlob(entry.blobId);
    const rw = await tx(STORES.entries, "readwrite");
    return reqP(rw.delete(id));
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
    return record;
  }
  async function updateHomework(id, patch) {
    const store = await tx(STORES.homework, "readonly");
    const cur = await reqP(store.get(id));
    if (!cur) return null;
    const record = Object.assign({}, cur, patch, { updatedAt: Date.now() });
    const rw = await tx(STORES.homework, "readwrite");
    await reqP(rw.put(record));
    return record;
  }
  async function deleteHomework(id) {
    const store = await tx(STORES.homework, "readwrite");
    return reqP(store.delete(id));
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
    const record = Object.assign({ id: uid(), createdAt: Date.now() }, rec);
    const store = await tx(STORES.reading, "readwrite");
    await reqP(store.put(record));
    return record;
  }
  async function updateReading(id, patch) {
    const store = await tx(STORES.reading, "readonly");
    const cur = await reqP(store.get(id));
    if (!cur) return null;
    const record = Object.assign({}, cur, patch);
    const rw = await tx(STORES.reading, "readwrite");
    await reqP(rw.put(record));
    return record;
  }
  async function deleteReading(id) {
    const store = await tx(STORES.reading, "readwrite");
    return reqP(store.delete(id));
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
    const record = Object.assign({ id: uid(), createdAt: Date.now() }, rec);
    const store = await tx(STORES.mocks, "readwrite");
    await reqP(store.put(record));
    return record;
  }
  async function updateMocks(id, patch) {
    const store = await tx(STORES.mocks, "readonly");
    const cur = await reqP(store.get(id));
    if (!cur) return null;
    const record = Object.assign({}, cur, patch);
    const rw = await tx(STORES.mocks, "readwrite");
    await reqP(rw.put(record));
    return record;
  }
  async function deleteMocks(id) {
    const store = await tx(STORES.mocks, "readonly");
    const rec = await reqP(store.get(id));
    if (rec && rec.blobId) await deleteBlob(rec.blobId);
    const rw = await tx(STORES.mocks, "readwrite");
    return reqP(rw.delete(id));
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
    const record = Object.assign({ id: uid(), createdAt: Date.now() }, rec);
    const store = await tx(STORES.events, "readwrite");
    await reqP(store.put(record));
    return record;
  }
  async function updateEvent(id, patch) {
    const store = await tx(STORES.events, "readonly");
    const cur = await reqP(store.get(id));
    if (!cur) return null;
    const record = Object.assign({}, cur, patch);
    const rw = await tx(STORES.events, "readwrite");
    await reqP(rw.put(record));
    return record;
  }
  async function deleteEvent(id) {
    const store = await tx(STORES.events, "readwrite");
    return reqP(store.delete(id));
  }

  // ---- blobs ----
  async function putBlob(blob, type) {
    const record = { id: uid(), blob: blob, type: type || "image/jpeg", createdAt: Date.now() };
    const store = await tx(STORES.blobs, "readwrite");
    await reqP(store.put(record));
    return record.id;
  }
  async function getBlob(id) {
    if (!id) return null;
    const store = await tx(STORES.blobs, "readonly");
    return reqP(store.get(id));
  }
  async function deleteBlob(id) {
    const store = await tx(STORES.blobs, "readwrite");
    return reqP(store.delete(id));
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
    const blobStore = await tx(STORES.blobs, "readonly");
    const rawBlobs = await reqP(blobStore.getAll());
    const blobs = [];
    for (const b of rawBlobs) {
      blobs.push({ id: b.id, type: b.type, createdAt: b.createdAt, dataURL: await blobToDataURL(b.blob) });
    }
    return { version: 2, exportedAt: Date.now(), schools, entries, homework, reading, mocks, events, blobs };
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
    getBlob, putBlob, deleteBlob,
    getMeta, setMeta,
    exportAll, importAll,
  };
})();
