/* Smoke-test stand-in for the pinned supabase-js UMD. No network. */
(function (root) {
  "use strict";
  var SESSION_KEY = "edu-smoke-session";
  var USER_ID = "11111111-1111-4111-8111-111111111111";
  var TOKEN = "aaaaaaaa.bbbbbbbb.cccccccc";
  var listeners = [];
  var smoke = {
    otp: [],
    upserts: [],
    remoteRows: [{
      owner: USER_ID,
      store: "schools",
      id: "smoke-remote-school",
      data: {
        id: "smoke-remote-school",
        name: "Smoke Remote School",
        updatedAt: 1,
        createdAt: 1,
      },
      updated_at: "2026-01-01T00:00:00.000Z",
      deleted: false,
    }],
  };
  root.__eduSmoke = smoke;

  function readSession() {
    try {
      var raw = root.localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }
  function writeSession(session) {
    if (!session) root.localStorage.removeItem(SESSION_KEY);
    else root.localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }
  function emit(event, session) {
    listeners.slice().forEach(function (cb) {
      try { cb(event, session); } catch (e) {}
    });
  }
  function client() {
    return {
      auth: {
        onAuthStateChange: function (cb) {
          listeners.push(cb);
          return { data: { subscription: { unsubscribe: function () {
            listeners = listeners.filter(function (fn) { return fn !== cb; });
          } } } };
        },
        getSession: function () {
          return Promise.resolve({ data: { session: readSession() }, error: null });
        },
        signInWithOtp: function (args) {
          smoke.otp.push(args && args.email);
          return Promise.resolve({ data: {}, error: null });
        },
        verifyOtp: function (args) {
          var token = args && String(args.token || "").trim();
          if (token !== "123456") {
            return Promise.resolve({ data: { session: null }, error: { message: "invalid code" } });
          }
          var session = {
            access_token: TOKEN,
            user: { id: USER_ID, email: args.email, role: "authenticated" },
          };
          writeSession(session);
          emit("SIGNED_IN", session);
          return Promise.resolve({ data: { session: session }, error: null });
        },
        signOut: function () {
          writeSession(null);
          emit("SIGNED_OUT", null);
          return Promise.resolve({ error: null });
        },
      },
      from: function () {
        var api = {
          upsert: function (row) {
            smoke.upserts.push(row);
            return Promise.resolve({ data: null, error: null });
          },
          select: function () { return api; },
          eq: function () { return api; },
          gte: function () { return api; },
          order: function () { return api; },
          range: function (from, to) {
            var rows = smoke.remoteRows.slice();
            var end = typeof to === "number" ? to + 1 : rows.length;
            var start = typeof from === "number" ? from : 0;
            return Promise.resolve({ data: rows.slice(start, end), error: null });
          },
        };
        return api;
      },
      storage: {
        from: function () {
          return {
            upload: function () { return Promise.resolve({ data: null, error: null }); },
            remove: function () { return Promise.resolve({ data: null, error: null }); },
            download: function () { return Promise.resolve({ data: null, error: { message: "no blob in smoke" } }); },
          };
        },
      },
    };
  }

  root.supabase = { createClient: function () { return client(); } };
})(window);
