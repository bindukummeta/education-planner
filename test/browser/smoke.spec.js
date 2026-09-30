"use strict";

const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");

const STUB = fs.readFileSync(path.join(__dirname, "..", "fixtures", "supabase-stub.js"), "utf8");
const SW_SRC = fs.readFileSync(path.join(__dirname, "..", "..", "service-worker.js"), "utf8");
const CACHE_NAME = (SW_SRC.match(/const CACHE = "([^"]+)"/) || [])[1];
const ALLOWED_EXTERNAL = new Set(["cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com"]);
const USER_ID = "11111111-1111-4111-8111-111111111111";
const ADVICE = "Mocked study advice for smoke.";

async function installGuards(page, coachHits, externalHosts) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
      if (url.pathname === "/" || url.pathname === "/index.html") {
        const response = await route.fetch();
        const html = (await response.text()).replace(/\s+integrity="[^"]*"/g, "");
        await route.fulfill({
          status: response.status(),
          contentType: "text/html; charset=utf-8",
          body: html,
        });
        return;
      }
      if (url.pathname === "/api/coach") {
        coachHits.push({
          authorization: route.request().headers().authorization || "",
          body: route.request().postData() || "",
        });
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ advice: ADVICE }),
        });
        return;
      }
      await route.continue();
      return;
    }
    externalHosts.push(url.hostname);
    if (url.hostname === "cdn.jsdelivr.net") {
      await route.fulfill({
        status: 200,
        contentType: "application/javascript; charset=utf-8",
        body: STUB,
      });
      return;
    }
    if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
      await route.fulfill({ status: 200, contentType: "text/css; charset=utf-8", body: "" });
      return;
    }
    await route.fulfill({ status: 599, contentType: "text/plain; charset=utf-8", body: "blocked" });
  });
}

async function boot(page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.EduStore && window.EduSync && window.__eduSmoke);
  await expect(page.locator("#profile-name")).toHaveText("L");
  await expect(page.locator("h1")).toContainText("Education Planner");
}

async function signIn(page) {
  await page.locator(".tab[data-view='settings']").click();
  await page.locator("#sync-email").fill("parent@example.test");
  await page.locator("#sync-send-link").click();
  await expect(page.locator("#sync-status")).toContainText("6-digit");
  await page.locator("#sync-code").fill("123456");
  await page.locator("#sync-verify-code").click();
  await expect(page.locator("#sync-status")).toContainText("Signed in as parent@example.test");
  await expect(page.locator("#sync-pill-text")).toHaveText("Synced", { timeout: 15000 });
}

test.beforeEach(() => {
  test.skip(!CACHE_NAME, "service-worker.js has no CACHE name");
});

test("app shell loads without external API calls", async ({ page }) => {
  const coachHits = [];
  const externalHosts = [];
  await installGuards(page, coachHits, externalHosts);
  await boot(page);
  await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistrations()).length === 0);
  const shipped = await page.evaluate(async () => (await fetch("/sync-config.js", { cache: "no-store" })).text());
  expect(shipped).not.toContain("eyJ");
  expect(shipped).not.toContain("supabase.co");
  const bound = await page.evaluate(() => ({
    env: window.EDU_PUBLIC_ENV,
    url: window.EDU_SYNC_CONFIG && window.EDU_SYNC_CONFIG.url,
  }));
  expect(bound.env).toBe("local");
  expect(bound.url).toBe("https://example.supabase.co");
  expect(coachHits).toEqual([]);
  externalHosts.forEach((host) => expect(ALLOWED_EXTERNAL.has(host), host).toBe(true));
});

test("local app stays usable when public config is unavailable", async ({ page }) => {
  const externalHosts = [];
  await installGuards(page, [], externalHosts);
  await page.route("**/api/public-config", (route) => route.abort());
  await boot(page);
  await page.evaluate(async () => {
    await window.EduStore.setMeta("smoke.offline-config", "kept");
  });
  const state = await page.evaluate(async () => ({
    enabled: window.EduSync.getStatus().enabled,
    note: await window.EduStore.getMeta("smoke.offline-config"),
    reports: window.EDU_OBSERVABILITY && window.EDU_OBSERVABILITY.clientReports,
    env: window.EDU_PUBLIC_ENV,
    url: window.EDU_SYNC_CONFIG && window.EDU_SYNC_CONFIG.url,
  }));
  expect(state.enabled).toBe(false);
  expect(state.note).toBe("kept");
  expect(state.reports).toBe(false);
  expect(state.env).toBe("unconfigured");
  expect(state.url).toBe("");
  externalHosts.forEach((host) => expect(ALLOWED_EXTERNAL.has(host), host).toBe(true));
});

