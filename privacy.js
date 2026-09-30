// Data inventory, retention defaults, and the parent-facing notice.
// Shared by the Settings screen and the account API. This text has not been
// checked by a lawyer and does not claim legal approval.
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (typeof root === "object" && root) root.EduPrivacy = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var DAY_MS = 24 * 60 * 60 * 1000;
  var LOG_RETENTION_DAYS = 7;
  var LOG_RETENTION_MS = LOG_RETENTION_DAYS * DAY_MS;
  var DELETE_CONFIRMATION = "DELETE MY CLOUD ACCOUNT";
  var DELETION_ORDER = [
    "storage-objects",
    "owner-records",
    "analysis-leases",
    "quota-counters",
    "beta-admissions",
    "auth-user",
  ];

  var ON_DEVICE = "On this device until you delete it, import a replacement backup, or clear this site's data in the browser.";
  var UNTIL_CLOUD_DELETE = "Kept for the signed-in account until you permanently delete the cloud account from Settings. A retry of that deletion is safe if a step was already empty.";

  var INVENTORY = [
    { id: "idb-schools", location: "indexeddb", name: "schools", purpose: "School names, postcodes, notes, and cut-offs a parent types.", retention: ON_DEVICE, processor: "This device", enforced: "device" },
    { id: "idb-entries", location: "indexeddb", name: "entries", purpose: "Daily practice scores and subjects.", retention: ON_DEVICE, processor: "This device", enforced: "device" },
    { id: "idb-homework", location: "indexeddb", name: "homework", purpose: "Homework tasks the parent records.", retention: ON_DEVICE, processor: "This device", enforced: "device" },
    { id: "idb-reading", location: "indexeddb", name: "reading", purpose: "Reading titles and minutes.", retention: ON_DEVICE, processor: "This device", enforced: "device" },
    { id: "idb-mocks", location: "indexeddb", name: "mocks", purpose: "Mock scores the parent records.", retention: ON_DEVICE, processor: "This device", enforced: "device" },
    { id: "idb-events", location: "indexeddb", name: "events", purpose: "Calendar events the parent adds.", retention: ON_DEVICE, processor: "This device", enforced: "device" },
    { id: "idb-students", location: "indexeddb", name: "students", purpose: "Child profile names and colours chosen by the parent.", retention: ON_DEVICE, processor: "This device", enforced: "device" },
    { id: "idb-projects", location: "indexeddb", name: "projects", purpose: "Project notes and reflections.", retention: ON_DEVICE, processor: "This device", enforced: "device" },
    { id: "idb-curiosity", location: "indexeddb", name: "curiosity", purpose: "Curiosity prompts and topics.", retention: ON_DEVICE, processor: "This device", enforced: "device" },
    { id: "idb-analyses", location: "indexeddb", name: "analyses", purpose: "Worksheet analysis a parent has chosen to keep.", retention: ON_DEVICE, processor: "This device", enforced: "device" },
    { id: "idb-blobs", location: "indexeddb", name: "blobs", purpose: "Worksheet photos kept on this device.", retention: ON_DEVICE, processor: "This device", enforced: "device" },
    { id: "idb-meta", location: "indexeddb", name: "meta", purpose: "Per-child mastery and the school year are synced and backed up. The active child, Enhanced AI consent, coach audience, geocode cache, and sync cursor stay on this device.", retention: ON_DEVICE, processor: "This device", enforced: "device" },
    { id: "idb-sync-queue", location: "indexeddb", name: "_dirty and _tombstones", purpose: "Local queue of changes waiting to sync, including deletions. Import clears it and rebuilds it from the backup so an older delete is not pushed.", retention: ON_DEVICE, processor: "This device", enforced: "device" },
    { id: "local-settings", location: "local-storage", name: "eduplanner.settings.v1", purpose: "Home postcode and the last subject and difficulty used on this device.", retention: ON_DEVICE, processor: "This device", enforced: "device" },
    { id: "local-auth-session", location: "local-storage", name: "Supabase auth session", purpose: "Sign-in token for Family Sync. It is not a copy of the child's work. This app does not check a second factor.", retention: "Cleared when you sign out, after 30 minutes without use, or 4 hours after sign-in, whichever comes first. Also removed from use when the cloud account is deleted.", processor: "This device and Supabase Auth", enforced: "deletion-api" },
    { id: "supabase-records", location: "supabase-row", name: "public.records", purpose: "Cloud copy of synced rows, each stamped with the account owner.", retention: UNTIL_CLOUD_DELETE, processor: "Supabase", enforced: "deletion-api" },
    { id: "supabase-blobs", location: "supabase-blob", name: "blobs bucket uid/", purpose: "Worksheet photos stored at uid/object for the signed-in account.", retention: UNTIL_CLOUD_DELETE, processor: "Supabase", enforced: "deletion-api" },
    { id: "supabase-auth", location: "supabase-row", name: "auth.users", purpose: "The family sign-in (email and account id).", retention: UNTIL_CLOUD_DELETE, processor: "Supabase Auth", enforced: "deletion-api" },
    { id: "quota-counters", location: "supabase-row", name: "ai_quota_counters and ai_analysis_leases", purpose: "Short-lived rate-limit buckets and homework leases. Buckets are hashed or keyed by account id, not by the child's work.", retention: "Minute and day buckets expire in about two days. Account deletion removes buckets that start with that account id, and any leases for that account.", processor: "Supabase", enforced: "deletion-api" },
    { id: "beta-admissions", location: "supabase-row", name: "beta_admissions", purpose: "Invited-family allowlist of account ids. It does not store the child's work.", retention: "Removed when that cloud account is deleted. The list is capped at 200.", processor: "Supabase", enforced: "deletion-api" },
    { id: "ai-coach", location: "ai-payload", name: "Coach snapshot", purpose: "A derived progress summary (scores, school status labels, reading totals, game counts). Photos, free-text notes, and the child's name are not the payload.", retention: "This app does not store the request after the reply is returned. What the AI company keeps is outside this app and is part of the outstanding legal review.", processor: "Anthropic", enforced: "not-stored-here" },
    { id: "ai-homework", location: "ai-payload", name: "Worksheet images", purpose: "Photos the parent chooses to send for enhanced analysis, plus the subject label.", retention: "This app does not store the images on the server. What the AI company keeps is outside this app and is part of the outstanding legal review.", processor: "Anthropic", enforced: "not-stored-here" },
    { id: "ai-practice", location: "ai-payload", name: "Practice question text", purpose: "Question text and expected answers used to generate similar practice. Photos and names are not sent.", retention: "This app does not store the request after the reply is returned. What the AI company keeps is outside this app and is part of the outstanding legal review.", processor: "Anthropic", enforced: "not-stored-here" },
    { id: "log-api", location: "log", name: "API outcome log", purpose: "One JSON line per request: request id, endpoint, outcome, status, duration, and hashes. Prompts, images, tokens, names, emails, and schoolwork are dropped.", retention: "Not written to the database. Keep host logs for 7 days, then delete them. This repository cannot change the host's log setting.", processor: "Vercel", enforced: "allowlist" },
    { id: "log-client", location: "log", name: "Browser error report", purpose: "Optional error type, file name, and line. Messages, stacks, and page data are rejected.", retention: "Off unless the operator and the app both turn it on. The server holds counts in memory only and drops them within 7 days (the rate window is one day).", processor: "Vercel", enforced: "memory-prune" },
    { id: "lookup-postcode", location: "processor", name: "postcodes.io", purpose: "The home postcode is sent to look up a latitude and longitude for a straight-line distance. The child's name is not sent.", retention: "The coordinate is cached on this device. The lookup service's own retention is outside this app.", processor: "postcodes.io", enforced: "device" },
  ];

  var PROCESSORS = [
    { name: "This device", purpose: "Stores the app's IndexedDB and local settings.", data: "Family education records the parent enters.", contract: "Not a company. Stays in the browser." },
    { name: "Supabase", purpose: "Family Sync auth, the records table, and the blobs bucket.", data: "Account email, synced rows, and photos under uid/.", contract: "Outstanding — no contract is signed in this repository." },
    { name: "Anthropic", purpose: "Cloud AI replies for coach, worksheet analysis, and generated practice.", data: "Only the payloads described in the inventory, and only after the parent ticks the box.", contract: "Outstanding — no contract is signed in this repository." },
    { name: "Vercel", purpose: "Hosts the app and the API, and stores the short outcome logs.", data: "Request metadata and allowlisted log fields. Not the child's work.", contract: "Outstanding — no contract is signed in this repository." },
    { name: "postcodes.io", purpose: "Turns a postcode into a coordinate.", data: "The postcode the parent types.", contract: "Outstanding — public lookup, no contract is signed in this repository." },
    { name: "jsDelivr", purpose: "Delivers the Supabase browser library.", data: "Connection data only. Family records are not sent there.", contract: "Outstanding — no contract is signed in this repository." },
    { name: "Google Fonts", purpose: "Loads the heading font.", data: "Connection data only. Family records are not sent there.", contract: "Outstanding — no contract is signed in this repository." },
  ];

  var NOTICE = [
    "This notice is for parents and carers. It describes how Education Planner handles family information. It has not been checked by a lawyer. It is not legal advice and it is not an official approval.",
    "The app is for a parent planning a child's learning. Children can use the games and the on-device coach cards. A parent decides whether cloud features are on.",
    "Most information stays on this device: schools, scores, reading, homework, photos, and game progress. A backup you export is saved wherever you put that file. Export backup does not need a cloud account.",
    "If you turn on Family Sync and sign in, a copy is stored in Supabase for that account, including worksheet photos under your account id. Other families are not given your rows.",
    "Enhanced AI is off until you turn it on in Settings. That switch covers the AI coach, enhanced worksheet analysis, and generated practice. Each one asks you to tick a box every time before anything is sent.",
    "The coach sends a short progress summary, not photos or free-text notes. Worksheet analysis sends the photos you choose. Practice sends question text and answers. The AI company is Anthropic. This app does not keep that request after the reply comes back. What Anthropic keeps has not been signed off. That legal review is outstanding.",
    "A postcode you type can be sent to postcodes.io to estimate distance to a school. The child's name is not part of that lookup.",
    "Error reports are off unless an operator turns them on as well. They carry an error type and a file name, not the child's work. API logs are a short status line with hashes, kept for 7 days on the host, and they do not include photos, names, or schoolwork.",
    "You can export the cloud copy, or permanently delete the cloud account, from Settings. Deletion removes synced rows, photos stored for that account, and the sign-in. It does not wipe this device by itself. Type the confirmation exactly. It cannot be undone.",
    "Family information is not sold. Companies that process it are listed for operators in the subprocessor list. Who the legal controller is, and the lawful basis, still need a lawyer. That review is outstanding.",
  ];

  var AI_DISCLOSURE = [
    "This explanation has not been checked by a lawyer. It is not an approval of the AI features.",
    "Cloud AI is optional. The Enhanced AI switch in Settings starts off. It covers the AI coach, enhanced worksheet analysis, and generated practice.",
    "Each time you use one of those, the screen asks you to tick a box before the request is sent. Leaving the box unticked means nothing is sent. The tick is not remembered for next time.",
    "The coach can write to you as a parent, or a short encouraging note in the child view. It is not a teacher, an exam result, or a decision about the child. You choose what to do with it.",
    "On-device games and the child coach's next-step cards do not use the cloud. They stay on the device when AI is off.",
    "Do not send a photo or a piece of work you are not willing to have processed for that single request. This project has not finished a legal review of how long the AI company keeps it.",
  ];

  function pruneTimestamps(stamps, now, maxAge) {
    var kept = [];
    var list = Array.isArray(stamps) ? stamps : [];
    var age = typeof maxAge === "number" ? maxAge : LOG_RETENTION_MS;
    var clock = typeof now === "number" ? now : 0;
    for (var i = 0; i < list.length; i++) {
      if (typeof list[i] !== "number") continue;
      if (clock < list[i]) continue;
      if (clock - list[i] < age) kept.push(list[i]);
    }
    return kept;
  }

  return {
    LOG_RETENTION_DAYS: LOG_RETENTION_DAYS,
    LOG_RETENTION_MS: LOG_RETENTION_MS,
    DELETE_CONFIRMATION: DELETE_CONFIRMATION,
    DELETION_ORDER: DELETION_ORDER,
    INVENTORY: INVENTORY,
    PROCESSORS: PROCESSORS,
    privacyNotice: NOTICE,
    aiDisclosure: AI_DISCLOSURE,
    pruneTimestamps: pruneTimestamps,
  };
});
