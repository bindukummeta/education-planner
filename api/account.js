"use strict";
// Cloud account export and permanent deletion.
// Verifies the caller's Supabase access token, then uses the service role for
// data-plane calls. Never sends the service role to the browser. Does not call
// Anthropic. Tests pass a fake fetch; this module does not pick a live project.

const security = require("./security");
const privacy = require("../privacy");

const CALL_TIMEOUT_MS = 15000;
const RECORD_PAGE = 1000;
const RECORD_CAP = 5000;
const BLOB_PAGE = 100;
const BLOB_CAP = 2000;
const BLOB_BYTES = 3 * 1024 * 1024;
const EXPORT_BYTES = 8 * 1024 * 1024;
const DELETE_LIST_SAFETY = 20000;
const DELETE_BLOB_ROUNDS = 4;
const BLOB_DEPTH = 8;

function failInternal(message) {
  const error = new Error(message || "account");
  error.code = "internal";
  error.errorName = "Error";
  return error;
}

function exportTooLarge() {
  const error = new Error("export");
  error.code = "export_too_large";
  error.errorName = "Error";
  return error;
}

function deleteBatchFull() {
  const error = new Error("delete-batch-full");
  error.code = "delete_batch_full";
  return error;
}

function readJson(req, maxChars) {
  let body = req ? req.body : null;
  if (typeof body === "string") {
    if (body.length > maxChars) return { code: "payload_too_large" };
    try { body = JSON.parse(body); } catch (_) { return { code: "invalid_request" }; }
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { code: "invalid_request" };
  let serialized;
  try { serialized = JSON.stringify(body); } catch (_) { return { code: "invalid_request" }; }
  if (serialized.length > maxChars) return { code: "payload_too_large" };
  return { body: body };
}

function safeSegment(part) {
  return typeof part === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(part);
}

function ownedStoragePath(userId, fullPath) {
  if (typeof userId !== "string" || typeof fullPath !== "string") return null;
  const prefix = userId + "/";
  const full = fullPath.replace(/^\/+/, "");
  if (full.indexOf(prefix) !== 0 || full.indexOf("..") !== -1) return null;
  const parts = full.slice(prefix.length).split("/");
  if (!parts.length || parts.some((part) => !safeSegment(part))) return null;
  return prefix + parts.join("/");
}

function blobObjectPath(userId, name) {
  if (typeof userId !== "string" || typeof name !== "string") return null;
  const trimmed = name.replace(/^\/+/, "");
  if (!trimmed || trimmed.indexOf("..") !== -1 || trimmed.indexOf("/") !== -1) return null;
  return ownedStoragePath(userId, userId + "/" + trimmed);
}

function listedObjectPath(userId, prefix, name) {
  if (typeof name !== "string" || !name || name.indexOf("..") !== -1) return null;
  const root = userId + "/";
  if (prefix !== root && prefix.indexOf(root) !== 0) return null;
  if (prefix === root && name.indexOf("/") !== -1 && name.indexOf(root) !== 0) return null;
  const full = name.indexOf(root) === 0 ? name : prefix + name;
  return ownedStoragePath(userId, full);
}

function isStorageFolder(row) {
  return !!row && row.id === null && row.metadata == null && typeof row.name === "string" && row.name && row.name.indexOf("/") === -1;
}

function ownedRecord(row, userId) {
  if (!row || row.owner !== userId) return null;
  if (typeof row.store !== "string" || typeof row.id !== "string") return null;
  if (!row.store || row.store.length > 40 || !row.id || row.id.length > 80) return null;
  const data = row.data && typeof row.data === "object" && !Array.isArray(row.data) ? row.data : {};
  return {
    owner: userId,
    store: row.store,
    id: row.id,
    data: data,
    updated_at: typeof row.updated_at === "string" ? row.updated_at.slice(0, 40) : "",
    deleted: row.deleted === true,
  };
}

function serviceKey(env) {
  return String(env && env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
}

async function callService(gate, method, url, body) {
  const key = serviceKey(gate.env);
  const headers = { apikey: key, authorization: "Bearer " + key };
  const init = { method: method, headers: headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return security.fetchUpstream(url, init, CALL_TIMEOUT_MS, gate.fetch);
}

function statusOf(res) {
  return res && typeof res.status === "number" ? res.status : 0;
}

function okStatus(res) {
  const status = statusOf(res);
  return status >= 200 && status < 300;
}

async function fetchRecordPage(gate, offset, limit) {
  const url = gate.origin + "/rest/v1/records?owner=eq." + encodeURIComponent(gate.userId) +
    "&select=owner,store,id,data,updated_at,deleted&order=updated_at.asc,store.asc,id.asc&limit=" + limit +
    "&offset=" + offset;
  const res = await callService(gate, "GET", url);
  if (!okStatus(res)) throw failInternal("records");
  const rows = await res.json();
  if (!Array.isArray(rows)) throw failInternal("records");
  return rows;
}

async function listOwnedRecords(gate) {
  const out = [];
  let offset = 0;
  for (;;) {
    const rows = await fetchRecordPage(gate, offset, RECORD_PAGE);
    if (out.length + rows.length > RECORD_CAP) throw exportTooLarge();
    rows.forEach((row) => {
      const kept = ownedRecord(row, gate.userId);
      if (kept) out.push(kept);
    });
    if (rows.length < RECORD_PAGE) return out;
    offset += rows.length;
    if (offset > RECORD_CAP) throw exportTooLarge();
    if (out.length >= RECORD_CAP) {
      const peek = await fetchRecordPage(gate, offset, 1);
      if (peek.length) throw exportTooLarge();
      return out;
    }
  }
}

async function listStoragePage(gate, prefix, offset, limit) {
  const url = gate.origin + "/storage/v1/object/list/blobs";
  const res = await callService(gate, "POST", url, {
    prefix: prefix,
    limit: limit,
    offset: offset,
    sortBy: { column: "name", order: "asc" },
  });
  if (!okStatus(res)) throw failInternal("blobs");
  const rows = await res.json();
  if (!Array.isArray(rows)) throw failInternal("blobs");
  return rows;
}

async function walkBlobs(gate, prefix, paths, seen, cap, depth) {
  if (depth > BLOB_DEPTH) throw failInternal("blobs");
  if (seen[prefix]) return;
  seen[prefix] = true;
  let offset = 0;
  for (;;) {
    const rows = await listStoragePage(gate, prefix, offset, BLOB_PAGE);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row || typeof row.name !== "string" || !row.name || row.name.indexOf("..") !== -1) continue;
      if (isStorageFolder(row)) {
        await walkBlobs(gate, prefix + row.name + "/", paths, seen, cap, depth + 1);
        continue;
      }
      const path = listedObjectPath(gate.userId, prefix, row.name);
      if (!path || paths.indexOf(path) !== -1) continue;
      if (paths.length >= cap) {
        const error = cap === BLOB_CAP ? exportTooLarge() : deleteBatchFull();
        throw error;
      }
      paths.push(path);
    }
    if (rows.length < BLOB_PAGE) return;
    offset += rows.length;
    if (offset > cap) {
      throw cap === BLOB_CAP ? exportTooLarge() : failInternal("blobs");
    }
  }
}

async function listOwnedBlobs(gate, mode) {
  const cap = mode === "export" ? BLOB_CAP : DELETE_LIST_SAFETY;
  const paths = [];
  try {
    await walkBlobs(gate, gate.userId + "/", paths, {}, cap, 0);
  } catch (err) {
    // Deletion is deliberately batchable. Returning a full safe batch lets
    // deleteAccount remove it and list from the beginning again. Export must
    // still refuse truncation.
    if (!(mode === "delete" && err && err.code === "delete_batch_full")) throw err;
  }
  return paths;
}

async function prefixIsEmpty(gate) {
  const rows = await listStoragePage(gate, gate.userId + "/", 0, 1);
  return rows.length === 0;
}

function headerValue(res, name) {
  const headers = res && res.headers;
  if (!headers) return "";
  if (typeof headers.get === "function") return headers.get(name) || "";
  const found = Object.keys(headers).find((key) => key.toLowerCase() === name);
  return found ? String(headers[found]) : "";
}

function mediaTypeOf(res) {
  const raw = headerValue(res, "content-type").split(";")[0].trim().toLowerCase();
  if (raw === "image/jpeg" || raw === "image/png" || raw === "application/octet-stream") return raw;
  return "application/octet-stream";
}

async function bytesOf(res) {
  if (typeof res.arrayBuffer === "function") return Buffer.from(await res.arrayBuffer());
  if (typeof res.buffer === "function") return Buffer.from(await res.buffer());
  throw failInternal("blob-body");
}

async function downloadBlob(gate, objectPath, budget) {
  const url = gate.origin + "/storage/v1/object/blobs/" + objectPath.split("/").map(encodeURIComponent).join("/");
  const res = await callService(gate, "GET", url);
  // The object was present in the listing, so a 404 means the export raced
  // with a change. Never label that response complete; the parent can retry.
  if (statusOf(res) === 404) throw failInternal("blob-missing");
  if (!okStatus(res)) throw failInternal("blob");
  const buf = await bytesOf(res);
  const mediaType = mediaTypeOf(res);
  if (buf.length > BLOB_BYTES || buf.length > budget.left) throw exportTooLarge();
  budget.left -= buf.length;
  return { path: objectPath, mediaType: mediaType, bytes: buf.length, data: buf.toString("base64") };
}

async function deleteBlobPaths(gate, paths) {
  for (let i = 0; i < paths.length; i += 100) {
    const chunk = paths.slice(i, i + 100);
    const res = await callService(gate, "DELETE", gate.origin + "/storage/v1/object/blobs", chunk);
    const status = statusOf(res);
    if (status === 404) continue;
    if (!okStatus(res)) throw failInternal("blob-delete");
  }
}

async function deleteRest(gate, query, allowMissing) {
  const res = await callService(gate, "DELETE", gate.origin + query);
  const status = statusOf(res);
  if (allowMissing && status === 404) return;
  if (!okStatus(res)) throw failInternal("row-delete");
}

async function deleteAuthUser(gate) {
  const url = gate.origin + "/auth/v1/admin/users/" + encodeURIComponent(gate.userId);
  const res = await callService(gate, "DELETE", url);
  const status = statusOf(res);
  if (status === 404) return;
  if (!okStatus(res)) throw failInternal("auth-delete");
}

function respond(res, gate, status, payload) {
  return security.writeJson(res, status, payload, {
    "x-request-id": gate.requestId,
    "cache-control": "no-store",
  });
}

async function exportAccount(req, res, deps) {
  const gate = await security.authenticate(req, res, "account-export", deps);
  if (!gate.ok) return;
  try {
    const parsed = readJson(req, 4000);
    if (parsed.code) return gate.fail(parsed.code);
    if (Object.keys(parsed.body).length !== 0) return gate.fail("invalid_request");
    const records = await listOwnedRecords(gate);
    const paths = await listOwnedBlobs(gate, "export");
    const budget = { left: EXPORT_BYTES };
    const blobs = [];
    for (let i = 0; i < paths.length; i++) {
      const file = await downloadBlob(gate, paths[i], budget);
      if (file) blobs.push(file);
    }
    gate.succeed({ recordCount: records.length, blobCount: blobs.length });
    return respond(res, gate, 200, {
      exportedAt: new Date().toISOString(),
      complete: true,
      records: records,
      blobs: blobs,
    });
  } catch (err) {
    const code = err && (err.code === "timeout" || err.code === "export_too_large") ? err.code : "internal";
    return gate.fail(code, { errorName: err && (err.errorName || err.name) });
  }
}

async function deleteAccount(req, res, deps) {
  const gate = await security.authenticate(req, res, "account-delete", deps);
  if (!gate.ok) return;
  try {
    const parsed = readJson(req, 4000);
    if (parsed.code) return gate.fail(parsed.code);
    const keys = Object.keys(parsed.body);
    if (keys.length !== 1 || keys[0] !== "confirm" || parsed.body.confirm !== privacy.DELETE_CONFIRMATION) {
      return gate.fail("invalid_request");
    }
    // Order is privacy.DELETION_ORDER. Auth is last so a failed earlier step
    // can be retried with the same token. A capped or residual blob list is a
    // failure: the auth user stays until the uid/ prefix lists empty.
    let removedBlobs = 0;
    for (let round = 0; round < DELETE_BLOB_ROUNDS; round++) {
      const paths = await listOwnedBlobs(gate, "delete");
      if (!paths.length) break;
      await deleteBlobPaths(gate, paths);
      removedBlobs += paths.length;
    }
    if (!(await prefixIsEmpty(gate))) throw failInternal("blobs-remain");
    const id = encodeURIComponent(gate.userId);
    await deleteRest(gate, "/rest/v1/records?owner=eq." + id, false);
    await deleteRest(gate, "/rest/v1/ai_analysis_leases?user_id=eq." + id, true);
    await deleteRest(gate, "/rest/v1/ai_quota_counters?bucket=like." + encodeURIComponent("u:" + gate.userId + ":*"), true);
    await deleteRest(gate, "/rest/v1/beta_admissions?user_id=eq." + id, true);
    await deleteAuthUser(gate);
    gate.succeed({ recordCount: 0, blobCount: removedBlobs });
    return respond(res, gate, 200, { deleted: true });
  } catch (err) {
    const code = err && err.code === "timeout" ? "timeout" : "internal";
    return gate.fail(code, { errorName: err && (err.errorName || err.name) });
  }
}

module.exports = {
  exportAccount: exportAccount,
  deleteAccount: deleteAccount,
  blobObjectPath: blobObjectPath,
  ownedStoragePath: ownedStoragePath,
  ownedRecord: ownedRecord,
  LIMITS: {
    RECORD_PAGE: RECORD_PAGE,
    RECORD_CAP: RECORD_CAP,
    BLOB_PAGE: BLOB_PAGE,
    BLOB_CAP: BLOB_CAP,
    BLOB_BYTES: BLOB_BYTES,
    EXPORT_BYTES: EXPORT_BYTES,
    DELETE_BLOB_ROUNDS: DELETE_BLOB_ROUNDS,
  },
};
