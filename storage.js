/*
 * EduStore — a Promise-wrapped IndexedDB abstraction (the storage seam).
 * app.js only ever calls window.EduStore.* so a future cloud-storage.js can
 * implement the same interface without any UI/logic rewrite.
 */
(function () {
  "use strict";

  const DB_NAME = "eduplanner";
  const DB_VERSION = 1;
  const STORES = {
    schools: "schools",
    entries: "entries",
    blobs: "blobs",
    meta: "meta",
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
    const blobStore = await tx(STORES.blobs, "readonly");
    const rawBlobs = await reqP(blobStore.getAll());
    const blobs = [];
    for (const b of rawBlobs) {
      blobs.push({ id: b.id, type: b.type, createdAt: b.createdAt, dataURL: await blobToDataURL(b.blob) });
    }
    return { version: 1, exportedAt: Date.now(), schools, entries, blobs };
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
    for (const s of payload.schools || []) {
      const store = await tx(STORES.schools, "readwrite");
      await reqP(store.put(s));
    }
    for (const e of payload.entries || []) {
      const store = await tx(STORES.entries, "readwrite");
      await reqP(store.put(e));
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
    getBlob, putBlob, deleteBlob,
    getMeta, setMeta,
    exportAll, importAll,
  };
})();
