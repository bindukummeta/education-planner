(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const SETTINGS_KEY = "eduplanner.settings.v1";
  const SUBJECTS = ["vr", "nvr", "maths", "english"];
  const SUBJECT_LABEL = { vr: "VR", nvr: "NVR", maths: "Maths", english: "English" };
  const RECENT_N = 5;

  let activeSubject = "vr";
  let objectURLs = [];

  // ---- settings (localStorage) ----
  function loadSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; }
    catch (_) { return {}; }
  }
  function saveSettings(patch) {
    const next = Object.assign(loadSettings(), patch);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  }

  function revokeURLs() {
    objectURLs.forEach((u) => URL.revokeObjectURL(u));
    objectURLs = [];
  }
  function trackURL(u) { objectURLs.push(u); return u; }

  // ---- geocoding + distance (postcodes.io, no API key) ----
  const GEO_CACHE_PREFIX = "geo.";
  function normPostcode(pc) { return String(pc || "").toUpperCase().replace(/\s+/g, ""); }

  // Resolve a postcode to { lat, lon }. Cached in IndexedDB meta so the network
  // is hit at most once per postcode; returns null offline / when not found.
  async function geocode(postcode) {
    const key = normPostcode(postcode);
    if (!key) return null;
    const cached = await EduStore.getMeta(GEO_CACHE_PREFIX + key);
    if (cached) return cached;
    try {
      const res = await fetch("https://api.postcodes.io/postcodes/" + encodeURIComponent(key));
      if (!res.ok) return null;
      const data = await res.json();
      const r = data && data.result;
      if (!r || r.latitude == null || r.longitude == null) return null;
      const coord = { lat: r.latitude, lon: r.longitude };
      await EduStore.setMeta(GEO_CACHE_PREFIX + key, coord);
      return coord;
    } catch (_) { return null; }
  }

  // Great-circle distance in miles (Haversine).
  function haversineMiles(a, b) {
    const R = 3958.8;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  }

  function todayISO() { return new Date().toISOString().slice(0, 10); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  // Compact label for the Rank chip: pull the leading rank (e.g. "National 5")
  // out of the long seeded sentence when it starts with a rank; otherwise keep
  // the user's text (possibly clipped by CSS). Full text is the chip's tooltip.
  function shortRank(text) {
    const s = String(text || "").trim();
    const m = s.match(/^(?:national\s+|no\.?\s*|#)?(\d+)\b/i);
    return m ? "National " + m[1] : s;
  }

  // ---- view switching ----
  function showView(name) {
    ["schools", "log", "progress"].forEach((v) => {
      $("view-" + v).classList.toggle("hidden", v !== name);
    });
    document.querySelectorAll(".tab").forEach((t) => {
      t.classList.toggle("active", t.dataset.view === name);
    });
    if (name === "log") renderEntries();
    if (name === "progress") renderProgress();
  }

  // ============ SCHOOLS ============
  // Straight-line miles from the home postcode to a school's postcode.
  // Computed live (no manual value) — blank until a home postcode is set and
  // both postcodes geocode successfully.
  async function distanceMiles(school, homeCoord) {
    if (homeCoord && school.postcode) {
      const c = await geocode(school.postcode);
      if (c) return haversineMiles(homeCoord, c);
    }
    return null;
  }

  async function renderSchools() {
    const list = $("schools-list");
    const schools = await EduStore.getSchools();
    if (!schools.length) {
      list.innerHTML = '<p class="empty">No schools yet. Tap “+ Add school”.</p>';
      return;
    }
    const homeCoord = await geocode(loadSettings().homePostcode);
    // Compute each school's distance once, then order nearest-first. Schools
    // with no computable distance (no home postcode set, or offline/geocode
    // failed) sort to the end, keeping alphabetical order among ties.
    const items = [];
    for (const s of schools) {
      const mi = await distanceMiles(s, homeCoord);
      items.push({ school: s, miles: mi });
    }
    items.sort((a, b) => {
      const am = a.miles == null ? Infinity : a.miles;
      const bm = b.miles == null ? Infinity : b.miles;
      if (am !== bm) return am - bm;
      return (a.school.name || "").localeCompare(b.school.name || "");
    });
    list.innerHTML = "";
    for (const it of items) {
      const s = it.school;
      const cut = latestCutoff(s);
      const tested = testedSubjects(s).map((k) => SUBJECT_LABEL[k]).join(", ") || "—";
      const dist = it.miles == null ? "" : it.miles.toFixed(1) + " mi";
      const card = document.createElement("div");
      card.className = "school-card";
      // Exam/results are exact per-cycle dates the user confirms; show "TBC"
      // (to be confirmed) when blank rather than hiding the row.
      const examVal = s.examDate ? esc(s.examDate) : "TBC";
      const resultsVal = s.resultsDate ? esc(s.resultsDate) : "TBC";
      card.innerHTML =
        "<h3>" + esc(s.name) + "</h3>" +
        '<div class="school-meta">' +
        (dist ? "<span><b>Distance:</b> " + esc(dist) + "</span>" : "") +
        (s.nationalRanking ? '<span title="' + esc(s.nationalRanking) + '"><b>Rank:</b> ' + esc(shortRank(s.nationalRanking)) + "</span>" : "") +
        (s.examBoard ? "<span><b>Board:</b> " + esc(s.examBoard) + "</span>" : "") +
        "<span><b>Exam:</b> " + examVal + "</span>" +
        "<span><b>Results:</b> " + resultsVal + "</span>" +
        (cut != null ? "<span><b>Cut-off:</b> " + cut + "%</span>" : "") +
        "<span><b>Tests:</b> " + esc(tested) + "</span>" +
        "</div>";
      card.addEventListener("click", () => openSchoolForm(s));
      // One-tap link to the school's official site to re-check dates. Stop the
      // click bubbling so it opens the site rather than the edit form.
      if (s.website) {
        const link = document.createElement("a");
        link.className = "school-link";
        link.href = s.website;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "Check school site ↗";
        link.addEventListener("click", (ev) => ev.stopPropagation());
        card.appendChild(link);
      }
      list.appendChild(card);
    }
  }

  function testedSubjects(s) {
    const t = s.testsSubjects || {};
    return SUBJECTS.filter((k) => t[k]);
  }
  function latestCutoff(s) {
    const cuts = (s.historicCutoffs || []).filter((c) => c && c.score !== "" && c.score != null);
    if (!cuts.length) return null;
    cuts.sort((a, b) => String(b.year).localeCompare(String(a.year)));
    const v = Number(cuts[0].score);
    return isNaN(v) ? null : v;
  }

  function addCutoffRow(year, score) {
    const wrap = $("cutoffs-list");
    const row = document.createElement("div");
    row.className = "cutoff-row";
    row.innerHTML =
      '<input class="cutoff-year" placeholder="Year e.g. 2025" value="' + esc(year || "") + '" />' +
      '<input class="cutoff-score" type="number" min="0" max="100" placeholder="Score %" value="' + esc(score == null ? "" : score) + '" />' +
      '<button type="button" class="remove-cutoff" aria-label="Remove">✕</button>';
    row.querySelector(".remove-cutoff").addEventListener("click", () => row.remove());
    wrap.appendChild(row);
  }

  function openSchoolForm(school) {
    const wrap = $("school-form-wrap");
    wrap.classList.remove("hidden");
    $("school-form-title").textContent = school ? "Edit school" : "Add school";
    $("school-id").value = school ? school.id : "";
    $("f-name").value = school ? school.name || "" : "";
    $("f-postcode").value = school ? school.postcode || "" : "";
    $("f-ranking").value = school ? school.nationalRanking || "" : "";
    $("f-pan").value = school ? school.pan || "" : "";
    $("f-examboard").value = school ? school.examBoard || "" : "";
    $("f-registration").value = school ? school.registration || "" : "";
    $("f-exam").value = school ? school.examDate || "" : "";
    $("f-results").value = school ? school.resultsDate || "" : "";
    $("f-subjects").value = school ? school.subjectsSummary || "" : "";
    const t = (school && school.testsSubjects) || {};
    $("f-vr").checked = !!t.vr; $("f-nvr").checked = !!t.nvr;
    $("f-maths").checked = !!t.maths; $("f-english").checked = !!t.english;
    $("f-creative").checked = !!t.creativeWriting;
    $("f-catchment").value = school ? school.catchment || "" : "";
    $("f-admissions").value = school ? school.admissionNumbers || "" : "";
    $("f-openday").value = school ? school.openDay || "" : "";
    $("f-website").value = school ? school.website || "" : "";
    $("f-notes").value = school ? school.notes || "" : "";
    $("cutoffs-list").innerHTML = "";
    const cuts = (school && school.historicCutoffs) || [];
    if (cuts.length) cuts.forEach((c) => addCutoffRow(c.year, c.score));
    else addCutoffRow("", "");
    $("delete-school").classList.toggle("hidden", !school);
    wrap.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function closeSchoolForm() {
    $("school-form").reset();
    $("school-form-wrap").classList.add("hidden");
  }

  async function submitSchool(e) {
    e.preventDefault();
    const cutoffs = [];
    document.querySelectorAll("#cutoffs-list .cutoff-row").forEach((row) => {
      const year = row.querySelector(".cutoff-year").value.trim();
      const score = row.querySelector(".cutoff-score").value.trim();
      if (year || score) cutoffs.push({ year: year, score: score === "" ? "" : Number(score) });
    });
    const school = {
      id: $("school-id").value || undefined,
      name: $("f-name").value.trim(),
      postcode: $("f-postcode").value.trim(),
      nationalRanking: $("f-ranking").value.trim(),
      pan: $("f-pan").value.trim(),
      examBoard: $("f-examboard").value,
      registration: $("f-registration").value.trim(),
      examDate: $("f-exam").value,
      resultsDate: $("f-results").value,
      subjectsSummary: $("f-subjects").value.trim(),
      testsSubjects: {
        vr: $("f-vr").checked, nvr: $("f-nvr").checked, maths: $("f-maths").checked,
        english: $("f-english").checked, creativeWriting: $("f-creative").checked,
      },
      catchment: $("f-catchment").value.trim(),
      admissionNumbers: $("f-admissions").value.trim(),
      historicCutoffs: cutoffs,
      openDay: $("f-openday").value.trim(),
      website: $("f-website").value.trim(),
      notes: $("f-notes").value.trim(),
    };
    if (!school.name) return;
    await EduStore.saveSchool(school);
    closeSchoolForm();
    renderSchools();
  }

  async function removeSchool() {
    const id = $("school-id").value;
    if (!id) return;
    if (!confirm("Delete this school?")) return;
    await EduStore.deleteSchool(id);
    closeSchoolForm();
    renderSchools();
  }

  // ============ DAILY LOG ============
  function derivedPct() {
    const raw = Number($("e-raw").value);
    const max = Number($("e-max").value);
    if (!max || max <= 0 || isNaN(raw)) return null;
    return Math.round((raw / max) * 100);
  }
  function updatePctPreview() {
    const pct = derivedPct();
    $("e-pct").textContent = pct == null ? "—" : pct + "%";
  }

  // Compress an image to keep on-device storage small. Never lose an entry:
  // on any failure fall back to the original file.
  function compressImage(file, maxDim, quality) {
    maxDim = maxDim || 1600;
    quality = quality || 0.7;
    return new Promise((resolve) => {
      const done = (blob) => resolve(blob || file);
      const draw = (bmp, w, h) => {
        try {
          const scale = Math.min(1, maxDim / Math.max(w, h));
          const cw = Math.round(w * scale), ch = Math.round(h * scale);
          const canvas = document.createElement("canvas");
          canvas.width = cw; canvas.height = ch;
          canvas.getContext("2d").drawImage(bmp, 0, 0, cw, ch);
          canvas.toBlob((b) => done(b), "image/jpeg", quality);
        } catch (_) { done(file); }
      };
      if (window.createImageBitmap) {
        createImageBitmap(file).then((bmp) => draw(bmp, bmp.width, bmp.height)).catch(() => done(file));
      } else {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => { draw(img, img.naturalWidth, img.naturalHeight); URL.revokeObjectURL(url); };
        img.onerror = () => { URL.revokeObjectURL(url); done(file); };
        img.src = url;
      }
    });
  }

  async function submitEntry(e) {
    e.preventDefault();
    const pct = derivedPct();
    const subject = $("e-subject").value;
    const entry = {
      date: $("e-date").value || todayISO(),
      subject: subject,
      scoreRaw: $("e-raw").value === "" ? null : Number($("e-raw").value),
      scoreMax: $("e-max").value === "" ? null : Number($("e-max").value),
      scorePct: pct,
      note: $("e-note").value.trim(),
      blobId: null,
    };
    const file = $("e-image").files[0];
    if (file) {
      const blob = await compressImage(file);
      entry.blobId = await EduStore.putBlob(blob, "image/jpeg");
    }
    await EduStore.addEntry(entry);
    saveSettings({ lastSubject: subject });
    $("entry-form").reset();
    $("e-date").value = todayISO();
    $("e-subject").value = subject;
    updatePctPreview();
    renderEntries();
  }

  async function renderEntries() {
    revokeURLs();
    const list = $("entries-list");
    const entries = (await EduStore.getEntries()).slice().reverse();
    if (!entries.length) {
      list.innerHTML = '<p class="empty">No entries yet. Log her first piece of work above.</p>';
      return;
    }
    list.innerHTML = "";
    for (const en of entries) {
      const row = document.createElement("div");
      row.className = "entry-row";
      let thumb = '<div class="thumb"></div>';
      if (en.blobId) {
        const b = await EduStore.getBlob(en.blobId);
        if (b && b.blob) thumb = '<img class="thumb" src="' + trackURL(URL.createObjectURL(b.blob)) + '" alt="work" />';
      }
      const badge = en.scorePct == null ? "" :
        '<span class="score-badge">' + (en.scoreRaw != null && en.scoreMax != null ? en.scoreRaw + "/" + en.scoreMax + " · " : "") + en.scorePct + "%</span>";
      row.innerHTML =
        thumb +
        '<div class="entry-body"><div class="entry-top">' +
        '<span class="entry-subj">' + esc(SUBJECT_LABEL[en.subject] || en.subject) + "</span>" +
        '<span class="entry-date">' + esc(en.date) + "</span>" + badge + "</div>" +
        (en.note ? '<p class="entry-note">' + esc(en.note) + "</p>" : "") +
        "</div>" +
        '<button class="entry-del" aria-label="Delete">🗑</button>';
      row.querySelector(".entry-del").addEventListener("click", async () => {
        if (!confirm("Delete this entry?")) return;
        await EduStore.deleteEntry(en.id);
        renderEntries();
      });
      list.appendChild(row);
    }
  }

  // ============ PROGRESS ============
  function renderSubjectChips() {
    const wrap = $("subject-chips");
    wrap.innerHTML = "";
    SUBJECTS.forEach((s) => {
      const chip = document.createElement("button");
      chip.className = "chip" + (s === activeSubject ? " active" : "");
      chip.textContent = SUBJECT_LABEL[s];
      chip.addEventListener("click", () => { activeSubject = s; renderProgress(); });
      wrap.appendChild(chip);
    });
  }

  async function renderProgress() {
    renderSubjectChips();
    const entries = await EduStore.getEntries({ subject: activeSubject });
    const points = entries.filter((e) => e.scorePct != null).map((e) => ({ date: e.date, pct: e.scorePct }));
    drawLineChart($("chart"), points);
    await renderReadiness();
  }

  function drawLineChart(canvas, points) {
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 640, cssH = 260;
    canvas.width = cssW * dpr; canvas.height = cssH * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const css = getComputedStyle(document.documentElement);
    const border = css.getPropertyValue("--border").trim() || "#e6ecf5";
    const muted = css.getPropertyValue("--muted").trim() || "#7b8aa6";
    const accent = css.getPropertyValue("--accent").trim() || "#ffb020";
    const pad = 32, plotW = cssW - pad * 2, plotH = cssH - pad * 2;
    ctx.font = "11px -apple-system, sans-serif";
    ctx.textBaseline = "middle";
    [0, 25, 50, 75, 100].forEach((g) => {
      const y = pad + plotH - (g / 100) * plotH;
      ctx.strokeStyle = border; ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(pad + plotW, y); ctx.stroke();
      ctx.fillStyle = muted; ctx.textAlign = "right"; ctx.fillText(g + "%", pad - 6, y);
    });
    if (!points.length) {
      ctx.fillStyle = muted; ctx.textAlign = "center";
      ctx.fillText("No entries yet", cssW / 2, cssH / 2);
      return;
    }
    const n = points.length;
    const x = (i) => n === 1 ? pad + plotW / 2 : pad + (i / (n - 1)) * plotW;
    const y = (pct) => pad + plotH - (pct / 100) * plotH;
    if (n > 1) {
      ctx.strokeStyle = accent; ctx.lineWidth = 2.5; ctx.beginPath();
      points.forEach((p, i) => { const px = x(i), py = y(p.pct); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
      ctx.stroke();
    }
    ctx.fillStyle = accent;
    points.forEach((p, i) => { ctx.beginPath(); ctx.arc(x(i), y(p.pct), 4, 0, Math.PI * 2); ctx.fill(); });
    const last = points[n - 1];
    ctx.fillStyle = css.getPropertyValue("--text").trim() || "#1f2740";
    ctx.textAlign = "center";
    ctx.fillText(last.pct + "%", x(n - 1), y(last.pct) - 12);
  }

  async function subjectRecentAvg(subject) {
    const entries = (await EduStore.getEntries({ subject: subject })).filter((e) => e.scorePct != null);
    if (!entries.length) return null;
    const recent = entries.slice(-RECENT_N);
    return recent.reduce((a, e) => a + e.scorePct, 0) / recent.length;
  }

  async function renderReadiness() {
    const list = $("readiness-list");
    const schools = await EduStore.getSchools();
    if (!schools.length) {
      list.innerHTML = '<p class="empty">Add a school to see readiness.</p>';
      return;
    }
    const avgCache = {};
    for (const s of SUBJECTS) avgCache[s] = await subjectRecentAvg(s);

    const rows = [];
    for (const s of schools) {
      const tested = testedSubjects(s);
      const cutoff = latestCutoff(s);
      let rag = "rag-none", label = "", detail = "", sortGap = -Infinity;
      if (!tested.length) { label = "No subjects set"; }
      else if (cutoff == null) { label = "No cut-off recorded"; }
      else {
        const have = tested.filter((t) => avgCache[t] != null);
        if (!have.length) { label = "Not enough data yet"; }
        else {
          const recentPct = have.reduce((a, t) => a + avgCache[t], 0) / have.length;
          const gap = recentPct - cutoff;
          sortGap = gap;
          const g = Math.abs(Math.round(gap));
          if (gap >= 0) { rag = "rag-green"; label = "On track (+" + Math.round(gap) + ")"; }
          else if (gap >= -10) { rag = "rag-amber"; label = "Close (" + g + " below)"; }
          else { rag = "rag-red"; label = "Needs work (" + g + " below)"; }
          detail = "Recent avg " + Math.round(recentPct) + "% vs cut-off " + cutoff + "%" +
            (have.length < tested.length ? " · partial data" : "");
        }
      }
      rows.push({ name: s.name, rag, label, detail, sortGap });
    }
    rows.sort((a, b) => b.sortGap - a.sortGap);
    list.innerHTML = "";
    rows.forEach((r) => {
      const div = document.createElement("div");
      div.className = "readiness-row";
      div.innerHTML =
        '<div class="readiness-body"><div class="readiness-name">' + esc(r.name) + "</div>" +
        (r.detail ? '<div class="readiness-detail">' + esc(r.detail) + "</div>" : "") + "</div>" +
        '<span class="rag ' + r.rag + '">' + esc(r.label) + "</span>";
      list.appendChild(div);
    });
  }

  // ============ BACKUP ============
  async function exportBackup() {
    const payload = await EduStore.exportAll();
    const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "education-planner-backup-" + todayISO() + ".json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function importBackup(file) {
    if (!file) return;
    if (!confirm("Importing replaces ALL current data. Continue?")) { $("import-backup").value = ""; return; }
    const fr = new FileReader();
    fr.onload = async () => {
      try {
        await EduStore.importAll(JSON.parse(fr.result));
        alert("Backup restored.");
        renderSchools(); renderEntries(); renderProgress();
      } catch (err) { alert("Could not import: " + err.message); }
      $("import-backup").value = "";
    };
    fr.readAsText(file);
  }

  // ---- home postcode ----
  async function saveHomePostcode() {
    const pc = $("f-home-postcode").value.trim();
    saveSettings({ homePostcode: pc });
    const hint = $("postcode-hint");
    if (!pc) { hint.textContent = "Cleared. Distances will show your typed values only."; renderSchools(); return; }
    hint.textContent = "Looking up…";
    const coord = await geocode(pc);
    hint.textContent = coord
      ? "Saved. Distances updated below."
      : "Saved, but couldn't look up that postcode (check it, or you may be offline).";
    renderSchools();
  }

  // ---- reset schools to the built-in presets ----
  async function resetToSeed() {
    if (!window.SchoolsSeed) return;
    if (!confirm("Replace the current school list with the preset schools? Your daily log and photos are kept.")) return;
    const hint = $("reseed-hint");
    hint.textContent = "Resetting…";
    try {
      await window.SchoolsSeed.reseed();
      hint.textContent = "Done — school list reset to presets.";
    } catch (_) {
      hint.textContent = "Couldn't reset the school list.";
    }
    renderSchools();
  }

  // ============ INIT ============
  async function init() {
    await EduStore.ready();
    if (window.SchoolsSeed) {
      try { await window.SchoolsSeed.seedIfEmpty(); } catch (_) {}
      // Non-destructively refresh preset schools' factual fields (ranking,
      // subjects, registration…) when the seed data has been updated. Keeps
      // the user's own edits, cut-offs, dates, log and photos.
      try { await window.SchoolsSeed.migrate(); } catch (_) {}
    }
    const settings = loadSettings();
    activeSubject = SUBJECTS.indexOf(settings.lastSubject) >= 0 ? settings.lastSubject : "vr";
    $("f-home-postcode").value = settings.homePostcode || "";

    document.querySelectorAll(".tab").forEach((t) =>
      t.addEventListener("click", () => showView(t.dataset.view)));
    $("save-home-postcode").addEventListener("click", saveHomePostcode);
    $("reset-seed").addEventListener("click", resetToSeed);
    $("add-school").addEventListener("click", () => openSchoolForm(null));
    $("cancel-school").addEventListener("click", closeSchoolForm);
    $("delete-school").addEventListener("click", removeSchool);
    $("add-cutoff").addEventListener("click", () => addCutoffRow("", ""));
    $("school-form").addEventListener("submit", submitSchool);
    $("entry-form").addEventListener("submit", submitEntry);
    $("e-raw").addEventListener("input", updatePctPreview);
    $("e-max").addEventListener("input", updatePctPreview);
    $("export-backup").addEventListener("click", exportBackup);
    $("import-backup").addEventListener("change", (e) => importBackup(e.target.files[0]));

    $("e-date").value = todayISO();
    $("e-subject").value = activeSubject;
    showView("schools");
    renderSchools();
  }

  document.addEventListener("DOMContentLoaded", init);

  window.__eduApp = { showView, renderSchools, openSchoolForm };
})();
