"use strict";
// Account export and deletion. The fetch mock is Supabase. No live call.
const assert = require("assert");
const path = require("path");

const exportApi = require(path.join(__dirname, "..", "api", "account-export.js"));
const deleteApi = require(path.join(__dirname, "..", "api", "account-delete.js"));
const account = require(path.join(__dirname, "..", "api", "account.js"));
const privacy = require(path.join(__dirname, "..", "privacy.js"));

let passed = 0;
function ok(desc, cond) { assert.ok(cond, desc); passed++; }

const USER = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const TOKEN = "Bearer aaaaaaaa.bbbbbbbb.cccccccc";
const ENV = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "anon-key-0123456789abcdef",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-0123456789abcdef",
  API_QUOTA_PEPPER: "pepper-0123456789abcdef",
};
const PHRASE = privacy.DELETE_CONFIRMATION;

function jsonRes(status, body, extra) {
  const payload = body == null ? null : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  return {
    ok: status >= 200 && status < 300,
    status: status,
    headers: { get: (name) => (extra && extra.type && name.toLowerCase() === "content-type" ? extra.type : "") },
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
    arrayBuffer: async () => payload || Buffer.alloc(0),
  };
}

async function call(mod, body, behavior, extra) {
  extra = extra || {};
  const calls = [];
  const logs = [];
  const handler = mod.createHandler({
    env: extra.env || ENV,
    log: (entry) => logs.push(entry),
    fetch: async (url, opts) => {
      const entry = { url: String(url), method: opts.method, headers: opts.headers, body: opts.body || "" };
      calls.push(entry);
      return behavior(entry, calls);
    },
  });
  const headers = { authorization: extra.authorization === undefined ? TOKEN : extra.authorization };
  if (extra.authorization === null) delete headers.authorization;
  const req = { method: extra.method || "POST", body: body, headers: headers };
  let statusCode = 0;
  let jsonBody = null;
  const sent = {};
  const res = {
    status(code) { statusCode = code; return this; },
    json(payload) { jsonBody = payload; return this; },
    setHeader(key, value) { sent[String(key).toLowerCase()] = value; return this; },
  };
  await handler(req, res);
  return { statusCode: statusCode, jsonBody: jsonBody, headers: sent, calls: calls, logs: logs };
}

function secretFree(value) {
  const text = JSON.stringify(value);
  return text.indexOf(ENV.SUPABASE_SERVICE_ROLE_KEY) === -1 &&
    text.indexOf("aaaaaaaa.bbbbbbbb.cccccccc") === -1 &&
    text.indexOf("OTHER_SECRET") === -1 &&
    text.indexOf("alice@school.test") === -1;
}

function authOk(entry) {
  ok("auth uses the anon key and the user token",
    entry.headers.apikey === ENV.SUPABASE_ANON_KEY && entry.headers.authorization === TOKEN);
  return jsonRes(200, { id: USER, role: "authenticated" });
}

function serviceCall(entry) {
  return entry.headers.authorization === "Bearer " + ENV.SUPABASE_SERVICE_ROLE_KEY &&
    entry.headers.apikey === ENV.SUPABASE_SERVICE_ROLE_KEY;
}

function admit(entry) {
  if (entry.url.indexOf("/rpc/beta_access_allowed") === -1) return null;
  ok("export asks beta_access_allowed", serviceCall(entry));
  return jsonRes(200, true);
}

