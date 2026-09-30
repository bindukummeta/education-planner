"use strict";
// Monthly cost model for 5,000 registered users.
// Usage figures are assumptions. Provider prices are never filled in here.
// Missing prices produce volumes and quota headroom, and a null cost.
const fs = require("fs");
const path = require("path");
const security = require("../api/security");

const SAMPLE_PATH = path.join(__dirname, "..", "ops", "cost-assumptions.sample.json");
const REGISTERED_USERS = 5000;
const QUOTA_DAYS = 30;
const ENDPOINTS = ["coach", "generate-practice", "analyse-homework"];

const PRICE_FIELDS = {
  anthropic: ["inputUsdPerMillionTokens", "outputUsdPerMillionTokens"],
  vercel: ["baseMonthlyUsd", "includedFunctionInvocations", "invocationOverageUsdPerMillion"],
  supabase: ["baseMonthlyUsd", "includedStorageGb", "storageOverageUsdPerGb"],
};

function fail(message) {
  const error = new Error(message);
  error.code = "invalid_model";
  return error;
}

function requiredNumber(value, name, min) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
    throw fail(name + " must be a number >= " + min);
  }
  return value;
}

function requiredInt(value, name, min) {
  const n = requiredNumber(value, name, min);
  if (!Number.isInteger(n)) throw fail(name + " must be an integer");
  return n;
}

function tokenCost(tokens, usdPerMillion) {
  return (tokens / 1000000) * usdPerMillion;
}

function readPrices(prices) {
  if (prices == null) return null;
  if (typeof prices !== "object" || Array.isArray(prices)) throw fail("prices must be an object or null");
  const providers = Object.keys(PRICE_FIELDS);
  const seen = Object.keys(prices);
  if (seen.length !== providers.length || providers.some((name) => seen.indexOf(name) === -1)) {
    throw fail("prices must include anthropic, vercel, and supabase, or be null");
  }
  const out = {};
  providers.forEach((provider) => {
    const src = prices[provider];
    if (!src || typeof src !== "object" || Array.isArray(src)) throw fail(provider + " prices are missing");
    const fields = PRICE_FIELDS[provider];
    const keys = Object.keys(src);
    if (keys.length !== fields.length || fields.some((name) => keys.indexOf(name) === -1)) {
      throw fail(provider + " prices must be exactly " + fields.join(", "));
    }
    out[provider] = {};
    fields.forEach((name) => {
      out[provider][name] = requiredNumber(src[name], provider + "." + name, 0);
    });
  });
  return out;
}

