"use strict";
// Prints a runbook path. It does not call Vercel, Supabase, or Anthropic.
// --apply and --execute always refuse: live changes need a credentialed operator.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const BOOKS = {
  deploy: "docs/runbooks/deployment.md",
  migrations: "docs/runbooks/migrations.md",
  rollback: "docs/runbooks/rollback.md",
  "key-rotation": "docs/runbooks/key-rotation.md",
  outages: "docs/runbooks/outages.md",
  "account-deletion": "docs/runbooks/account-deletion.md",
  "backup-restore": "docs/runbooks/backup-restore.md",
  "restore-drill": "docs/runbooks/restore-drill.md",
  "beta-admission": "docs/runbooks/beta-admission.md",
};

const args = process.argv.slice(2);
const name = args.filter((arg) => arg !== "--apply" && arg !== "--execute")[0];
const apply = args.indexOf("--apply") !== -1 || args.indexOf("--execute") !== -1;

if (!name) {
  console.log("Runbooks (read-only; this process does not call providers):");
  Object.keys(BOOKS).forEach((key) => {
    console.log("  " + key + "  " + BOOKS[key]);
  });
  process.exit(0);
}

if (!BOOKS[name]) {
  console.error("unknown runbook: " + name);
  process.exit(1);
}

const rel = BOOKS[name];
if (!fs.existsSync(path.join(ROOT, rel))) {
  console.error("missing runbook file: " + rel);
  process.exit(1);
}

if (apply) {
  console.error("EXTERNAL BLOCKER: refusing to apply " + name + ". No call was made to Vercel, Supabase, or Anthropic.");
  process.exit(2);
}

console.log(rel);
console.log("Read-only. No provider calls were made.");