(async function () {
  ok("path helper keeps only uid/id", account.blobObjectPath(USER, "pic") === USER + "/pic");
  ok("path helper rejects another folder", account.blobObjectPath(USER, OTHER + "/secret") === null);
  ok("path helper rejects traversal", account.blobObjectPath(USER, "../" + OTHER) === null);
  ok("foreign row is dropped", account.ownedRecord({ owner: OTHER, store: "schools", id: "a", data: { name: "OTHER_SECRET" } }, USER) === null);

  const exported = await call(exportApi, {}, (entry) => {
    const gate = admit(entry);
    if (gate) return gate;
    if (entry.url.indexOf("/auth/v1/user") !== -1) return authOk(entry);
    if (entry.url.indexOf("/rest/v1/records") !== -1) {
      ok("records read is service role and filtered", serviceCall(entry) && entry.url.indexOf("owner=eq." + USER) !== -1);
      return jsonRes(200, [
        { owner: USER, store: "schools", id: "s1", data: { name: "Kept School" }, updated_at: "2026-01-01T00:00:00.000Z", deleted: false },
        { owner: OTHER, store: "schools", id: "s2", data: { name: "OTHER_SECRET" }, updated_at: "2026-01-01T00:00:00.000Z", deleted: false },
      ]);
    }
    if (entry.url.indexOf("/object/list/blobs") !== -1) {
      ok("blob list is service role", serviceCall(entry) && entry.body.indexOf(USER + "/") !== -1);
      return jsonRes(200, [{ name: "pic" }, { name: OTHER + "/secret" }]);
    }
    if (entry.url.indexOf("/object/blobs/") !== -1) {
      ok("download stays under the caller", entry.url.indexOf(OTHER) === -1 && serviceCall(entry));
      return jsonRes(200, Buffer.from("worksheet").toString(), { type: "image/jpeg" });
    }
    throw new Error("unexpected " + entry.method + " " + entry.url);
  });
  ok("export is 200", exported.statusCode === 200 && exported.headers["cache-control"] === "no-store" && exported.jsonBody.complete === true);
  ok("export keeps only the caller row", exported.jsonBody.records.length === 1 && exported.jsonBody.records[0].data.name === "Kept School");
  ok("export returns the caller blob", exported.jsonBody.blobs.length === 1 && exported.jsonBody.blobs[0].path === USER + "/pic" && exported.jsonBody.blobs[0].data === Buffer.from("worksheet").toString("base64"));
  ok("export hides other people and secrets", secretFree(exported.jsonBody) && secretFree(exported.logs));
  ok("export does not call Anthropic", exported.calls.every((entry) => entry.url.indexOf("anthropic") === -1));
  ok("export log is counts only", exported.logs.some((entry) => entry.outcome === "ok" && entry.recordCount === 1 && entry.blobCount === 1 && !entry.email));

  const racedExport = await call(exportApi, {}, (entry) => {
    const gate = admit(entry);
    if (gate) return gate;
    if (entry.url.indexOf("/auth/v1/user") !== -1) return authOk(entry);
    if (entry.url.indexOf("/rest/v1/records") !== -1) return jsonRes(200, []);
    if (entry.url.indexOf("/object/list/blobs") !== -1) return jsonRes(200, [{ name: "gone-during-export" }]);
    if (entry.url.indexOf("/object/blobs/") !== -1) return jsonRes(404, {});
    throw new Error("unexpected export race request");
  });
  ok("export never reports complete when a listed blob disappears", racedExport.statusCode === 500 && racedExport.jsonBody.code === "internal");

  const badExport = await call(exportApi, { confirm: PHRASE }, (entry) => {
    const gate = admit(entry);
    if (gate) return gate;
    if (entry.url.indexOf("/auth/v1/user") !== -1) return authOk(entry);
    throw new Error("should not read data");
  });
  ok("export rejects extra fields after auth", badExport.statusCode === 400 && badExport.calls.length === 2);

  const noToken = await call(exportApi, {}, () => { throw new Error("network"); }, { authorization: null });
  ok("missing token does not call the network", noToken.statusCode === 401 && noToken.calls.length === 0 && noToken.jsonBody.code === "unauthorized");

  const forged = await call(exportApi, {}, () => { throw new Error("network"); }, {
    env: Object.assign({}, ENV, { SUPABASE_SERVICE_ROLE_KEY: "aaaaaaaa.bbbbbbbb.dddddddd" }),
    authorization: "Bearer aaaaaaaa.bbbbbbbb.dddddddd",
  });
  ok("service-role bearer is not a user", forged.statusCode === 401 && forged.calls.length === 0);

  const closed = await call(exportApi, {}, () => { throw new Error("network"); }, { env: { SUPABASE_URL: "http://insecure.example" } });
  ok("export fails closed without a usable config", closed.statusCode === 503 && closed.calls.length === 0 && JSON.stringify(closed.jsonBody).indexOf("SUPABASE") === -1);

  function deleteBehavior(state) {
    return (entry) => {
      state.order.push(entry.method + " " + entry.url);
      if (entry.url.indexOf("/auth/v1/user") !== -1 && entry.url.indexOf("/admin/") === -1) return authOk(entry);
      if (entry.url.indexOf("/object/list/blobs") !== -1) {
        const body = JSON.parse(entry.body || "{}");
        const prefix = body.prefix || "";
        const offset = body.offset || 0;
        const limit = body.limit || 100;
        if (state.nested && prefix === USER + "/nested/") {
          const nested = state.nestedList || [];
          return jsonRes(200, nested.slice(offset, offset + limit));
        }
        const list = state.list || [];
        return jsonRes(200, list.slice(offset, offset + limit));
      }
      if (entry.method === "DELETE" && entry.url.indexOf("/storage/v1/object/blobs") !== -1) {
        const paths = JSON.parse(entry.body);
        ok("blob delete is only the caller prefix", serviceCall(entry) && paths.every((item) => item.indexOf(USER + "/") === 0) && paths.indexOf(OTHER + "/secret") === -1);
        state.deletedBlobs = (state.deletedBlobs || []).concat(paths);
        state.blobDeletes = (state.blobDeletes || 0) + 1;
        if (!state.keepBlobs && (!state.clearAfter || state.blobDeletes >= state.clearAfter)) {
          state.list = [];
          state.nestedList = [];
        }
        return jsonRes(state.blobStatus || 200, []);
      }
      if (entry.method === "DELETE" && entry.url.indexOf("/rest/v1/records") !== -1) {
        ok("records delete is owner scoped", entry.url.indexOf("owner=eq." + USER) !== -1 && serviceCall(entry));
        return jsonRes(state.recordsStatus || 204, null);
      }
      if (entry.url.indexOf("/ai_analysis_leases") !== -1) {
        ok("leases delete is the caller", entry.url.indexOf("user_id=eq." + USER) !== -1);
        return jsonRes(state.leaseStatus || 204, null);
      }
      if (entry.url.indexOf("/ai_quota_counters") !== -1) {
        ok("quota delete is the caller prefix", decodeURIComponent(entry.url).indexOf("u:" + USER + ":") !== -1);
        return jsonRes(204, null);
      }
      if (entry.url.indexOf("/beta_admissions") !== -1) {
        ok("beta admission delete is the caller", entry.url.indexOf("user_id=eq." + USER) !== -1 && serviceCall(entry));
        state.betaDeleted = true;
        return jsonRes(state.betaStatus == null ? 204 : state.betaStatus, null);
      }
      if (entry.url.indexOf("/auth/v1/admin/users/" + USER) !== -1) {
        ok("auth delete uses the service role", serviceCall(entry) && entry.method === "DELETE");
        state.authDeleted = true;
        return jsonRes(state.authStatus || 200, { id: USER });
      }
      throw new Error("unexpected " + entry.method + " " + entry.url);
    };
  }

  const removed = { order: [], list: [{ name: "pic" }, { name: OTHER + "/secret" }] };
  const deleted = await call(deleteApi, { confirm: PHRASE }, deleteBehavior(removed));
  ok("delete succeeds", deleted.statusCode === 200 && deleted.jsonBody.deleted === true && Object.keys(deleted.jsonBody).length === 1);
  ok("delete order is blobs, records, leases, quota, beta, then auth",
    removed.order[0].indexOf("/auth/v1/user") !== -1 &&
    removed.order.some((line) => line.indexOf("/object/list/") !== -1) &&
    removed.order.some((line) => line.indexOf("DELETE") === 0 && line.indexOf("/storage/") !== -1) &&
    removed.order.some((line) => line.indexOf("/rest/v1/records") !== -1) &&
    removed.order.some((line) => line.indexOf("ai_analysis_leases") !== -1) &&
    removed.order.some((line) => line.indexOf("ai_quota_counters") !== -1) &&
    removed.order.some((line) => line.indexOf("beta_admissions") !== -1) &&
    removed.order[removed.order.length - 1].indexOf("/auth/v1/admin/users/") !== -1 &&
    removed.betaDeleted === true);
  ok("delete confirms the prefix is empty before auth",
    removed.order.filter((line) => line.indexOf("/object/list/") !== -1).length >= 2);
  ok("delete log hides the phrase and secrets", secretFree(deleted.logs) && JSON.stringify(deleted.logs).indexOf(PHRASE) === -1);
  ok("deleted blob list omitted the other account", removed.deletedBlobs.length === 1);

  const refused = { order: [], list: [{ name: "pic" }] };
  const wrong = await call(deleteApi, { confirm: "please" }, deleteBehavior(refused));
  ok("wrong confirmation deletes nothing", wrong.statusCode === 400 && wrong.jsonBody.code === "invalid_request" && refused.order.length === 1 && !refused.authDeleted);

  const extra = await call(deleteApi, { confirm: PHRASE, email: "alice@school.test" }, deleteBehavior({ order: [], list: [] }));
  ok("extra delete field deletes nothing", extra.statusCode === 400 && extra.calls.length === 1 && secretFree(extra.jsonBody));

  const again = { order: [], list: [], blobStatus: 404, authStatus: 404, leaseStatus: 404 };
  const retry = await call(deleteApi, { confirm: PHRASE }, deleteBehavior(again));
  ok("retry with nothing left still succeeds", retry.statusCode === 200 && retry.jsonBody.deleted === true && again.authDeleted === true);
  ok("retry does not delete storage when the list is empty", again.order.every((line) => line.indexOf("DELETE https://example.supabase.co/storage") !== 0));

  const blocked = { order: [], list: [{ name: "pic" }], recordsStatus: 500 };
  const stopped = await call(deleteApi, { confirm: PHRASE }, deleteBehavior(blocked));
  ok("records failure does not delete the auth user", stopped.statusCode === 500 && stopped.jsonBody.code === "internal" && !blocked.authDeleted);
  ok("records failure stays generic", secretFree(stopped.jsonBody) && JSON.stringify(stopped.jsonBody).indexOf("records") === -1);

  const leaked = await call(deleteApi, { confirm: PHRASE }, (entry) => {
    if (entry.url.indexOf("/auth/v1/user") !== -1 && entry.url.indexOf("/admin/") === -1) return authOk(entry);
    if (entry.url.indexOf("/object/list/blobs") !== -1) return jsonRes(500, { message: "alice@school.test OTHER_SECRET" });
    throw new Error("should have stopped");
  });
  ok("upstream text is not returned or logged", leaked.statusCode === 500 && secretFree(leaked.jsonBody) && secretFree(leaked.logs));

  function recordRows(count) {
    const rows = [];
    for (let i = 0; i < count; i++) {
      rows.push({ owner: USER, store: "entries", id: "e" + i, data: { n: i }, updated_at: "2026-01-01T00:00:00.000Z", deleted: false });
    }
    return rows;
  }
  function pagedExport(rows, blobs) {
    return (entry) => {
      const gate = admit(entry);
      if (gate) return gate;
      if (entry.url.indexOf("/auth/v1/user") !== -1) return authOk(entry);
      if (entry.url.indexOf("/rest/v1/records") !== -1) {
        const offset = Number((entry.url.match(/offset=(\d+)/) || [])[1] || 0);
        const limit = Number((entry.url.match(/limit=(\d+)/) || [])[1] || rows.length);
        return jsonRes(200, rows.slice(offset, offset + limit));
      }
      if (entry.url.indexOf("/object/list/blobs") !== -1) {
        const body = JSON.parse(entry.body || "{}");
        const offset = body.offset || 0;
        const limit = body.limit || (blobs || []).length;
        return jsonRes(200, (blobs || []).slice(offset, offset + limit));
      }
      if (entry.url.indexOf("/object/blobs/") !== -1) {
        return jsonRes(200, Buffer.from("x").toString(), { type: "image/jpeg" });
      }
      throw new Error("unexpected " + entry.method + " " + entry.url);
    };
  }

  const exact = await call(exportApi, {}, pagedExport(recordRows(account.LIMITS.RECORD_CAP), []));
  ok("exact record cap exports as complete", exact.statusCode === 200 && exact.jsonBody.complete === true && exact.jsonBody.records.length === account.LIMITS.RECORD_CAP);

  const overflow = await call(exportApi, {}, pagedExport(recordRows(account.LIMITS.RECORD_CAP + 1), []));
  ok("one record past the cap is not a partial 200", overflow.statusCode === 413 && overflow.jsonBody.code === "export_too_large" && !overflow.jsonBody.records);

  const huge = Buffer.alloc(account.LIMITS.BLOB_BYTES + 1);
  const tooBig = await call(exportApi, {}, (entry) => {
    const gate = admit(entry);
    if (gate) return gate;
    if (entry.url.indexOf("/auth/v1/user") !== -1) return authOk(entry);
    if (entry.url.indexOf("/rest/v1/records") !== -1) return jsonRes(200, []);
    if (entry.url.indexOf("/object/list/blobs") !== -1) return jsonRes(200, [{ name: "pic", id: "1", metadata: { size: 1 } }]);
    if (entry.url.indexOf("/object/blobs/") !== -1) {
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => name.toLowerCase() === "content-type" ? "image/jpeg" : "" },
        json: async () => ({}),
        arrayBuffer: async () => huge,
      };
    }
    throw new Error("unexpected " + entry.url);
  });
  ok("an oversized blob is not returned with omitted bytes", tooBig.statusCode === 413 && tooBig.jsonBody.code === "export_too_large" && JSON.stringify(tooBig.jsonBody).indexOf("omitted") === -1);

  const nested = { order: [], list: [{ name: "nested", id: null, metadata: null }, { name: OTHER + "/secret" }], nested: true, nestedList: [{ name: "pic", id: "file-1", metadata: { size: 1 } }] };
  const nestedDelete = await call(deleteApi, { confirm: PHRASE }, deleteBehavior(nested));
  ok("nested objects are deleted and a foreign name is not", nestedDelete.statusCode === 200 && nested.deletedBlobs.length === 1 && nested.deletedBlobs[0] === USER + "/nested/pic" && nested.authDeleted === true);

  const residual = { order: [], list: [{ name: "pic", id: "1", metadata: { size: 1 } }], clearAfter: 2 };
  const retried = await call(deleteApi, { confirm: PHRASE }, deleteBehavior(residual));
  ok("a residual object is deleted on a later round", retried.statusCode === 200 && residual.blobDeletes === 2 && residual.authDeleted === true);

  const stuck = { order: [], list: [{ name: "pic", id: "1", metadata: { size: 1 } }], keepBlobs: true };
  const remains = await call(deleteApi, { confirm: PHRASE }, deleteBehavior(stuck));
  ok("objects that remain block auth deletion", remains.statusCode === 500 && remains.jsonBody.code === "internal" && stuck.authDeleted !== true && stuck.blobDeletes === account.LIMITS.DELETE_BLOB_ROUNDS);

  const removedUser = await call(deleteApi, { confirm: PHRASE }, deleteBehavior({ order: [], list: [] }), {
    env: Object.assign({}, ENV, { BETA_MODE: "on" }),
    betaAllows: async () => false,
  });
  ok("deletion stays available when admission is false", removedUser.statusCode === 200 && removedUser.jsonBody.deleted === true);

  console.log("account-api.test.js: " + passed + " assertions passed");
})().catch((err) => { console.error(err); process.exit(1); });