function evaluate(input) {
  const src = input && typeof input === "object" ? input : {};
  if (src.assumptionClass !== "non-pricing") throw fail("assumptionClass must be non-pricing");
  const registeredUsers = src.registeredUsers == null
    ? REGISTERED_USERS
    : requiredInt(src.registeredUsers, "registeredUsers", 1);
  const activeFamilyPercent = requiredNumber(src.activeFamilyPercent, "activeFamilyPercent", 0);
  if (activeFamilyPercent > 100) throw fail("activeFamilyPercent must be <= 100");
  const calls = src.callsPerActiveFamily || {};
  const tokens = src.tokens || {};
  ENDPOINTS.forEach((name) => {
    requiredInt(calls[name], "callsPerActiveFamily." + name, 0);
  });
  requiredInt(tokens.coach && tokens.coach.input, "tokens.coach.input", 0);
  requiredInt(tokens.coach && tokens.coach.output, "tokens.coach.output", 0);
  requiredInt(tokens["generate-practice"] && tokens["generate-practice"].input, "tokens.generate-practice.input", 0);
  requiredInt(tokens["generate-practice"] && tokens["generate-practice"].output, "tokens.generate-practice.output", 0);
  requiredInt(tokens["analyse-homework"] && tokens["analyse-homework"].inputPerPage, "tokens.analyse-homework.inputPerPage", 0);
  requiredInt(tokens["analyse-homework"] && tokens["analyse-homework"].output, "tokens.analyse-homework.output", 0);
  const pagesPerCall = requiredInt(src.homeworkPagesPerCall, "homeworkPagesPerCall", 0);
  const storageEach = requiredNumber(src.storageGbPerActiveFamily, "storageGbPerActiveFamily", 0);
  const probes = requiredInt(src.readinessProbesPerMonth, "readinessProbesPerMonth", 0);
  const prices = readPrices(src.prices);

  const activeFamilies = registeredUsers * (activeFamilyPercent / 100);
  const callCounts = {};
  ENDPOINTS.forEach((name) => {
    callCounts[name] = activeFamilies * calls[name];
  });
  const tokenCounts = {
    coachInput: callCounts.coach * tokens.coach.input,
    coachOutput: callCounts.coach * tokens.coach.output,
    practiceInput: callCounts["generate-practice"] * tokens["generate-practice"].input,
    practiceOutput: callCounts["generate-practice"] * tokens["generate-practice"].output,
    homeworkInput: callCounts["analyse-homework"] * pagesPerCall * tokens["analyse-homework"].inputPerPage,
    homeworkOutput: callCounts["analyse-homework"] * tokens["analyse-homework"].output,
  };
  const homeworkPages = callCounts["analyse-homework"] * pagesPerCall;
  const storageGb = activeFamilies * storageEach;
  const functionInvocations = callCounts.coach + callCounts["generate-practice"] + callCounts["analyse-homework"] + probes;

  const ceilings = {};
  const modelledPerFamily = {};
  let withinMonthlyCeiling = true;
  ENDPOINTS.forEach((name) => {
    const ceiling = security.DEFAULT_LIMITS[name].userPerDay * QUOTA_DAYS;
    ceilings[name] = ceiling;
    modelledPerFamily[name] = calls[name];
    if (calls[name] > ceiling) withinMonthlyCeiling = false;
  });

  const report = {
    assumptionClass: "non-pricing",
    pricesClass: prices ? "user-supplied" : "missing",
    pricesInvented: false,
    registeredUsers: registeredUsers,
    activeFamilyPercent: activeFamilyPercent,
    activeFamilies: activeFamilies,
    volumes: {
      calls: callCounts,
      homeworkPages: homeworkPages,
      tokens: tokenCounts,
      storageGb: storageGb,
      functionInvocations: functionInvocations,
      readinessProbes: probes,
    },
    unpricedNotes: [
      "Static hosting is not priced per request. It is treated as inside a user-supplied Vercel base fee. That is a non-pricing assumption.",
      "Supabase API requests are not priced per call. They are treated as inside a user-supplied Supabase base fee. That is a non-pricing assumption.",
    ],
    quota: {
      quotaDays: QUOTA_DAYS,
      assumptionClass: "non-pricing",
      betaAdmissionCap: security.BETA_ADMISSION_CAP,
      cohortMinDocumented: security.BETA_COHORT_MIN,
      registeredUsersAboveCap: Math.max(0, registeredUsers - security.BETA_ADMISSION_CAP),
      activeFamiliesAboveCap: Math.max(0, activeFamilies - security.BETA_ADMISSION_CAP),
      perFamilyMonthlyCeilings: ceilings,
      modelledCallsPerFamily: modelledPerFamily,
      withinMonthlyCeiling: withinMonthlyCeiling,
    },
    cost: null,
    breakEvenUsdPerActiveFamily: null,
  };

  if (!prices) return report;

  const anthropicUsd =
    tokenCost(tokenCounts.coachInput, prices.anthropic.inputUsdPerMillionTokens) +
    tokenCost(tokenCounts.coachOutput, prices.anthropic.outputUsdPerMillionTokens) +
    tokenCost(tokenCounts.practiceInput, prices.anthropic.inputUsdPerMillionTokens) +
    tokenCost(tokenCounts.practiceOutput, prices.anthropic.outputUsdPerMillionTokens) +
    tokenCost(tokenCounts.homeworkInput, prices.anthropic.inputUsdPerMillionTokens) +
    tokenCost(tokenCounts.homeworkOutput, prices.anthropic.outputUsdPerMillionTokens);
  const extraInvocations = Math.max(0, functionInvocations - prices.vercel.includedFunctionInvocations);
  const vercelUsd = prices.vercel.baseMonthlyUsd +
    tokenCost(extraInvocations, prices.vercel.invocationOverageUsdPerMillion);
  const extraGb = Math.max(0, storageGb - prices.supabase.includedStorageGb);
  const supabaseUsd = prices.supabase.baseMonthlyUsd + extraGb * prices.supabase.storageOverageUsdPerGb;
  const totalUsd = anthropicUsd + vercelUsd + supabaseUsd;
  report.cost = {
    pricesClass: "user-supplied",
    anthropicUsd: anthropicUsd,
    vercelUsd: vercelUsd,
    supabaseUsd: supabaseUsd,
    totalUsd: totalUsd,
    costPerActiveFamilyUsd: activeFamilies > 0 ? totalUsd / activeFamilies : null,
  };
  report.breakEvenUsdPerActiveFamily = report.cost.costPerActiveFamilyUsd;
  return report;
}

function readInput(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function main() {
  const args = process.argv.slice(2);
  const requirePrices = args.indexOf("--require-prices") !== -1;
  const filePath = args.filter((arg) => arg !== "--require-prices")[0] || SAMPLE_PATH;
  const report = evaluate(readInput(path.resolve(filePath)));
  if (requirePrices && !report.cost) {
    console.error("current provider prices were not supplied and were not invented");
    process.exit(2);
  }
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error("cost-model: " + (err && err.message ? err.message : "failed"));
    process.exit(1);
  }
}

module.exports = {
  evaluate: evaluate,
  SAMPLE_PATH: SAMPLE_PATH,
  REGISTERED_USERS: REGISTERED_USERS,
  QUOTA_DAYS: QUOTA_DAYS,
};
