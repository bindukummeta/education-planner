(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const SETTINGS_KEY = "eduplanner.settings.v1";
  const SUBJECTS = ["vr", "nvr", "maths", "english", "creativeWriting"];
  const SUBJECT_LABEL = { vr: "VR", nvr: "NVR", maths: "Maths", english: "English", creativeWriting: "Creative Writing" };
  const RECENT_N = 5;
  const DIFFICULTY_LABEL = { easy: "Easy", medium: "Medium", hard: "Hard" };
  const DIFFICULTY_ORDER = { easy: 1, medium: 2, hard: 3 };
  function difficultyOrdinal(d) { return DIFFICULTY_ORDER[d] || null; }
  function normDifficulty(d) { return DIFFICULTY_ORDER[d] ? d : ""; }

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
  const VIEW_KEYS = [
    "dashboard", "schools", "log", "homework", "reading",
    "mocks", "progress", "coach", "calendar", "settings",
  ];
  const VIEW_RENDER = {
    dashboard: () => renderDashboard(),
    log: () => renderEntries(),
    homework: () => renderHomework(),
    reading: () => renderReading(),
    mocks: () => renderMocks(),
    progress: () => renderProgress(),
    coach: () => prepareCoach(),
    calendar: () => renderCalendar(),
    settings: () => renderSettings(),
  };
  function showView(name) {
    if (VIEW_KEYS.indexOf(name) < 0) name = "dashboard";
    VIEW_KEYS.forEach((v) => {
      const el = $("view-" + v);
      if (el) el.classList.toggle("hidden", v !== name);
    });
    document.querySelectorAll(".nav-item").forEach((t) => {
      t.classList.toggle("active", t.dataset.view === name);
    });
    closeDrawer();
    if (VIEW_RENDER[name]) VIEW_RENDER[name]();
  }

  // ---- drawer ----
  function openDrawer() {
    $("drawer").classList.add("open");
    $("drawer").setAttribute("aria-hidden", "false");
    $("drawer-backdrop").classList.remove("hidden");
    $("menu-btn").setAttribute("aria-expanded", "true");
    const first = document.querySelector(".nav-item");
    if (first) first.focus();
  }
  function closeDrawer() {
    const d = $("drawer");
    if (!d) return;
    d.classList.remove("open");
    d.setAttribute("aria-hidden", "true");
    $("drawer-backdrop").classList.add("hidden");
    $("menu-btn").setAttribute("aria-expanded", "false");
  }
  function toggleDrawer() {
    if ($("drawer").classList.contains("open")) { closeDrawer(); $("menu-btn").focus(); }
    else openDrawer();
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
        (s.targetDifficulty ? "<span><b>Level:</b> " + esc(DIFFICULTY_LABEL[s.targetDifficulty] || s.targetDifficulty) + "</span>" : "") +
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
    $("f-difficulty").value = (school && school.targetDifficulty) || "";
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
      targetDifficulty: $("f-difficulty").value || "",
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
    const difficulty = normDifficulty($("e-difficulty").value);
    const entry = {
      date: $("e-date").value || todayISO(),
      subject: subject,
      topic: $("e-topic").value.trim(),
      difficulty: difficulty,
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
    saveSettings({ lastSubject: subject, lastDifficulty: difficulty });
    $("entry-form").reset();
    $("e-date").value = todayISO();
    $("e-subject").value = subject;
    $("e-difficulty").value = difficulty;
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
      const diffChip = en.difficulty ?
        '<span class="entry-diff diff-' + esc(en.difficulty) + '">' + esc(DIFFICULTY_LABEL[en.difficulty] || en.difficulty) + "</span>" : "";
      const topicChip = en.topic ? '<p class="entry-topic">' + esc(en.topic) + "</p>" : "";
      row.innerHTML =
        thumb +
        '<div class="entry-body"><div class="entry-top">' +
        '<span class="entry-subj">' + esc(SUBJECT_LABEL[en.subject] || en.subject) + "</span>" +
        '<span class="entry-date">' + esc(en.date) + "</span>" + badge + diffChip + "</div>" +
        topicChip +
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

  // Recent-average for a subject at (or above) a difficulty floor. Entries
  // whose tagged difficulty ordinal is >= floorOrd count; untagged entries
  // always count (backward-compatible) but are flagged so the UI can note the
  // average mixes levels. floorOrd 0/null means "any difficulty" (all count).
  // Returns { avg, usedUntagged } from the most recent RECENT_N matches, or
  // null when nothing matches.
  async function subjectRecentAvg(subject, floorOrd) {
    const scored = (await EduStore.getEntries({ subject: subject })).filter((e) => e.scorePct != null);
    if (!scored.length) return null;
    const floor = floorOrd || 0;
    const matched = scored.filter((e) => {
      const ord = difficultyOrdinal(e.difficulty);
      return ord == null ? true : ord >= floor;
    });
    if (!matched.length) return null;
    const recent = matched.slice(-RECENT_N);
    const usedUntagged = recent.some((e) => difficultyOrdinal(e.difficulty) == null);
    return { avg: recent.reduce((a, e) => a + e.scorePct, 0) / recent.length, usedUntagged: usedUntagged };
  }

  // Pure-ish readiness computation shared by Progress and Dashboard. Returns a
  // sorted array of { name, rag, label, detail, sortGap } (empty if no schools).
  async function computeReadiness() {
    const schools = await EduStore.getSchools();
    if (!schools.length) return [];
    // Memoise per (subject, difficulty-floor) so each band is computed once.
    const bandCache = {};
    async function bandAvg(subject, floorOrd) {
      const key = subject + "|" + (floorOrd || 0);
      if (!(key in bandCache)) bandCache[key] = await subjectRecentAvg(subject, floorOrd);
      return bandCache[key];
    }

    const rows = [];
    for (const s of schools) {
      const tested = testedSubjects(s);
      const cutoff = latestCutoff(s);
      // The school's target difficulty sets the floor: work must be at that
      // level (or harder) to demonstrate readiness. No target => any level.
      const floorOrd = difficultyOrdinal(s.targetDifficulty) || 0;
      let rag = "rag-none", label = "", detail = "", sortGap = -Infinity;
      if (!tested.length) { label = "No subjects set"; }
      else if (cutoff == null) { label = "No cut-off recorded"; }
      else {
        const results = [];
        for (const t of tested) {
          const r = await bandAvg(t, floorOrd);
          if (r != null) results.push(r);
        }
        if (!results.length) {
          label = floorOrd ? "No " + DIFFICULTY_LABEL[s.targetDifficulty] + "-level data yet" : "Not enough data yet";
        } else {
          const recentPct = results.reduce((a, r) => a + r.avg, 0) / results.length;
          const gap = recentPct - cutoff;
          sortGap = gap;
          const g = Math.abs(Math.round(gap));
          if (gap >= 0) { rag = "rag-green"; label = "On track (+" + Math.round(gap) + ")"; }
          else if (gap >= -10) { rag = "rag-amber"; label = "Close (" + g + " below)"; }
          else { rag = "rag-red"; label = "Needs work (" + g + " below)"; }
          const mixedLevels = floorOrd && results.some((r) => r.usedUntagged);
          detail = "Recent avg " + Math.round(recentPct) + "% vs cut-off " + cutoff + "%" +
            (floorOrd ? " · at " + DIFFICULTY_LABEL[s.targetDifficulty] + " level" : "") +
            (results.length < tested.length ? " · partial data" : "") +
            (mixedLevels ? " · mixed levels" : "");
        }
      }
      rows.push({ name: s.name, rag, label, detail, sortGap });
    }
    rows.sort((a, b) => b.sortGap - a.sortGap);
    return rows;
  }

  async function renderReadiness() {
    const list = $("readiness-list");
    const rows = await computeReadiness();
    if (!rows.length) {
      list.innerHTML = '<p class="empty">Add a school to see readiness.</p>';
      return;
    }
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
        renderHomework(); renderReading(); renderMocks();
        renderCalendar(); renderDashboard();
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

  // ============ DASHBOARD ============
  function daysBetween(fromISO, toISO) {
    const a = new Date(fromISO + "T00:00:00");
    const b = new Date(toISO + "T00:00:00");
    return Math.round((b - a) / 86400000);
  }
  async function renderDashboard() {
    const today = todayISO();
    // Next-exam countdown from the soonest future school exam date.
    const schools = await EduStore.getSchools();
    const upcoming = schools
      .filter((s) => s.examDate && s.examDate >= today)
      .sort((a, b) => (a.examDate < b.examDate ? -1 : 1));
    const cd = $("dash-countdown");
    if (upcoming.length) {
      const n = daysBetween(today, upcoming[0].examDate);
      cd.innerHTML = '<div class="stat-num">' + n + '</div><div class="stat-label">days to ' +
        esc(upcoming[0].name) + " exam</div>";
    } else {
      cd.innerHTML = '<div class="stat-num">—</div><div class="stat-label">no upcoming exam date set</div>';
    }

    // Study streak: consecutive days ending today with ≥1 logged entry.
    const entries = await EduStore.getEntries();
    const dates = new Set(entries.map((e) => e.date));
    let streak = 0;
    let cur = new Date(today + "T00:00:00");
    while (dates.has(cur.toISOString().slice(0, 10))) {
      streak++;
      cur.setDate(cur.getDate() - 1);
    }
    $("dash-streak").innerHTML = '<div class="stat-num">' + streak +
      '</div><div class="stat-label">day streak</div>';

    // RAG snapshot.
    const rows = await computeReadiness();
    const rag = $("dash-rag");
    if (!rows.length) {
      rag.innerHTML = '<p class="empty">Add a school to see readiness.</p>';
    } else {
      const counts = { "rag-green": 0, "rag-amber": 0, "rag-red": 0, "rag-none": 0 };
      rows.forEach((r) => { counts[r.rag] = (counts[r.rag] || 0) + 1; });
      rag.innerHTML =
        '<div class="rag-summary">' +
        '<span class="rag rag-green">' + counts["rag-green"] + " on track</span>" +
        '<span class="rag rag-amber">' + counts["rag-amber"] + " close</span>" +
        '<span class="rag rag-red">' + counts["rag-red"] + " needs work</span>" +
        "</div>";
    }

    // Homework due today (not done).
    const hw = (await EduStore.getHomework({ done: 0 })).filter((h) => h.dueDate === today);
    const hwEl = $("dash-homework");
    if (!hw.length) {
      hwEl.innerHTML = '<p class="empty">Nothing due today. 🎉</p>';
    } else {
      hwEl.innerHTML = hw.map((h) =>
        '<div class="dash-line">' + esc(h.title) +
        (h.subject ? ' <span class="chip">' + esc(SUBJECT_LABEL[h.subject] || h.subject) + "</span>" : "") +
        "</div>").join("");
    }

    // Recent reading + mocks (last 3 each).
    const reading = (await EduStore.getReading()).slice(0, 3);
    const mocks = (await EduStore.getMocks()).slice(0, 3);
    const rec = $("dash-recent");
    let html = "";
    if (reading.length) {
      html += '<div class="dash-subhead">📚 Reading</div>' + reading.map((r) =>
        '<div class="dash-line">' + esc(r.title) + " · " + esc(r.date) + "</div>").join("");
    }
    if (mocks.length) {
      html += '<div class="dash-subhead">📝 Mocks</div>' + mocks.map((m) =>
        '<div class="dash-line">' + esc(SUBJECT_LABEL[m.subject] || m.subject) +
        (m.scorePct != null ? " · " + m.scorePct + "%" : "") + " · " + esc(m.date) + "</div>").join("");
    }
    rec.innerHTML = html || '<p class="empty">No reading or mocks logged yet.</p>';
  }

  // ============ HOMEWORK ============
  async function submitHomework(e) {
    e.preventDefault();
    const title = $("h-title").value.trim();
    if (!title) return;
    await EduStore.addHomework({
      title: title,
      subject: $("h-subject").value,
      dueDate: $("h-due").value || "",
      difficulty: normDifficulty($("h-difficulty").value),
      notes: $("h-notes").value.trim(),
    });
    $("homework-form").reset();
    renderHomework();
  }
  function hwRowHTML(h) {
    const subj = h.subject ? '<span class="chip">' + esc(SUBJECT_LABEL[h.subject] || h.subject) + "</span>" : "";
    const diff = h.difficulty ? '<span class="entry-diff diff-' + esc(h.difficulty) + '">' + esc(DIFFICULTY_LABEL[h.difficulty] || h.difficulty) + "</span>" : "";
    const due = h.dueDate ? '<span class="entry-date">due ' + esc(h.dueDate) + "</span>" : "";
    return '<div class="hw-body"><label class="hw-check"><input type="checkbox"' + (h.done ? " checked" : "") + " /></label>" +
      '<div class="hw-main"><div class="hw-top' + (h.done ? " hw-done" : "") + '">' + esc(h.title) + "</div>" +
      '<div class="hw-meta">' + due + subj + diff + "</div>" +
      (h.notes ? '<p class="entry-note">' + esc(h.notes) + "</p>" : "") + "</div>" +
      '<button class="entry-del" aria-label="Delete">🗑</button></div>';
  }
  function makeHwRow(h) {
    const row = document.createElement("div");
    row.className = "hw-row" + (h.done ? " hw-row-done" : "");
    row.innerHTML = hwRowHTML(h);
    row.querySelector('input[type="checkbox"]').addEventListener("change", async (ev) => {
      const done = ev.target.checked ? 1 : 0;
      await EduStore.updateHomework(h.id, { done: done, doneAt: done ? Date.now() : null });
      renderHomework();
    });
    row.querySelector(".entry-del").addEventListener("click", async () => {
      if (!confirm("Delete this homework?")) return;
      await EduStore.deleteHomework(h.id);
      renderHomework();
    });
    return row;
  }
  async function renderHomework() {
    const list = $("homework-list");
    const all = await EduStore.getHomework();
    if (!all.length) {
      list.innerHTML = '<p class="empty">No homework yet. Add a task above.</p>';
      return;
    }
    const today = todayISO();
    const overdue = all.filter((h) => !h.done && h.dueDate && h.dueDate < today);
    const due = all.filter((h) => !h.done && (!h.dueDate || h.dueDate >= today));
    const done = all.filter((h) => h.done);
    list.innerHTML = "";
    const section = (label, rows, cls) => {
      if (!rows.length) return;
      const head = document.createElement("h2");
      head.className = "section-heading" + (cls ? " " + cls : "");
      head.textContent = label + " (" + rows.length + ")";
      list.appendChild(head);
      rows.forEach((h) => list.appendChild(makeHwRow(h)));
    };
    section("Overdue", overdue, "hw-overdue");
    section("To do", due);
    section("Done", done);
  }

  // ============ READING ============
  async function submitReading(e) {
    e.preventDefault();
    const title = $("r-title").value.trim();
    if (!title) return;
    await EduStore.addReading({
      title: title,
      author: $("r-author").value.trim(),
      date: $("r-date").value || todayISO(),
      minutes: $("r-minutes").value === "" ? null : Number($("r-minutes").value),
      pages: $("r-pages").value === "" ? null : Number($("r-pages").value),
      note: $("r-note").value.trim(),
    });
    $("reading-form").reset();
    $("r-date").value = todayISO();
    renderReading();
  }
  async function renderReading() {
    const totals = $("reading-totals");
    const list = $("reading-list");
    const all = await EduStore.getReading();
    // This-week minutes (last 7 days) + distinct book count.
    const weekAgo = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
    const weekMin = all.filter((r) => r.date >= weekAgo)
      .reduce((a, r) => a + (r.minutes || 0), 0);
    const books = new Set(all.map((r) => (r.title || "").toLowerCase())).size;
    totals.innerHTML =
      '<div class="totals"><div class="stat-tile"><div class="stat-num">' + weekMin +
      '</div><div class="stat-label">minutes this week</div></div>' +
      '<div class="stat-tile"><div class="stat-num">' + books +
      '</div><div class="stat-label">books logged</div></div></div>';
    if (!all.length) {
      list.innerHTML = '<p class="empty">No reading logged yet.</p>';
      return;
    }
    list.innerHTML = "";
    all.forEach((r) => {
      const row = document.createElement("div");
      row.className = "entry-row";
      const meta = [
        r.author ? esc(r.author) : "",
        r.minutes != null ? r.minutes + " min" : "",
        r.pages != null ? r.pages + " pp" : "",
      ].filter(Boolean).join(" · ");
      row.innerHTML =
        '<div class="entry-body"><div class="entry-top">' +
        '<span class="entry-subj">' + esc(r.title) + "</span>" +
        '<span class="entry-date">' + esc(r.date) + "</span></div>" +
        (meta ? '<p class="entry-topic">' + meta + "</p>" : "") +
        (r.note ? '<p class="entry-note">' + esc(r.note) + "</p>" : "") + "</div>" +
        '<button class="entry-del" aria-label="Delete">🗑</button>';
      row.querySelector(".entry-del").addEventListener("click", async () => {
        if (!confirm("Delete this reading entry?")) return;
        await EduStore.deleteReading(r.id);
        renderReading();
      });
      list.appendChild(row);
    });
  }

  // ============ MOCK PAPERS ============
  function updateMockPct() {
    const raw = $("m-raw").value, max = $("m-max").value;
    const pct = raw !== "" && max !== "" && Number(max) > 0
      ? Math.round((Number(raw) / Number(max)) * 100) : null;
    $("mock-pct").textContent = pct == null ? "—" : pct + "%";
  }
  async function submitMock(e) {
    e.preventDefault();
    const raw = $("m-raw").value, max = $("m-max").value;
    const pct = raw !== "" && max !== "" && Number(max) > 0
      ? Math.round((Number(raw) / Number(max)) * 100) : null;
    let blobId = null;
    const file = $("m-image").files[0];
    if (file) {
      try { blobId = await EduStore.putBlob(await compressImage(file), "image/jpeg"); }
      catch (_) { blobId = null; }
    }
    await EduStore.addMocks({
      subject: $("m-subject").value,
      date: $("m-date").value || todayISO(),
      paperName: $("m-paper").value.trim(),
      source: $("m-source").value.trim(),
      scoreRaw: raw === "" ? null : Number(raw),
      scoreMax: max === "" ? null : Number(max),
      scorePct: pct,
      minutes: $("m-minutes").value === "" ? null : Number($("m-minutes").value),
      difficulty: normDifficulty($("m-difficulty").value),
      blobId: blobId,
      note: $("m-note").value.trim(),
    });
    $("mock-form").reset();
    $("m-date").value = todayISO();
    updateMockPct();
    renderMocks();
  }
  async function renderMocks() {
    revokeURLs();
    const list = $("mock-list");
    const all = await EduStore.getMocks();
    if (!all.length) {
      list.innerHTML = '<p class="empty">No mock papers logged yet.</p>';
      return;
    }
    list.innerHTML = "";
    for (const m of all) {
      const row = document.createElement("div");
      row.className = "entry-row";
      let thumb = '<div class="thumb"></div>';
      if (m.blobId) {
        const b = await EduStore.getBlob(m.blobId);
        if (b && b.blob) thumb = '<img class="thumb" src="' + trackURL(URL.createObjectURL(b.blob)) + '" alt="mock" />';
      }
      const badge = m.scorePct == null ? "" :
        '<span class="score-badge">' + (m.scoreRaw != null && m.scoreMax != null ? m.scoreRaw + "/" + m.scoreMax + " · " : "") + m.scorePct + "%</span>";
      const diffChip = m.difficulty ?
        '<span class="entry-diff diff-' + esc(m.difficulty) + '">' + esc(DIFFICULTY_LABEL[m.difficulty] || m.difficulty) + "</span>" : "";
      const paper = [m.paperName, m.source].filter(Boolean).map(esc).join(" · ");
      const mins = m.minutes != null ? '<p class="entry-note">' + m.minutes + " min taken</p>" : "";
      row.innerHTML =
        thumb +
        '<div class="entry-body"><div class="entry-top">' +
        '<span class="entry-subj">' + esc(SUBJECT_LABEL[m.subject] || m.subject) + "</span>" +
        '<span class="entry-date">' + esc(m.date) + "</span>" + badge + diffChip + "</div>" +
        (paper ? '<p class="entry-topic">' + paper + "</p>" : "") +
        mins +
        (m.note ? '<p class="entry-note">' + esc(m.note) + "</p>" : "") + "</div>" +
        '<button class="entry-del" aria-label="Delete">🗑</button>';
      row.querySelector(".entry-del").addEventListener("click", async () => {
        if (!confirm("Delete this mock?")) return;
        await EduStore.deleteMocks(m.id);
        renderMocks();
      });
      list.appendChild(row);
    }
  }

  // ============ CALENDAR ============
  const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  let calYear = new Date().getFullYear();
  let calMonth = new Date().getMonth(); // 0-11
  let calSelected = null;

  // 42-cell grid (6 weeks, Mon-first). Leading/trailing blanks are null.
  function buildMonthGrid(y, m) {
    const first = new Date(y, m, 1);
    const lead = (first.getDay() + 6) % 7; // convert Sun-first(0) to Mon-first(0)
    const daysIn = new Date(y, m + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push(null);
    for (let d = 1; d <= daysIn; d++) cells.push(d);
    while (cells.length < 42) cells.push(null);
    return cells;
  }

  // Merge all dated items for a given month into { "yyyy-mm-dd": [ {type,label} ] }.
  async function collectCalendarItems(y, m) {
    const mm = String(m + 1).padStart(2, "0");
    const prefix = y + "-" + mm;
    const map = {};
    const add = (date, type, label) => {
      if (!date || date.slice(0, 7) !== prefix) return;
      (map[date] = map[date] || []).push({ type, label });
    };
    (await EduStore.getSchools()).forEach((s) => {
      add(s.examDate, "exam", s.name + " exam");
      add(s.resultsDate, "results", s.name + " results");
    });
    (await EduStore.getHomework()).forEach((h) => add(h.dueDate, "homework", h.title));
    (await EduStore.getMocks()).forEach((m2) => add(m2.date, "mock", (SUBJECT_LABEL[m2.subject] || m2.subject) + " mock"));
    (await EduStore.getEvents()).forEach((ev) => add(ev.date, ev.type || "custom", ev.title));
    return map;
  }

  async function renderCalendar() {
    $("cal-title").textContent = MONTH_NAMES[calMonth] + " " + calYear;
    const cells = buildMonthGrid(calYear, calMonth);
    const items = await collectCalendarItems(calYear, calMonth);
    const today = todayISO();
    const mm = String(calMonth + 1).padStart(2, "0");
    const grid = $("cal-grid");
    grid.innerHTML = "";
    ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].forEach((d) => {
      const h = document.createElement("div");
      h.className = "cal-dow";
      h.textContent = d;
      grid.appendChild(h);
    });
    cells.forEach((d) => {
      const cell = document.createElement("div");
      if (d == null) { cell.className = "cal-cell cal-empty"; grid.appendChild(cell); return; }
      const date = calYear + "-" + mm + "-" + String(d).padStart(2, "0");
      cell.className = "cal-cell";
      if (date === today) cell.classList.add("cal-today");
      if (date === calSelected) cell.classList.add("cal-selected");
      const dayItems = items[date] || [];
      const dots = dayItems.slice(0, 4).map((it) =>
        '<span class="cal-dot cal-dot-' + esc(it.type) + '"></span>').join("");
      cell.innerHTML = '<span class="cal-num">' + d + "</span><span class=\"cal-dots\">" + dots + "</span>";
      cell.addEventListener("click", () => { calSelected = date; renderCalendar(); });
      grid.appendChild(cell);
    });

    const detail = $("cal-day-detail");
    if (!calSelected || calSelected.slice(0, 7) !== calYear + "-" + mm) {
      detail.innerHTML = '<p class="hint">Tap a day to see what\'s on.</p>';
    } else {
      const list = items[calSelected] || [];
      detail.innerHTML = "<h2>" + esc(calSelected) + "</h2>" +
        (list.length
          ? list.map((it) => '<div class="dash-line"><span class="cal-dot cal-dot-' + esc(it.type) +
              '"></span> ' + esc(it.label) + "</div>").join("")
          : '<p class="empty">Nothing on this day.</p>');
    }
  }
  function calShift(delta) {
    calMonth += delta;
    if (calMonth < 0) { calMonth = 11; calYear--; }
    else if (calMonth > 11) { calMonth = 0; calYear++; }
    renderCalendar();
  }

  // ============ AI COACH ============
  function prepareCoach() {
    // Reflect connectivity when the view is opened; don't auto-call the API.
    const status = $("coach-status");
    if (!navigator.onLine) {
      status.textContent = "You're offline — connect to the internet to get advice.";
    } else if (!status.textContent) {
      status.textContent = "";
    }
  }
  async function buildCoachSnapshot() {
    // Per-subject recent averages (any level) + best-available band.
    const subjects = [];
    for (const s of SUBJECTS) {
      const r = await subjectRecentAvg(s, 0);
      if (r != null) subjects.push({ subject: SUBJECT_LABEL[s], recentAvg: Math.round(r.avg) });
    }
    // Per-school readiness rows (already derived, no raw data).
    const rows = await computeReadiness();
    const schools = rows.map((r) => ({ name: r.name, status: r.label, detail: r.detail }));
    // Reading + mock summaries.
    const reading = await EduStore.getReading();
    const weekAgo = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
    const weekMinutes = reading.filter((r) => r.date >= weekAgo).reduce((a, r) => a + (r.minutes || 0), 0);
    const books = new Set(reading.map((r) => (r.title || "").toLowerCase())).size;
    const mocks = (await EduStore.getMocks()).slice(0, 5).map((m) => ({
      subject: SUBJECT_LABEL[m.subject] || m.subject, pct: m.scorePct, date: m.date,
    }));
    return { subjects, schools, reading: { weekMinutes, books }, mocks };
  }
  async function runCoach() {
    const status = $("coach-status");
    const out = $("coach-output");
    if (!navigator.onLine) {
      status.textContent = "You're offline — connect to the internet to get advice.";
      return;
    }
    status.innerHTML = '<span class="spinner"></span> Thinking…';
    out.innerHTML = "";
    $("coach-run").disabled = true;
    try {
      const snapshot = await buildCoachSnapshot();
      const res = await fetch("/api/coach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ snapshot }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
      status.textContent = "";
      out.textContent = data.advice || "No advice returned.";
    } catch (err) {
      status.textContent = "Couldn't get advice: " + err.message;
    } finally {
      $("coach-run").disabled = false;
    }
  }

  // ============ SETTINGS ============
  function renderSettings() {
    const el = $("app-version");
    if (el) el.textContent = "Education Planner · offline-first PWA";
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

    document.querySelectorAll(".nav-item").forEach((t) =>
      t.addEventListener("click", () => showView(t.dataset.view)));
    document.querySelectorAll("[data-goto]").forEach((b) =>
      b.addEventListener("click", () => showView(b.dataset.goto)));
    $("menu-btn").addEventListener("click", toggleDrawer);
    $("drawer-backdrop").addEventListener("click", closeDrawer);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && $("drawer").classList.contains("open")) {
        closeDrawer(); $("menu-btn").focus();
      }
    });
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
    $("homework-form").addEventListener("submit", submitHomework);
    $("reading-form").addEventListener("submit", submitReading);
    $("mock-form").addEventListener("submit", submitMock);
    $("m-raw").addEventListener("input", updateMockPct);
    $("m-max").addEventListener("input", updateMockPct);
    $("cal-prev").addEventListener("click", () => calShift(-1));
    $("cal-next").addEventListener("click", () => calShift(1));
    $("coach-run").addEventListener("click", runCoach);
    $("export-backup").addEventListener("click", exportBackup);
    $("import-backup").addEventListener("change", (e) => importBackup(e.target.files[0]));

    $("e-date").value = todayISO();
    $("e-subject").value = activeSubject;
    $("e-difficulty").value = normDifficulty(settings.lastDifficulty);
    $("h-due").value = todayISO();
    $("r-date").value = todayISO();
    $("m-date").value = todayISO();
    renderSchools();
    showView("dashboard");
  }

  document.addEventListener("DOMContentLoaded", init);

  window.__eduApp = { showView, renderSchools, openSchoolForm };
})();