test("IndexedDB keeps a meta value and a school across reload", async ({ page }) => {
  const externalHosts = [];
  await installGuards(page, [], externalHosts);
  await boot(page);
  await page.evaluate(async () => {
    await window.EduStore.setMeta("smoke.note", "persisted-value");
    await window.EduStore.saveSchool({ id: "smoke-local-school", name: "Smoke Local School" });
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.EduStore);
  const saved = await page.evaluate(async () => {
    await window.EduStore.ready();
    const note = await window.EduStore.getMeta("smoke.note");
    const schools = await window.EduStore.getSchools();
    return { note: note, names: schools.map((row) => row.name) };
  });
  expect(saved.note).toBe("persisted-value");
  expect(saved.names).toContain("Smoke Local School");
  externalHosts.forEach((host) => expect(ALLOWED_EXTERNAL.has(host), host).toBe(true));
});

test("service worker serves the app shell while offline", async ({ page }) => {
  await page.goto("/test/browser/sw-harness.html", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__swReady === true || typeof window.__swError === "string");
  const swError = await page.evaluate(() => window.__swError || "");
  expect(swError, swError).toBe("");
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  await page.waitForFunction((name) => caches.has(name), CACHE_NAME);
  await page.context().setOffline(true);
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);
  await page.goto("/index.html", { waitUntil: "domcontentloaded" });
  await expect(page.locator("h1")).toContainText("Education Planner");
  const cached = await page.evaluate(async (name) => {
    const cache = await caches.open(name);
    const keys = await cache.keys();
    return keys.some((req) => req.url.indexOf("index.html") !== -1 || req.url.endsWith("/"));
  }, CACHE_NAME);
  expect(cached).toBe(true);
});

test("mocked Family Sync signs in and applies an owned remote row", async ({ page }) => {
  const externalHosts = [];
  await installGuards(page, [], externalHosts);
  await boot(page);
  await signIn(page);
  const sync = await page.evaluate(async () => {
    const schools = await window.EduStore.getSchools();
    return {
      names: schools.map((row) => row.name),
      owners: window.__eduSmoke.upserts.map((row) => row.owner),
      otp: window.__eduSmoke.otp.slice(),
    };
  });
  expect(sync.otp).toEqual(["parent@example.test"]);
  expect(sync.names).toContain("Smoke Remote School");
  expect(sync.owners.length).toBeGreaterThan(0);
  sync.owners.forEach((owner) => expect(owner).toBe(USER_ID));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.EduSync);
  await page.locator(".tab[data-view='settings']").click();
  await expect(page.locator("#sync-status")).toContainText("Signed in as parent@example.test");
  externalHosts.forEach((host) => expect(ALLOWED_EXTERNAL.has(host), host).toBe(true));
});

test("one authorized coach request uses the mock and not a provider", async ({ page }) => {
  const coachHits = [];
  const externalHosts = [];
  await installGuards(page, coachHits, externalHosts);
  await boot(page);
  await signIn(page);
  await page.evaluate(() => window.__eduApp.showView("coach"));
  await expect(page.locator("#view-coach")).toBeVisible();
  await expect(page.locator("#coach-consent-row")).toBeHidden();
  await expect(page.locator("#coach-run")).toBeDisabled();
  expect(coachHits).toEqual([]);
  await page.evaluate(async () => {
    await window.EduStore.setMeta("analyzer.enhancedAi.enabled", true);
  });
  await page.evaluate(() => window.__eduApp.showView("coach"));
  await expect(page.locator("#coach-consent-row")).toBeVisible();
  await expect(page.locator("#coach-run")).toBeDisabled();
  await page.locator("#coach-consent").check();
  await expect(page.locator("#coach-run")).toBeEnabled();
  await page.locator("#coach-run").click();
  await expect(page.locator("#coach-output")).toHaveText(ADVICE);
  expect(coachHits.length).toBe(1);
  expect(coachHits[0].authorization).toBe("Bearer aaaaaaaa.bbbbbbbb.cccccccc");
  expect(coachHits[0].body).toContain("\"snapshot\"");
  expect(coachHits[0].body).not.toContain("SMOK");
  await expect(page.locator("#coach-consent")).not.toBeChecked();
  externalHosts.forEach((host) => expect(ALLOWED_EXTERNAL.has(host), host).toBe(true));
});

test("settings privacy notice and cloud deletion stay confirmed and local", async ({ page }) => {
  const deletes = [];
  const externalHosts = [];
  await installGuards(page, [], externalHosts);
  await page.route("**/api/account-delete", async (route) => {
    deletes.push({
      authorization: route.request().headers().authorization || "",
      body: route.request().postData() || "",
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ deleted: true }),
    });
  });
  await boot(page);
  await page.locator(".tab[data-view='settings']").click();
  await expect(page.locator("#export-backup")).toBeVisible();
  await page.locator("#open-privacy-notice").click();
  await expect(page.locator("#privacy-panel")).toContainText("has not been checked by a lawyer");
  await expect(page.locator("#privacy-panel")).not.toContainText("lawyer has approved");
  await page.locator("#open-ai-disclosure").click();
  await expect(page.locator("#privacy-panel")).toContainText("starts off");
  await page.locator("#delete-cloud").click();
  await page.locator("#delete-confirm-text").fill("nope");
  await page.locator("#delete-confirm-check").check();
  await expect(page.locator("#delete-confirm-go")).toBeDisabled();
  expect(deletes).toEqual([]);
  await page.locator("#delete-confirm-cancel").click();
  await signIn(page);
  await page.locator("#delete-cloud").click();
  await page.locator("#delete-confirm-text").fill("DELETE MY CLOUD ACCOUNT");
  await page.locator("#delete-confirm-check").check();
  await page.locator("#delete-confirm-go").click();
  await expect(page.locator("#account-status")).toContainText("Data on this device is still here");
  expect(deletes.length).toBe(1);
  expect(deletes[0].authorization).toBe("Bearer aaaaaaaa.bbbbbbbb.cccccccc");
  expect(deletes[0].body).toContain("DELETE MY CLOUD ACCOUNT");
  expect(deletes[0].authorization).not.toContain("service-role");
  await expect(page.locator("#export-backup")).toBeVisible();
  externalHosts.forEach((host) => expect(ALLOWED_EXTERNAL.has(host), host).toBe(true));
});
