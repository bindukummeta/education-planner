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
    "mocks", "playcreate", "curiosity", "analyzer", "progress", "coach", "calendar", "settings",
  ];
  const VIEW_RENDER = {
    dashboard: () => renderDashboard(),
    log: () => renderEntries(),
    homework: () => renderHomework(),
    reading: () => renderReading(),
    mocks: () => renderMocks(),
    playcreate: () => renderPlayCreate(),
    curiosity: () => renderCuriosity(),
    analyzer: () => renderAnalyzer(),
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
    const g = $("dash-greeting");
    if (g) {
      const h = new Date().getHours();
      const part = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
      g.textContent = part + "! Ready to learn today? 🌟";
    }
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

  // ============ PLAY & CREATE ============
  const PLAY_GAMES = [
    { title: "Vocabulary Quest",      icon: "📖", difficulty: "Easy",   minutes: 10, skillSubject: "vr",             skillsText: "Builds the vocabulary that powers verbal reasoning." },
    { title: "Times Table Sprint",    icon: "✖️", difficulty: "Medium", minutes: 5,  skillSubject: "maths",          skillsText: "Fast recall of times tables for mental maths." },
    { title: "Pattern Detective",     icon: "🧩", difficulty: "Medium", minutes: 12, skillSubject: "nvr",            skillsText: "Spot sequences and shapes — core non-verbal reasoning." },
    { title: "Spelling Wizard",       icon: "🔤", difficulty: "Easy",   minutes: 8,  skillSubject: "english",        skillsText: "Tricky spellings, one spell at a time." },
    { title: "Reading Treasure Hunt", icon: "🗺️", difficulty: "Hard",   minutes: 15, skillSubject: "english",        skillsText: "Comprehension clues hidden in a story." },
    { title: "Grammar Challenge",     icon: "✍️", difficulty: "Medium", minutes: 10, skillSubject: "creativeWriting", skillsText: "Punctuation and sentence power-ups for great writing." },
  ];
  const CREATE_CATEGORIES = [
    { title: "Roblox Studio",       icon: "🟥", description: "Design your own game world.",     tool: "Roblox Studio" },
    { title: "Scratch",            icon: "🐱", description: "Snap blocks together to code.",   tool: "Scratch" },
    { title: "Coding Projects",     icon: "💻", description: "Build an app or website idea.",   tool: "Code" },
    { title: "Story Writing",       icon: "📚", description: "Write and illustrate a story.",   tool: "Writing" },
    { title: "Art & Crafts",        icon: "🎨", description: "Make something with your hands.",  tool: "Art" },
    { title: "Science Experiments", icon: "🔬", description: "Try a safe home experiment.",     tool: "Science" },
  ];

  // Vocabulary Quest word bank (11+ level). A word's own definition is the correct
  // answer; distractors are drawn from OTHER words' definitions, so every option is
  // a real, plausible meaning. Definitions are unique so a distractor never matches
  // the answer. Self-contained for easy extraction/testing.
  const VOCAB_WORDS = [
    { word: "abundant",     definition: "existing in very large quantities; plentiful" },
    { word: "brisk",        definition: "quick, active and energetic" },
    { word: "candid",       definition: "honest and direct in what you say" },
    { word: "diligent",     definition: "showing careful and steady hard work" },
    { word: "elated",       definition: "extremely happy and excited" },
    { word: "feeble",       definition: "lacking strength; weak" },
    { word: "gracious",     definition: "kind, polite and pleasant to others" },
    { word: "hostile",      definition: "unfriendly and ready to argue or fight" },
    { word: "immense",      definition: "extremely large in size or amount" },
    { word: "jovial",       definition: "cheerful and full of good humour" },
    { word: "keen",         definition: "very eager or enthusiastic" },
    { word: "lenient",      definition: "gentle and not strict when punishing" },
    { word: "meagre",       definition: "very small in amount; not enough" },
    { word: "novel",        definition: "new, original and different" },
    { word: "obscure",      definition: "not well known or hard to understand" },
    { word: "placid",       definition: "calm and peaceful, not easily upset" },
    { word: "quaint",       definition: "attractively old-fashioned or unusual" },
    { word: "reluctant",    definition: "unwilling and hesitant to do something" },
    { word: "scarce",       definition: "hard to find because there is very little" },
    { word: "timid",        definition: "shy and easily frightened" },
    { word: "utter",        definition: "complete or total, without exception" },
    { word: "vivid",        definition: "very bright, clear and lifelike" },
    { word: "wary",         definition: "careful and cautious about danger" },
    { word: "zealous",      definition: "showing great energy and passion for a cause" },
  ];

  // Each real game maps its PLAY_GAMES title to a launcher; others fall back to the
  // "coming soon" placeholder. Function declarations are hoisted, so order is fine.
  const GAME_LAUNCHERS = { "Vocabulary Quest": openVocabQuest };

  // ---- focus quest (encouraging framing — NEVER "weakest subject") ----
  // Internally we still find the lowest recent average (reusing subjectRecentAvg,
  // the same pipeline as Progress/Readiness), but the CHILD only ever sees
  // adventurous, positive phrasing. Returns { subject, label } or null when there
  // is no scored data yet.
  async function focusSubject() {
    let worst = null;
    for (const s of SUBJECTS) {
      const r = await subjectRecentAvg(s, 0);
      if (r == null) continue;
      if (worst == null || r.avg < worst.avg) {
        worst = { subject: s, label: SUBJECT_LABEL[s] };
      }
    }
    return worst;
  }

  // Encouraging, kid-safe phrases. `{s}` is replaced with the subject label.
  // NOTE: no negative words ("weak", "worst", "bad") anywhere.
  const FOCUS_PHRASES = [
    "🎯 Your focus this week",
    "🚀 Ready to strengthen {s}?",
    "🗺️ Your next skill quest",
    "✨ {s} could use a little boost",
    "🌟 Recommended adventure",
  ];
  // Session-stable pick: the phrase index is chosen once per page load and cached
  // on window, so re-renders within a session don't reshuffle the wording.
  function focusPhrase(subjectLabel) {
    if (window.__focusPhraseIdx == null) {
      window.__focusPhraseIdx = Math.floor(Math.random() * FOCUS_PHRASES.length);
    }
    return FOCUS_PHRASES[window.__focusPhraseIdx].replace("{s}", subjectLabel || "this skill");
  }

  async function renderPlayCreate() {
    // ---- PLAY ----
    const focus = await focusSubject();
    const focusText = focus ? focusPhrase(focus.label) : "";
    const playGrid = $("pc-play-grid");
    playGrid.innerHTML = "";
    PLAY_GAMES.forEach((g) => {
      const isFocus = focus && g.skillSubject === focus.subject;
      const skillLabel = SUBJECT_LABEL[g.skillSubject] || g.skillSubject;
      const card = document.createElement("div");
      card.className = "pc-card";
      card.innerHTML =
        '<div class="pc-ico">' + g.icon + "</div>" +
        '<div class="pc-title">' + esc(g.title) + "</div>" +
        '<div class="pc-meta">' + esc(g.difficulty) + " · " + g.minutes + " min</div>" +
        '<div class="pc-tags">' +
        (isFocus
          ? '<span class="chip pc-focus">' + esc(focusText) + "</span>"
          : '<span class="chip">' + esc(skillLabel) + "</span>") +
        "</div>";
      const btn = document.createElement("button");
      btn.className = "btn-primary";
      btn.textContent = "▶ Play";
      const launcher = GAME_LAUNCHERS[g.title];
      btn.addEventListener("click", () =>
        launcher ? launcher(g) :
        openModal(g.title,
          "<p>" + esc(g.skillsText) + "</p>" +
          '<p class="hint">This game will be available soon. Check back after the next update!</p>'));
      card.appendChild(btn);
      playGrid.appendChild(card);
    });

    // ---- CREATE ----
    const createGrid = $("pc-create-grid");
    createGrid.innerHTML = "";
    CREATE_CATEGORIES.forEach((c) => {
      const card = document.createElement("div");
      card.className = "pc-card";
      card.innerHTML =
        '<div class="pc-ico">' + c.icon + "</div>" +
        '<div class="pc-title">' + esc(c.title) + "</div>" +
        '<div class="pc-meta">' + esc(c.description) + "</div>";
      const btn = document.createElement("button");
      btn.className = "btn-primary";
      btn.textContent = "✎ Start a project";
      btn.addEventListener("click", () => openStartProject(c));
      card.appendChild(btn);
      createGrid.appendChild(card);
    });

    // ---- MY PROJECTS ----
    await renderProjects();
  }

  // CREATE "start" modal: a tiny form that creates a real in-app project.
  function openStartProject(category) {
    const html =
      '<form id="project-form">' +
      '<div class="field"><label for="p-name">Project name</label>' +
      '<input id="p-name" value="' + esc(category.title + " project") + '" /></div>' +
      '<div class="field"><label for="p-skills">Skills (comma separated, optional)</label>' +
      '<input id="p-skills" placeholder="e.g. coding, design" /></div>' +
      '<div class="form-actions"><button type="submit" class="btn-primary">Create</button></div>' +
      "</form>";
    openModal("Start: " + category.title, html);
    $("project-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = $("p-name").value.trim() || category.title + " project";
      const skills = $("p-skills").value.split(",").map((s) => s.trim()).filter(Boolean);
      const now = Date.now();
      await EduStore.addProject({
        name: name, category: category.title, tool: category.tool,
        status: "in_progress", skills: skills, note: "",
        // Reflection + self-ratings start empty; captured later via "Reflect".
        reflection: { proudOf: "", challenge: "", nextStep: "" },
        confidence: null, enjoyment: null,
        createdAt: now, updatedAt: now,
      });
      closeModal();
      renderPlayCreate();
    });
  }

  // My Projects list — mirrors renderReading's list+delete pattern exactly.
  async function renderProjects() {
    const list = $("pc-projects");
    const projects = await EduStore.getProjects(); // already sorted updatedAt desc
    if (!projects.length) {
      list.innerHTML = '<p class="empty">No projects yet — pick something in Create above and start building! 🚀</p>';
      return;
    }
    list.innerHTML = "";
    projects.forEach((r) => {
      const done = r.status === "completed";
      const statusCls = done ? "pc-status-done" : "pc-status-progress";
      const statusText = done ? "✓ Completed" : "● In Progress";
      const updated = new Date(r.updatedAt || r.createdAt || Date.now()).toISOString().slice(0, 10);
      const skills = (r.skills || []).map((s) => '<span class="chip">' + esc(s) + "</span>").join("");
      // Show a gentle indicator once the child has reflected on the project.
      const ref = r.reflection || {};
      const hasReflected = !!(ref.proudOf || ref.challenge || ref.nextStep) ||
        r.confidence != null || r.enjoyment != null;
      const reflectChip = hasReflected ? '<span class="chip pc-reflected">📝 Reflected</span>' : "";
      const row = document.createElement("div");
      row.className = "pc-card pc-project";
      row.innerHTML =
        '<div class="pc-title">' + esc(r.name) + "</div>" +
        '<div class="pc-meta">' + esc(r.category) + (r.tool ? " · " + esc(r.tool) : "") + "</div>" +
        '<div class="pc-tags"><span class="pc-status ' + statusCls + '">' + statusText + "</span>" + reflectChip + skills + "</div>" +
        '<div class="pc-meta">Updated ' + esc(updated) + "</div>";
      // Status chip toggles status in place.
      row.querySelector(".pc-status").addEventListener("click", async () => {
        await EduStore.updateProject(r.id, { status: done ? "in_progress" : "completed" });
        renderPlayCreate();
      });
      const actions = document.createElement("div");
      actions.className = "form-actions";
      const open = document.createElement("button");
      open.className = "btn-secondary";
      open.textContent = "Open";
      open.addEventListener("click", () => openProjectDetail(r));
      // Dedicated "Reflect" button (per the reflection requirement).
      const reflect = document.createElement("button");
      reflect.className = "btn-secondary";
      reflect.textContent = "📝 Reflect";
      reflect.addEventListener("click", () => openProjectReflect(r));
      const del = document.createElement("button");
      del.className = "entry-del";
      del.setAttribute("aria-label", "Delete");
      del.textContent = "🗑";
      del.addEventListener("click", async () => {
        if (!confirm("Delete this project?")) return;
        await EduStore.deleteProject(r.id);
        renderPlayCreate();
      });
      actions.appendChild(open);
      actions.appendChild(reflect);
      actions.appendChild(del);
      row.appendChild(actions);
      list.appendChild(row);
    });
  }

  // Project detail modal: mark complete/reopen + add a skill + view reflection.
  function openProjectDetail(r) {
    const done = r.status === "completed";
    const skills = (r.skills || []).map((s) => '<span class="chip">' + esc(s) + "</span>").join("")
      || '<span class="hint">No skills tagged yet.</span>';
    // Read-only summary of any captured reflection (edited via the Reflect button).
    const ref = r.reflection || {};
    const rating = (v) => (v == null ? "—" : "⭐".repeat(v));
    let reflectionBlock = "";
    if (ref.proudOf || ref.challenge || ref.nextStep || r.confidence != null || r.enjoyment != null) {
      reflectionBlock =
        '<div class="pc-reflect-summary">' +
        (ref.proudOf ? '<p><strong>Proud of:</strong> ' + esc(ref.proudOf) + "</p>" : "") +
        (ref.challenge ? '<p><strong>Was difficult:</strong> ' + esc(ref.challenge) + "</p>" : "") +
        (ref.nextStep ? '<p><strong>Will try next:</strong> ' + esc(ref.nextStep) + "</p>" : "") +
        '<p class="pc-meta">Confidence: ' + rating(r.confidence) + " · Enjoyment: " + rating(r.enjoyment) + "</p>" +
        "</div>";
    }
    const html =
      '<div class="pc-meta">' + esc(r.category) + (r.tool ? " · " + esc(r.tool) : "") + "</div>" +
      '<div class="pc-tags">' + skills + "</div>" +
      reflectionBlock +
      '<div class="field"><label for="p-add-skill">Add a skill</label>' +
      '<input id="p-add-skill" placeholder="e.g. animation" /></div>' +
      '<div class="form-actions">' +
      '<button type="button" id="p-toggle" class="btn-primary">' + (done ? "Reopen" : "Mark complete") + "</button>" +
      '<button type="button" id="p-reflect-btn" class="btn-secondary">📝 Reflect</button>' +
      '<button type="button" id="p-add-skill-btn" class="btn-secondary">Add skill</button>' +
      "</div>";
    openModal(r.name, html);
    $("p-toggle").addEventListener("click", async () => {
      await EduStore.updateProject(r.id, { status: done ? "in_progress" : "completed" });
      closeModal();
      renderPlayCreate();
    });
    $("p-reflect-btn").addEventListener("click", () => openProjectReflect(r));
    $("p-add-skill-btn").addEventListener("click", async () => {
      const v = $("p-add-skill").value.trim();
      if (!v) return;
      await EduStore.updateProject(r.id, { skills: (r.skills || []).concat([v]) });
      closeModal();
      renderPlayCreate();
    });
  }

  // Reflection modal (dedicated "Reflect" flow). Captures the three qualitative
  // prompts + two 1..5 self-ratings. All fields optional; kid-friendly wording.
  function openProjectReflect(r) {
    const ref = r.reflection || {};
    const sel = (v, n) => 'value="' + n + '"' + (v === n ? " selected" : "");
    const ratingSelect = (id, label, cur) =>
      '<div class="field"><label for="' + id + '">' + label + "</label>" +
      '<select id="' + id + '">' +
      '<option value="" ' + (cur == null ? "selected" : "") + ">—</option>" +
      "<option " + sel(cur, 1) + ">1</option><option " + sel(cur, 2) + ">2</option>" +
      "<option " + sel(cur, 3) + ">3</option><option " + sel(cur, 4) + ">4</option>" +
      "<option " + sel(cur, 5) + ">5</option></select></div>";
    const html =
      '<form id="reflect-form">' +
      '<div class="field"><label for="r-proud">What are you proud of? 🌟</label>' +
      '<textarea id="r-proud" rows="2">' + esc(ref.proudOf || "") + "</textarea></div>" +
      '<div class="field"><label for="r-challenge">What was difficult? 🤔</label>' +
      '<textarea id="r-challenge" rows="2">' + esc(ref.challenge || "") + "</textarea></div>" +
      '<div class="field"><label for="r-next">What will you try next? 🚀</label>' +
      '<textarea id="r-next" rows="2">' + esc(ref.nextStep || "") + "</textarea></div>" +
      ratingSelect("r-confidence", "How confident do you feel? (1–5)", r.confidence) +
      ratingSelect("r-enjoyment", "How much did you enjoy it? (1–5)", r.enjoyment) +
      '<div class="form-actions"><button type="submit" class="btn-primary">Save reflection</button></div>' +
      "</form>";
    openModal("Reflect: " + r.name, html);
    const numOrNull = (v) => (v === "" ? null : Number(v));
    $("reflect-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      await EduStore.updateProject(r.id, {
        reflection: {
          proudOf: $("r-proud").value.trim(),
          challenge: $("r-challenge").value.trim(),
          nextStep: $("r-next").value.trim(),
        },
        confidence: numOrNull($("r-confidence").value),
        enjoyment: numOrNull($("r-enjoyment").value),
      });
      closeModal();
      renderPlayCreate();
    });
  }

  // ---- reusable modal (no existing dialog component; mirrors drawer a11y) ----
  function openModal(title, bodyHTML) {
    $("modal-title").textContent = title;
    $("modal-body").innerHTML = bodyHTML;
    $("modal").classList.remove("hidden");
    $("modal").setAttribute("aria-hidden", "false");
    $("modal-close").focus();
  }
  function closeModal() {
    const m = $("modal");
    if (!m) return;
    m.classList.add("hidden");
    m.setAttribute("aria-hidden", "true");
  }
  // ---- Vocabulary Quest game ----
  const VOCAB_QUIZ_LEN = 8; // questions per round

  // Fisher–Yates shuffle returning a NEW array (pure given rng).
  function shuffleArr(arr, rng) {
    rng = rng || Math.random;
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  // Build a shuffled quiz: `count` questions, each with the word, its correct
  // definition, and 3 distractor definitions from other words. Pure given rng, so
  // it can be unit-tested deterministically.
  function buildVocabQuiz(words, count, rng) {
    rng = rng || Math.random;
    const pool = shuffleArr(words, rng);
    const n = Math.min(count, pool.length);
    const questions = [];
    for (let i = 0; i < n; i++) {
      const w = pool[i];
      const distractors = shuffleArr(words.filter((x) => x.word !== w.word), rng)
        .slice(0, 3).map((x) => x.definition);
      questions.push({
        word: w.word,
        answer: w.definition,
        options: shuffleArr([w.definition].concat(distractors), rng),
      });
    }
    return questions;
  }

  function openVocabQuest(game) {
    const quiz = buildVocabQuiz(VOCAB_WORDS, VOCAB_QUIZ_LEN);
    let idx = 0, score = 0, answered = false;
    openModal(game.title, '<div id="vq"></div>');
    renderQuestion();

    function renderQuestion() {
      answered = false;
      const q = quiz[idx];
      const optsHTML = q.options.map((opt, i) =>
        '<button type="button" class="vq-option" data-i="' + i + '">' + esc(opt) + "</button>").join("");
      $("vq").innerHTML =
        '<div class="vq-progress">Question ' + (idx + 1) + " of " + quiz.length + " · Score " + score + "</div>" +
        '<div class="vq-word">' + esc(q.word) + "</div>" +
        '<p class="hint">What does this word mean?</p>' +
        '<div class="vq-options">' + optsHTML + "</div>" +
        '<div class="vq-feedback" id="vq-feedback"></div>' +
        '<div class="form-actions"><button type="button" id="vq-next" class="btn-primary" disabled>Next</button></div>';
      $("vq").querySelectorAll(".vq-option").forEach((b) =>
        b.addEventListener("click", () => choose(parseInt(b.dataset.i, 10))));
      $("vq-next").addEventListener("click", next);
    }

    function choose(i) {
      if (answered) return;
      answered = true;
      const q = quiz[idx];
      const correct = q.options[i] === q.answer;
      if (correct) score++;
      $("vq").querySelectorAll(".vq-option").forEach((b) => {
        const opt = q.options[parseInt(b.dataset.i, 10)];
        b.disabled = true;
        if (opt === q.answer) b.classList.add("vq-correct");
        else if (parseInt(b.dataset.i, 10) === i) b.classList.add("vq-wrong");
      });
      const fb = $("vq-feedback");
      fb.textContent = correct ? "✓ Correct!" : "✗ It means: " + q.answer;
      fb.className = "vq-feedback " + (correct ? "vq-fb-ok" : "vq-fb-no");
      const nextBtn = $("vq-next");
      nextBtn.disabled = false;
      nextBtn.textContent = idx === quiz.length - 1 ? "See results" : "Next";
      nextBtn.focus();
    }

    function next() {
      if (idx < quiz.length - 1) { idx++; renderQuestion(); }
      else renderResults();
    }

    function renderResults() {
      const pct = Math.round((score / quiz.length) * 100);
      const msg = pct >= 80 ? "Amazing work! 🌟"
        : pct >= 50 ? "Great effort — keep going! 💪"
        : "Good try — practice makes perfect! 🌱";
      $("vq").innerHTML =
        '<div class="vq-result"><div class="vq-score">' + score + " / " + quiz.length + "</div>" +
        '<div class="vq-pct">' + pct + "%</div><p>" + msg + "</p></div>" +
        '<div class="form-actions">' +
        '<button type="button" id="vq-again" class="btn-primary">Play again</button>' +
        '<button type="button" id="vq-log" class="btn-secondary">Save to progress</button></div>';
      $("vq-again").addEventListener("click", () => openVocabQuest(game));
      $("vq-log").addEventListener("click", async () => {
        $("vq-log").disabled = true;
        await EduStore.addEntry({
          date: todayISO(), subject: "vr", topic: "Vocabulary Quest", difficulty: "",
          scoreRaw: score, scoreMax: quiz.length, scorePct: pct,
          note: "Played Vocabulary Quest", blobId: null,
        });
        // Close the dialog automatically once the round is saved.
        closeModal();
      });
    }
  }

  // ========== END PLAY & CREATE ==========

  // ============ CURIOSITY ============
  // Self-contained block. Reaches out only to shared helpers ($, esc, openModal/
  // closeModal, SUBJECTS, SUBJECT_LABEL, EduStore) and exposes one entry point
  // wired in VIEW_RENDER: renderCuriosity(). Extract-later contract, mirrors P&C.
  const CUR_KINDS = [
    { key: "question",    label: "Question",    icon: "❓", prompt: "What are you wondering?" },
    { key: "observation", label: "Observation", icon: "🔎", prompt: "What did you notice?" },
    { key: "opinion",     label: "Opinion",     icon: "💭", prompt: "What do you think?" },
  ];
  const CUR_KIND_MAP = Object.fromEntries(CUR_KINDS.map((k) => [k.key, k]));
  // Broad topic taxonomy — NOT the 11+ subjects. Extensible.
  const CUR_TOPICS = [
    { key: "science",      label: "Science",       icon: "🔬" },
    { key: "nature",       label: "Nature",        icon: "🌿" },
    { key: "history",      label: "History",       icon: "🏛️" },
    { key: "geography",    label: "Geography",     icon: "🗺️" },
    { key: "technology",   label: "Technology",    icon: "💻" },
    { key: "books",        label: "Books",         icon: "📚" },
    { key: "society",      label: "Society",       icon: "🤝" },
    { key: "art",          label: "Art",           icon: "🎨" },
    { key: "religion",     label: "Religion",      icon: "🕊️" },
    { key: "space",        label: "Space",         icon: "🪐" },
    { key: "health",       label: "Health",        icon: "💪" },
    { key: "everydayLife", label: "Everyday life", icon: "🏡" },
  ];
  const CUR_TOPIC_MAP = Object.fromEntries(CUR_TOPICS.map((t) => [t.key, t]));
  const CUR_STATUS = { open: "🌱 Open", exploring: "🔭 Exploring", answered: "✅ Answered" };
  const CUR_STATUS_ORDER = ["open", "exploring", "answered"];
  const CUR_STATUS_CLS = { open: "cur-status-open", exploring: "cur-status-exploring", answered: "cur-status-answered" };
  const CUR_AUTHORS = { child: "🧒 L", parent: "👤 Parent" };
  let curFilter = {};   // { kind?, status?, topic?, subject?, author? } — session filter state

  function curAuthorChip(author) {
    const a = author === "parent" ? "parent" : "child";
    return '<span class="chip cur-author-' + a + '">' + CUR_AUTHORS[a] + "</span>";
  }

  async function renderCuriosity() {
    const addBtn = $("cur-add");
    if (addBtn && !addBtn.__wired) { addBtn.__wired = true; addBtn.addEventListener("click", () => openQuickCapture("child")); }
    const pBtn = $("cur-add-parent");
    if (pBtn && !pBtn.__wired) { pBtn.__wired = true; pBtn.addEventListener("click", () => openQuickCapture("parent")); }
    await renderCuriosityPatterns();
    renderCuriosityFilters();
    await renderCuriosityList();
  }

  // Lightweight capture: ONE textarea + a tiny kind picker. Nothing else — topic,
  // subject, tags, links, status all get enriched later on the detail screen, so
  // spontaneous capture is never blocked by a long form. Author is fixed by the
  // button that opened this (💡 = child, 👤 = parent) and shown, not editable here.
  function openQuickCapture(author) {
    const who = author === "parent" ? "parent" : "child";
    const kindBtns = CUR_KINDS.map((k, i) =>
      '<button type="button" class="cur-kind-btn' + (i === 0 ? " active" : "") + '" data-kind="' + k.key + '">' +
      k.icon + " " + esc(k.label) + "</button>").join("");
    const html =
      '<form id="cur-form">' +
      '<p class="hint">' + curAuthorChip(who) + " capturing a spark</p>" +
      '<div class="cur-kind-row" id="c-kind">' + kindBtns + "</div>" +
      '<div class="field"><label for="c-text">' + CUR_KIND_MAP.question.prompt + "</label>" +
      '<textarea id="c-text" rows="3" placeholder="' + esc(CUR_KIND_MAP.question.prompt) + '"></textarea></div>' +
      '<div class="form-actions"><button type="submit" class="btn-primary">Save spark 💡</button></div>' +
      "</form>";
    openModal(who === "parent" ? "Add an observation" : "I wonder…", html);
    let kind = "question";
    $("c-kind").querySelectorAll(".cur-kind-btn").forEach((b) =>
      b.addEventListener("click", () => {
        kind = b.dataset.kind;
        $("c-kind").querySelectorAll(".cur-kind-btn").forEach((x) => x.classList.toggle("active", x === b));
        const prompt = (CUR_KIND_MAP[kind] || CUR_KIND_MAP.question).prompt;
        $("c-text").setAttribute("placeholder", prompt);
      }));
    $("cur-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = $("c-text").value.trim();
      if (!text) return;
      await EduStore.addCuriosity({
        author: who, kind: kind, text: text,
        topic: "", subject: "", tags: [],
        thoughts: [], links: [], status: "open",
      });
      closeModal();
      renderCuriosity();
    });
  }

  // Session filter chips (kind / status / topic / author). Reuses .chip + active.
  function renderCuriosityFilters() {
    const wrap = $("cur-filters");
    if (!wrap) return;
    const chip = (dim, val, label) => {
      const active = curFilter[dim] === val;
      const b = document.createElement("button");
      b.className = "chip cur-filter" + (active ? " active" : "");
      b.textContent = label;
      b.addEventListener("click", () => {
        if (curFilter[dim] === val) delete curFilter[dim];
        else curFilter[dim] = val;
        renderCuriosity();
      });
      return b;
    };
    wrap.innerHTML = "";
    CUR_KINDS.forEach((k) => wrap.appendChild(chip("kind", k.key, k.icon + " " + k.label)));
    CUR_STATUS_ORDER.forEach((s) => wrap.appendChild(chip("status", s, CUR_STATUS[s])));
    wrap.appendChild(chip("author", "child", CUR_AUTHORS.child));
    wrap.appendChild(chip("author", "parent", CUR_AUTHORS.parent));
  }

  // ---- resilient links (decision #4) ----
  // Gather every attachable record with its CURRENT label.
  async function curiosityLinkCandidates() {
    const out = [];
    (await EduStore.getProjects()).forEach((p) => out.push({ type: "project", id: p.id, label: p.name }));
    (await EduStore.getReading()).forEach((r) => out.push({ type: "reading", id: r.id, label: r.title }));
    (await EduStore.getMocks()).forEach((m) => out.push({ type: "mock", id: m.id,
      label: (SUBJECT_LABEL[m.subject] || m.subject) + " mock · " + m.date }));
    (await EduStore.getEntries()).forEach((e) => out.push({ type: "entry", id: e.id,
      label: (SUBJECT_LABEL[e.subject] || e.subject) + " · " + e.date }));
    return out;
  }
  function curiosityCandidateIndex(candidates) {
    const map = {};
    (candidates || []).forEach((c) => { map[c.type + ":" + c.id] = c; });
    return map;
  }
  // Given a stored link + a live index, decide how to render it. Never throws.
  function resolveCuriosityLink(link, byId) {
    try {
      const live = byId[link.type + ":" + link.id];
      if (!live) return { label: link.label || "(unknown)", missing: true, stale: false };
      return { label: live.label, missing: false, stale: live.label !== link.label };
    } catch (_) {
      return { label: (link && link.label) || "(unknown)", missing: true, stale: false };
    }
  }
  function curiosityLinkChipHTML(resolved) {
    if (resolved.missing) {
      return '<span class="chip cur-link-missing">🔗 ' + esc(resolved.label) + " (removed)</span>";
    }
    return '<span class="chip cur-link">🔗 ' + esc(resolved.label) + "</span>";
  }

  async function renderCuriosityList() {
    const list = $("cur-list");
    if (!list) return;
    const rows = await EduStore.getCuriosity(curFilter);
    if (!rows.length) {
      list.innerHTML = '<p class="empty">No sparks yet — tap “💡 I wonder…” and capture your first one! ✨</p>';
      return;
    }
    const byId = curiosityCandidateIndex(await curiosityLinkCandidates());
    list.innerHTML = "";
    rows.forEach((r) => {
      const kind = CUR_KIND_MAP[r.kind] || CUR_KIND_MAP.question;
      const chips = [];
      chips.push(curAuthorChip(r.author));
      chips.push('<span class="chip ' + (CUR_STATUS_CLS[r.status] || "cur-status-open") + '">' +
        (CUR_STATUS[r.status] || CUR_STATUS.open) + "</span>");
      if (r.topic && CUR_TOPIC_MAP[r.topic]) {
        chips.push('<span class="chip">' + CUR_TOPIC_MAP[r.topic].icon + " " + esc(CUR_TOPIC_MAP[r.topic].label) + "</span>");
      }
      if (r.subject && SUBJECT_LABEL[r.subject]) {
        chips.push('<span class="chip">' + esc(SUBJECT_LABEL[r.subject]) + "</span>");
      }
      (r.tags || []).forEach((t) => chips.push('<span class="chip">' + esc(t) + "</span>"));
      const linkCount = (r.links || []).length;
      if (linkCount) chips.push('<span class="chip cur-link">🔗 ' + linkCount + "</span>");
      const thoughtCount = (r.thoughts || []).length;
      if (thoughtCount) chips.push('<span class="chip">💬 ' + thoughtCount + "</span>");
      const row = document.createElement("div");
      row.className = "pc-card cur-card";
      row.innerHTML =
        '<div class="cur-head"><span class="cur-kind-ico">' + kind.icon + "</span>" +
        '<span class="cur-text">' + esc(r.text) + "</span></div>" +
        '<div class="pc-tags">' + chips.join("") + "</div>";
      const actions = document.createElement("div");
      actions.className = "form-actions";
      const open = document.createElement("button");
      open.className = "btn-secondary";
      open.textContent = "Open";
      open.addEventListener("click", () => openCuriosityDetail(r));
      const del = document.createElement("button");
      del.className = "entry-del";
      del.setAttribute("aria-label", "Delete");
      del.textContent = "🗑";
      del.addEventListener("click", async () => {
        if (!confirm("Delete this spark?")) return;
        await EduStore.deleteCuriosity(r.id);
        renderCuriosity();
      });
      actions.appendChild(open);
      actions.appendChild(del);
      row.appendChild(actions);
      list.appendChild(row);
    });
    void byId; // byId is used by the detail modal; kept here for future inline chips
  }

  // Detail = enrichment + evolution. Set topic/subject/tags, cycle status, attach
  // links (resilient), and APPEND to the thoughts thread (existing thoughts are
  // read-only, so earlier thinking is never overwritten — decision #3).
  async function openCuriosityDetail(r) {
    const candidates = await curiosityLinkCandidates();
    const byId = curiosityCandidateIndex(candidates);
    const topicOpts = ['<option value="">— Topic —</option>'].concat(
      CUR_TOPICS.map((t) => '<option value="' + t.key + '"' + (r.topic === t.key ? " selected" : "") + ">" +
        t.icon + " " + esc(t.label) + "</option>")).join("");
    const subjOpts = ['<option value="">— 11+ subject (optional) —</option>'].concat(
      SUBJECTS.map((s) => '<option value="' + s + '"' + (r.subject === s ? " selected" : "") + ">" +
        esc(SUBJECT_LABEL[s]) + "</option>")).join("");
    const linkOpts = ['<option value="">— Link to your work —</option>'].concat(
      candidates.map((c) => '<option value="' + c.type + ":" + c.id + '">' + esc(c.label) + "</option>")).join("");
    // Existing links, live-resolved (renamed/deleted handled gracefully).
    const linksHTML = (r.links || []).length
      ? (r.links || []).map((lk, i) => {
          const res = resolveCuriosityLink(lk, byId);
          return '<span class="cur-link-item">' + curiosityLinkChipHTML(res) +
            '<button type="button" class="cur-link-detach" data-idx="' + i + '" aria-label="Detach">✕</button></span>';
        }).join("")
      : '<span class="hint">No links yet.</span>';
    // Thoughts thread, newest first, each read-only with author + timestamp.
    const thoughts = (r.thoughts || []).slice().sort((a, b) => (b.at || 0) - (a.at || 0));
    const thoughtsHTML = thoughts.length
      ? '<div class="cur-thoughts">' + thoughts.map((t) =>
          '<div class="cur-thought">' + curAuthorChip(t.author) +
          '<span class="cur-thought-when">' + new Date(t.at || Date.now()).toISOString().slice(0, 10) + "</span>" +
          '<div class="cur-thought-text">' + esc(t.text) + "</div></div>").join("") + "</div>"
      : '<p class="hint">No thoughts yet — add the first one below.</p>';
    const html =
      '<div class="pc-meta">' + curAuthorChip(r.author) + " · " + (CUR_KIND_MAP[r.kind] || CUR_KIND_MAP.question).label + "</div>" +
      '<div class="field"><label for="c-topic">Topic</label><select id="c-topic">' + topicOpts + "</select></div>" +
      '<div class="field"><label for="c-subject">Link to a school subject (optional)</label><select id="c-subject">' + subjOpts + "</select></div>" +
      '<div class="field"><label for="c-tags">Tags (comma separated)</label>' +
      '<input id="c-tags" value="' + esc((r.tags || []).join(", ")) + '" placeholder="e.g. space, rockets" /></div>' +
      '<div class="field"><label>Status</label><div class="form-actions">' +
      '<button type="button" id="c-status" class="btn-secondary">' + (CUR_STATUS[r.status] || CUR_STATUS.open) + "</button></div></div>" +
      '<div class="field"><label>Links to your work</label><div class="pc-tags" id="c-links">' + linksHTML + "</div>" +
      '<select id="c-link">' + linkOpts + "</select>" +
      '<div class="form-actions"><button type="button" id="c-link-add" class="btn-secondary">🔗 Attach</button></div></div>' +
      '<div class="field"><label>Thoughts so far</label>' + thoughtsHTML + "</div>" +
      '<div class="field"><label for="c-thought">Add a new thought</label>' +
      '<textarea id="c-thought" rows="2" placeholder="What are you thinking now?"></textarea>' +
      '<div class="form-actions"><button type="button" id="c-thought-add" class="btn-secondary">💬 Add thought</button></div></div>' +
      '<div class="form-actions"><button type="button" id="c-save" class="btn-primary">Save</button></div>';
    openModal(r.text, html);

    // Local working copies so multiple edits batch into one save.
    let status = r.status || "open";
    let links = (r.links || []).slice();
    const rerenderLinks = () => {
      const box = $("c-links");
      if (!links.length) { box.innerHTML = '<span class="hint">No links yet.</span>'; return; }
      box.innerHTML = links.map((lk, i) => {
        const res = resolveCuriosityLink(lk, byId);
        return '<span class="cur-link-item">' + curiosityLinkChipHTML(res) +
          '<button type="button" class="cur-link-detach" data-idx="' + i + '" aria-label="Detach">✕</button></span>';
      }).join("");
      box.querySelectorAll(".cur-link-detach").forEach((b) =>
        b.addEventListener("click", () => { links.splice(Number(b.dataset.idx), 1); rerenderLinks(); }));
    };
    $("c-links").querySelectorAll(".cur-link-detach").forEach((b) =>
      b.addEventListener("click", () => { links.splice(Number(b.dataset.idx), 1); rerenderLinks(); }));
    $("c-status").addEventListener("click", () => {
      const next = CUR_STATUS_ORDER[(CUR_STATUS_ORDER.indexOf(status) + 1) % CUR_STATUS_ORDER.length];
      status = next;
      $("c-status").textContent = CUR_STATUS[status];
    });
    $("c-link-add").addEventListener("click", () => {
      const val = $("c-link").value;
      if (!val) return;
      const live = byId[val];
      if (!live) return;
      if (links.some((l) => l.type === live.type && l.id === live.id)) return;
      links.push({ type: live.type, id: live.id, label: live.label });
      rerenderLinks();
    });
    $("c-thought-add").addEventListener("click", async () => {
      const text = $("c-thought").value.trim();
      if (!text) return;
      const thoughtsNext = (r.thoughts || []).concat([{ text: text, author: r.author || "child", at: Date.now() }]);
      const updated = await EduStore.updateCuriosity(r.id, { thoughts: thoughtsNext });
      closeModal();
      if (updated) openCuriosityDetail(updated);
      else renderCuriosity();
    });
    $("c-save").addEventListener("click", async () => {
      const tags = $("c-tags").value.split(",").map((s) => s.trim()).filter(Boolean);
      // Refresh snapshot labels on save so renamed links persist their new label.
      const linksToSave = links.map((lk) => {
        const res = resolveCuriosityLink(lk, byId);
        return res.missing ? lk : { type: lk.type, id: lk.id, label: res.label };
      });
      await EduStore.updateCuriosity(r.id, {
        topic: $("c-topic").value, subject: $("c-subject").value,
        tags: tags, status: status, links: linksToSave,
      });
      closeModal();
      renderCuriosity();
    });
  }

  // ---- local patterns (offline, evidence-only — decision #5) ----
  // Every string is count/time-bounded. NO identity/destiny/career/ability claims.
  // Values are interpolated into fixed templates; nothing free-form is emitted.
  const CUR_INSIGHT_PHRASES = {
    total: "You've captured {n} sparks so far 💡",
    recent: "{n} of them in the last 7 days ✨",
    streak: "You've wondered something {n} days in a row 🔥",
    topics: "You've explored {list} most this month 🌟",
    kind: "Lately you've been {activity} 🙂",
    subjectLinks: "{n} sparks are linked to your {subject} work 📎",
    open: "{n} questions are waiting for you to explore 🔭",
    parent: "A parent has added {n} observations 👤",
    empty: "Nothing here yet — your wonders and discoveries will show up here as you capture them. 🌱",
  };
  const CUR_KIND_ACTIVITY = {
    question: "asking lots of questions ❓",
    observation: "noticing lots of things 🔎",
    opinion: "sharing lots of ideas 💭",
  };

  function curDayKey(ts) { return new Date(ts).toISOString().slice(0, 10); }
  function curStreak(childRows) {
    const days = new Set(childRows.map((r) => curDayKey(r.createdAt || r.updatedAt || Date.now())));
    let streak = 0;
    const d = new Date();
    for (;;) {
      const key = d.toISOString().slice(0, 10);
      if (days.has(key)) { streak++; d.setDate(d.getDate() - 1); } else break;
    }
    return streak;
  }

  async function renderCuriosityPatterns() {
    const el = $("cur-patterns");
    if (!el) return;
    const rows = await EduStore.getCuriosity();  // active student
    if (!rows.length) {
      el.innerHTML = '<div class="card cur-patterns"><p class="hint">' + CUR_INSIGHT_PHRASES.empty + "</p></div>";
      return;
    }
    // Parent observations are counted separately and NEVER merged into L's numbers.
    const childRows = rows.filter((r) => (r.author || "child") === "child");
    const parentRows = rows.filter((r) => r.author === "parent");
    const now = Date.now();
    const weekAgo = now - 7 * 864e5;
    const monthAgo = now - 30 * 864e5;
    const lines = [];

    lines.push(CUR_INSIGHT_PHRASES.total.replace("{n}", childRows.length));
    const recent = childRows.filter((r) => (r.createdAt || r.updatedAt || 0) >= weekAgo).length;
    if (recent) lines.push(CUR_INSIGHT_PHRASES.recent.replace("{n}", recent));
    const streak = curStreak(childRows);
    if (streak >= 2) lines.push(CUR_INSIGHT_PHRASES.streak.replace("{n}", streak));

    // Top topics this month (topic, falling back to tags). Count/time-bounded.
    const topicCounts = {};
    childRows.filter((r) => (r.createdAt || r.updatedAt || 0) >= monthAgo).forEach((r) => {
      if (r.topic && CUR_TOPIC_MAP[r.topic]) {
        topicCounts[CUR_TOPIC_MAP[r.topic].label] = (topicCounts[CUR_TOPIC_MAP[r.topic].label] || 0) + 1;
      } else {
        (r.tags || []).forEach((t) => { const k = String(t).trim(); if (k) topicCounts[k] = (topicCounts[k] || 0) + 1; });
      }
    });
    const topTopics = Object.keys(topicCounts).sort((a, b) => topicCounts[b] - topicCounts[a]).slice(0, 3);
    if (topTopics.length) {
      const listStr = topTopics.map((t) => "<strong>" + esc(t) + "</strong>").join(", ");
      lines.push(CUR_INSIGHT_PHRASES.topics.replace("{list}", listStr));
    }

    // Favourite kind, phrased as an activity (not a trait).
    const kindCounts = {};
    childRows.forEach((r) => { kindCounts[r.kind] = (kindCounts[r.kind] || 0) + 1; });
    const topKind = Object.keys(kindCounts).sort((a, b) => kindCounts[b] - kindCounts[a])[0];
    if (topKind && CUR_KIND_ACTIVITY[topKind]) {
      lines.push(CUR_INSIGHT_PHRASES.kind.replace("{activity}", CUR_KIND_ACTIVITY[topKind]));
    }

    // Subject-link spread (evidence, not "most curious about X").
    const subjCounts = {};
    childRows.forEach((r) => { if (r.subject && SUBJECT_LABEL[r.subject]) subjCounts[r.subject] = (subjCounts[r.subject] || 0) + 1; });
    const topSubj = Object.keys(subjCounts).sort((a, b) => subjCounts[b] - subjCounts[a])[0];
    if (topSubj) {
      lines.push(CUR_INSIGHT_PHRASES.subjectLinks
        .replace("{n}", subjCounts[topSubj]).replace("{subject}", SUBJECT_LABEL[topSubj]));
    }

    const openCount = childRows.filter((r) => (r.status || "open") === "open").length;
    if (openCount) lines.push(CUR_INSIGHT_PHRASES.open.replace("{n}", openCount));

    let parentLine = "";
    if (parentRows.length) {
      parentLine = '<p class="cur-parent-note">' +
        CUR_INSIGHT_PHRASES.parent.replace("{n}", parentRows.length) + "</p>";
    }

    el.innerHTML = '<div class="card cur-patterns"><h2 class="section-heading">Your sparks 🌟</h2>' +
      "<ul>" + lines.map((l) => "<li>" + l + "</li>").join("") + "</ul>" + parentLine + "</div>";
  }
  // ========== END CURIOSITY ==========

  // ============ HOMEWORK ANALYZER ============
  // Self-contained block. Reaches out only to shared helpers ($, esc, openModal/
  // closeModal, SUBJECTS, SUBJECT_LABEL, compressImage, EduStore) plus a one-way
  // read of computeReadiness() for the school-evidence echo. Entry point wired in
  // VIEW_RENDER: renderAnalyzer(). Everything is LOCAL — no photo ever leaves the
  // device in this (Private Scan) mode. Enhanced AI (Mode B) is a guarded stub.

  const AN_ERROR_CATEGORIES = [
    { key: "concept",     label: "Concept" },
    { key: "calculation", label: "Calculation slip" },
    { key: "instruction", label: "Misread instruction" },
    { key: "incomplete",  label: "Incomplete" },
    { key: "time",        label: "Ran out of time" },
    { key: "skipped",     label: "Skipped" },
    { key: "other",       label: "Other" },
  ];
  const AN_SUPPORT_LEVELS = [
    { key: "independent", label: "On her own" },
    { key: "hint",        label: "With a hint" },
    { key: "guided",      label: "Guided together" },
  ];
  // Topic keyword map, Maths-first for the v1 pilot (extensible per subject).
  const AN_TOPIC_KEYWORDS = {
    maths: [
      { topic: "fractions",   words: ["fraction", "numerator", "denominator", "/"] },
      { topic: "decimals",    words: ["decimal", "point", "tenth", "hundredth"] },
      { topic: "percentages", words: ["percent", "percentage", "%"] },
      { topic: "arithmetic",  words: ["add", "sum", "subtract", "minus", "multiply", "times", "divide", "+", "−", "-", "×", "÷"] },
      { topic: "geometry",    words: ["angle", "triangle", "rectangle", "area", "perimeter", "shape", "degrees"] },
      { topic: "measures",    words: ["metre", "meter", "gram", "litre", "kg", "cm", "mm", "km"] },
      { topic: "time",        words: ["clock", "hour", "minute", "o'clock", "am", "pm"] },
      { topic: "money",       words: ["£", "$", "pence", "pound", "cost", "change", "price"] },
      { topic: "word-problem",words: ["altogether", "how many", "how much", "in total", "left", "share"] },
    ],
  };

  // Deterministic, transparent complexity ESTIMATE (1..5). Always editable by the
  // parent — this is a starting point, never a verdict. Same input → same output.
  function estimateComplexity(text, subject) {
    const t = String(text || "").toLowerCase();
    if (!t.trim()) return 2;
    let score = 1;
    const words = t.split(/\s+/).filter(Boolean).length;
    if (words > 8) score += 1;
    if (words > 20) score += 1;
    // Multi-step / reasoning signals (subject-agnostic).
    if (/(explain|why|because|show your working|justify|estimate)/.test(t)) score += 1;
    if (subject === "maths") {
      const numbers = (t.match(/\d+/g) || []).length;
      if (numbers >= 3) score += 1;
      // Chained operations suggest multi-step work.
      const ops = (t.match(/[+\-−×÷*/]/g) || []).length;
      if (ops >= 2) score += 1;
      if (/(altogether|in total|how many|how much|left over|share)/.test(t)) score += 1;
    }
    return Math.max(1, Math.min(5, score));
  }

  function guessTopic(text, subject) {
    const t = String(text || "").toLowerCase();
    const table = AN_TOPIC_KEYWORDS[subject] || [];
    for (const row of table) {
      if (row.words.some((w) => t.indexOf(w) >= 0)) return row.topic;
    }
    return "";
  }

  // ---- provider seam (§3a) ----
  // The review/save/render code depends ONLY on analyseWorksheet + the
  // WorksheetAnalysis/QuestionAttempt shapes, never on Tesseract directly, so a
  // future server-side provider slots in with no UI or storage change.
  async function analyseWorksheet(image, options) {
    options = options || {};
    const mode = options.mode || "local";
    if (mode === "local") return localScanProvider(image, options);
    return enhancedAiProvider(image, options);
  }

  // Client-side language guard (defense-in-depth on top of the system prompt).
  // If any deficit / fixed-ability word slips through, replace the whole summary
  // with a neutral, encouraging fallback so it never reaches the parent.
  const AI_BANNED = [
    // deficit
    "weak", "weakest", "worst", "bad", "poor", "behind", "lazy", "failing", "fail",
    "stupid", "dumb", "slow",
    // identity / fixed-ability
    "genius", "gifted", "talented",
  ];
  function softenSummary(text) {
    if (!text) return "";
    const lower = String(text).toLowerCase();
    const hit = AI_BANNED.some((w) => new RegExp("\\b" + w + "\\b").test(lower));
    return hit ? "A good one to practise again together." : text;
  }

  // Map one AI-suggested attempt (§4 response) onto the existing QuestionAttempt
  // shape. Starts from makeAttempt (defaults + guessTopic + estimateComplexity),
  // then overlays AI fields. parentApproved ALWAYS starts false.
  function mapAiAttempt(ai, subject) {
    ai = ai || {};
    const a = makeAttempt(ai.questionText || "", subject);
    if (typeof ai.marksAwarded === "number" || typeof ai.marksAvailable === "number") {
      a.marksAwarded = typeof ai.marksAwarded === "number" ? ai.marksAwarded : null;
      a.marksAvailable = typeof ai.marksAvailable === "number" ? ai.marksAvailable : null;
    } else {
      switch (ai.correctness) {
        case "correct":   a.marksAwarded = 1; a.marksAvailable = 1; break;
        case "incorrect": a.marksAwarded = 0; a.marksAvailable = 1; break;
        case "partial":   /* leave null; parent enters */ break;
        default:          a.marksAwarded = null; a.marksAvailable = null; // unclear
      }
    }
    const knownErr = AN_ERROR_CATEGORIES.some((c) => c.key === ai.errorType);
    a.errorType = knownErr ? ai.errorType : "";
    if (ai.subskill) a.subskill = ai.subskill;
    if (ai.topic) a.topic = ai.topic; // else keep guessTopic default
    a.studentAnswer = ai.studentAnswer || "";
    a.expectedAnswer = ai.expectedAnswer || "";
    a.confidence = (typeof ai.confidence === "number") ? ai.confidence : null;
    a.needsReview = (ai.correctness === "unclear") ? true : (ai.needsReview !== false);
    a.reasoningSummary = softenSummary(ai.reasoningSummary || "");
    a.parentApproved = false; // always
    return a;
  }

  // Mode B — opt-in cloud Vision analysis (Anthropic via /api/analyse-homework).
  // Gated by the settings master switch AND per-capture consent. Never writes to
  // storage — capture/review/save own persistence, exactly like local mode.
  async function enhancedAiProvider(image, options) {
    options = options || {};
    const subject = options.subject || "maths";
    // (a) consent gate: master switch ON + per-session consent
    const enabled = await EduStore.getMeta("analyzer.enhancedAi.enabled");
    if (enabled !== true && enabled !== "true") {
      throw new Error("Enhanced AI is turned off. You can turn it on in Settings.");
    }
    if (options.consent !== true) {
      throw new Error("Please confirm the consent box to use Enhanced AI.");
    }
    // (b) Blob -> base64 (strip data: prefix); capture mediaType
    const mediaType = (image && image.type) || "image/jpeg";
    const dataUrl = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(new Error("Could not read the photo."));
      fr.readAsDataURL(image);
    });
    const base64 = String(dataUrl).split(",")[1] || "";
    if (options.onProgress) options.onProgress(0.2);
    // (c) POST with AbortController timeout (~30s)
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    let resp;
    try {
      resp = await fetch("/api/analyse-homework", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ image: { mediaType: mediaType, data: base64 }, subject: subject }),
        signal: options.signal || ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      throw new Error("We couldn't reach the analysis service. Your photo is safe — you can review by hand.");
    }
    clearTimeout(timer);
    if (options.onProgress) options.onProgress(0.8);
    // (d) non-OK -> surface the server's real reason so failures are diagnosable;
    // the caller keeps blobId and can still fall back to manual review.
    if (!resp.ok) {
      let detail = "";
      try { const errJson = await resp.json(); detail = (errJson && errJson.error) || ""; } catch (_) { /* no body */ }
      throw new Error(detail
        ? "Enhanced AI failed: " + detail
        : "The analysis didn't come back (HTTP " + resp.status + "). Your photo is safe — you can review by hand.");
    }
    const api = await resp.json();
    // (e) normalize into WorksheetAnalysis
    const attempts = (api.attempts || []).map((ai) => mapAiAttempt(ai, subject));
    if (options.onProgress) options.onProgress(1);
    return {
      source: options.source || "worksheet",
      mode: "enhanced",
      overall: {
        subject: subject,
        score: null,
        avgComplexity: null,
        reasoningSummary: (api.overall && softenSummary(api.overall.reasoningSummary || "")) || "",
        provider: "anthropic",
        aiConfidence: (api.overall && api.overall.confidence) != null ? api.overall.confidence : null,
      },
      attempts: attempts,
    };
  }

  // Lazy-load the vendored Tesseract engine only on first use (keeps the rest of
  // the app light). All asset paths are local so it works offline once cached.
  let __tesseractPromise = null;
  function ensureTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (__tesseractPromise) return __tesseractPromise;
    __tesseractPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "vendor/tesseract/tesseract.min.js";
      s.onload = () => (window.Tesseract ? resolve(window.Tesseract) : reject(new Error("Tesseract failed to load")));
      s.onerror = () => reject(new Error("Could not load the scanner engine"));
      document.head.appendChild(s);
    });
    return __tesseractPromise;
  }

  // Mode A — on-device OCR of PRINTED question text only. Correctness/marks always
  // come from the parent, never OCR. Returns a WorksheetAnalysis (unsaved).
  async function localScanProvider(image, options) {
    const onProgress = options.onProgress || function () {};
    let text = "";
    try {
      const Tesseract = await ensureTesseract();
      onProgress(0.05);
      const result = await Tesseract.recognize(image, "eng", {
        // Directory paths let the worker auto-pick the best vendored core
        // variant (simd / lstm) for the browser; all four are vendored locally.
        langPath: "vendor/tesseract/lang",
        corePath: "vendor/tesseract",
        workerPath: "vendor/tesseract/worker.min.js",
        logger: (m) => { if (m && m.status === "recognizing text" && typeof m.progress === "number") onProgress(m.progress); },
      });
      text = (result && result.data && result.data.text) || "";
    } catch (e) {
      // Fall through with empty text — the review UI offers manual entry.
      text = "";
    }
    onProgress(1);
    const subject = options.subject || "maths";
    const attempts = splitQuestions(text).map((qtext) => makeAttempt(qtext, subject));
    return {
      source: options.source || "worksheet",
      mode: "local",
      overall: { subject: subject, score: null, avgComplexity: null },
      attempts: attempts,
    };
  }

  // Regex for an explicit question marker at the start of a line: "1.", "2)",
  // "3]", "a.", "b)", or a bullet. Capturing group 1 is the marker text.
  const AN_Q_MARKER = /^\s*(\d{1,3}[\).\]]|[a-z][\).\]]|[-•*])\s+/i;
  // Lines that are worksheet furniture, not questions: name/date/class fields,
  // section/page headers, "Year 5", "Worksheet", a lone score like "8/10", or a
  // standalone number (page number). Deterministic and easy to extend.
  const AN_NOISE = [
    /^\s*(name|date|class|teacher|pupil|student|score|mark|marks|total|subject|topic|set)\s*[:\-]/i,
    /^\s*(section|part|page|unit|lesson|exercise|activity|worksheet|homework|sheet|paper)\b/i,
    /^\s*year\s*\d+\b/i,
    /^\s*\d+\s*\/\s*\d+\s*$/,           // bare "8/10" score
    /^\s*[\d\.\)\]\-–—]+\s*$/,          // just numbers/punctuation (page no., stray marks)
    /^\s*©/,
  ];
  // A line reads like a real question if it asks/instructs or carries maths.
  const AN_QUESTION_HINT = [
    /\?/,                                                     // ends with / contains a question
    /\b(what|why|how|which|when|where|who|whose|find|work out|calculate|solve|explain|write|complete|circle|draw|show|list|name|give|estimate|round|convert|simplify|add|subtract|multiply|divide|order|compare|fill in|choose|match|underline|tick)\b/i,
    /[+\-−×÷=]/,                                              // a maths operator / equation
    /\b\d+\s*(cm|mm|m|km|kg|g|ml|l|%|p|£|\$)\b/i,             // quantity with a unit
  ];

  // Decide whether a single cleaned line (marker already stripped) looks like a
  // real question rather than a heading or worksheet furniture.
  function looksLikeQuestion(line, hadMarker) {
    const t = line.trim();
    if (t.length < 3) return false;
    if (AN_NOISE.some((re) => re.test(t))) return false;
    // A numbered/bulleted item is almost always a question on a worksheet.
    if (hadMarker) return true;
    // Otherwise require a positive question signal to avoid capturing headings.
    if (AN_QUESTION_HINT.some((re) => re.test(t))) return true;
    // A short line with no question signal and Title/UPPER case is a heading.
    const words = t.split(/\s+/).filter(Boolean);
    const looksTitle = words.length <= 6 && !/[.?!]$/.test(t) &&
      words.every((w) => /^[A-Z0-9]/.test(w) || w.length <= 3);
    if (looksTitle) return false;
    // Fall back to keeping longer prose lines (likely a question without keywords).
    return words.length >= 5;
  }

  // Split OCR text into candidate questions. Numbered/bulleted items anchor a
  // question and absorb any following unnumbered "continuation" lines (wrapped
  // question text). Headings, name/date fields, page numbers and other furniture
  // are filtered out. Deterministic; same input → same output. When no explicit
  // numbering is found we fall back to per-line question detection.
  function splitQuestions(text) {
    const rawLines = String(text || "").split(/\r?\n/);
    const hasNumbering = rawLines.some((l) => AN_Q_MARKER.test(l));
    if (hasNumbering) {
      const items = [];
      let current = null;
      for (const raw of rawLines) {
        const line = raw.trim();
        if (!line) { current = null; continue; }
        const m = raw.match(AN_Q_MARKER);
        if (m) {
          const body = raw.slice(m[0].length).trim();
          current = { text: body, hadMarker: true };
          items.push(current);
        } else if (AN_NOISE.some((re) => re.test(line))) {
          // Furniture line (page number, header, score) — ends the current
          // question so it isn't absorbed as a continuation.
          current = null;
        } else if (current) {
          // Continuation of the current question (wrapped line).
          current.text = (current.text + " " + line).trim();
        } else {
          // Pre-amble prose before the first numbered item — keep if it reads
          // like a question, otherwise treat as a heading and drop.
          if (looksLikeQuestion(line, false)) items.push({ text: line, hadMarker: false });
        }
      }
      return items
        .filter((it) => looksLikeQuestion(it.text, it.hadMarker))
        .map((it) => it.text)
        .filter((t) => t.length >= 2);
    }
    // No explicit numbering: judge each non-empty line on its own merits.
    return rawLines
      .map((l) => {
        const m = l.match(AN_Q_MARKER);
        return { text: (m ? l.slice(m[0].length) : l).trim(), hadMarker: !!m };
      })
      .filter((it) => it.text.length >= 2 && looksLikeQuestion(it.text, it.hadMarker))
      .map((it) => it.text);
  }

  function makeAttempt(text, subject) {
    return {
      questionText: text,
      subject: subject,
      topic: guessTopic(text, subject),
      subskill: "",
      complexity: estimateComplexity(text, subject),
      studentAnswer: "",
      expectedAnswer: "",
      marksAwarded: null,
      marksAvailable: null,
      errorType: "",
      supportLevel: "",
      confidence: null,
      needsReview: true,
      parentApproved: false,
    };
  }

  // Derived correctness from marks: full → correct, zero → incorrect, else partial.
  function attemptOutcome(a) {
    const aw = a.marksAwarded, av = a.marksAvailable;
    if (aw == null || av == null || av <= 0) return "unmarked";
    if (aw >= av) return "correct";
    if (aw <= 0) return "incorrect";
    return "partial";
  }

  // Working draft during a capture→review session (before it is saved).
  let anDraft = null;

  async function renderAnalyzer() {
    const addBtn = $("an-add");
    if (addBtn && !addBtn.__wired) {
      addBtn.__wired = true;
      addBtn.addEventListener("click", openAnalyzerCapture);
    }
    await renderAnalyzerInsights();
    await renderAnalyzerList();
  }

  // Capture: pick/scan a printed worksheet photo, confirm subject, run OCR (local)
  // or opt-in cloud Vision analysis (enhanced, only when the master switch is ON).
  async function openAnalyzerCapture() {
    const masterOn = (await EduStore.getMeta("analyzer.enhancedAi.enabled")) === true;
    const subjOpts = SUBJECTS.map((s) =>
      '<option value="' + s + '"' + (s === "maths" ? " selected" : "") + ">" + esc(SUBJECT_LABEL[s]) + "</option>").join("");
    const enhancedBlock = masterOn
      ? '<label class="an-mode-pick"><input type="checkbox" id="an-enhanced"> ✨ Enhanced AI (beta)</label>' +
        '<label class="an-consent hidden" id="an-consent-row"><input type="checkbox" id="an-consent"> I understand this photo will be sent securely for analysis.</label>'
      : "";
    openModal("Scan a worksheet",
      '<form id="an-form" class="an-form">' +
      '<p class="hint">🔒 Private Scan reads the <b>printed questions</b> on the page. Your child\'s handwritten answers stay for you to mark with ✓ / part-marks / ✗ — the photo never leaves this device.</p>' +
      '<label>Subject<select id="an-subject">' + subjOpts + "</select></label>" +
      '<label>Worksheet photo<input type="file" id="an-image" accept="image/*" required>' +
      '<span class="hint an-file-hint">Take a photo or choose one from your library.</span></label>' +
      enhancedBlock +
      '<div id="an-progress" class="an-progress hidden"><div class="an-bar"><span></span></div><span class="an-progress-txt">Reading the page…</span></div>' +
      '<div class="form-actions"><button type="submit" class="btn-primary">Scan</button>' +
      '<button type="button" id="an-manual" class="btn-secondary">Enter by hand instead</button></div>' +
      "</form>");
    // Consent line is only meaningful when Enhanced AI is ticked.
    if (masterOn) {
      $("an-enhanced").addEventListener("change", (e) => {
        $("an-consent-row").classList.toggle("hidden", !e.target.checked);
        if (!e.target.checked) $("an-consent").checked = false;
      });
    }
    $("an-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const file = $("an-image").files[0];
      if (!file) return;
      const subject = $("an-subject").value;
      const useEnhanced = masterOn && $("an-enhanced") && $("an-enhanced").checked === true;
      const consent = !!(useEnhanced && $("an-consent") && $("an-consent").checked === true);
      const prog = $("an-progress");
      const bar = prog.querySelector(".an-bar span");
      const txt = prog.querySelector(".an-progress-txt");
      // Block before any network call if Enhanced is on but consent is not given.
      if (useEnhanced && !consent) {
        prog.classList.remove("hidden");
        txt.textContent = "Please confirm the consent box to use Enhanced AI.";
        return;
      }
      prog.classList.remove("hidden");
      txt.textContent = useEnhanced ? "Analysing the page…" : "Reading the page…";
      // Compress → putBlob FIRST so the image survives any provider outcome.
      let blobId = null;
      let blob = file;
      try {
        blob = await compressImage(file, useEnhanced ? 1024 : 1600, useEnhanced ? 0.6 : 0.7);
        blobId = await EduStore.putBlob(blob, "image/jpeg");
      } catch (_) { blobId = null; }
      let analysis;
      try {
        analysis = await analyseWorksheet(blob, {
          mode: useEnhanced ? "enhanced" : "local", subject: subject, consent: consent,
          onProgress: (p) => { bar.style.width = Math.round((p || 0) * 100) + "%"; },
        });
      } catch (err) {
        // Show the real reason and stop here so the message is actually seen.
        // The photo is kept (blobId); the parent can continue to manual review
        // with the button below rather than being dropped onto an empty screen.
        bar.style.width = "0%";
        txt.textContent = (err && err.message) || "The analysis didn't come back. Your photo is safe — you can review by hand.";
        const emptyDraft = {
          source: "worksheet", mode: useEnhanced ? "enhanced" : "local",
          overall: { subject: subject, score: null, avgComplexity: null }, attempts: [],
        };
        if (!$("an-review-anyway")) {
          const go = document.createElement("button");
          go.type = "button";
          go.id = "an-review-anyway";
          go.className = "btn-secondary";
          go.textContent = "Review by hand instead";
          go.addEventListener("click", () => {
            anDraft = Object.assign({ blobId: blobId }, emptyDraft);
            openAnalyzerReview();
          });
          prog.appendChild(go);
        }
        return;
      }
      anDraft = Object.assign({ blobId: blobId }, analysis);
      openAnalyzerReview();
    });
    $("an-manual").addEventListener("click", () => {
      const subject = $("an-subject").value;
      anDraft = { blobId: null, source: "worksheet", mode: "local", overall: { subject: subject, score: null, avgComplexity: null }, attempts: [] };
      openAnalyzerReview();
    });
  }

  // Review + tag: the parent confirms subject, edits/adds questions, records marks
  // (partial allowed), optional error category + support level, and approves.
  function openAnalyzerReview() {
    if (!anDraft) return;
    const subjOpts = SUBJECTS.map((s) =>
      '<option value="' + s + '"' + (s === anDraft.overall.subject ? " selected" : "") + ">" + esc(SUBJECT_LABEL[s]) + "</option>").join("");
    // Delete-after-approval only applies to the cloud (enhanced) path; local
    // photos are already on-device only, so they are kept and no option is shown.
    const isEnhanced = anDraft.mode === "enhanced" && anDraft.blobId;
    const keepBlock = isEnhanced
      ? '<label class="an-keep"><input type="checkbox" id="an-keep-image"> Keep photo on device (otherwise it is deleted after you approve).</label>'
      : "";
    const overallNote = (anDraft.overall && anDraft.overall.reasoningSummary)
      ? '<p class="an-ai-note">' + esc(anDraft.overall.reasoningSummary) + "</p>" : "";
    openModal("Review worksheet",
      '<div class="an-review">' +
      '<div class="an-intro">' +
      "<p><strong>Here's what the scan found.</strong> Quickly check it, then save — it takes about a minute.</p>" +
      "<ol>" +
      "<li><strong>Check the question text</strong> — fix any words the scan got wrong, and tap 🗑 to remove anything that isn't a question (like a title or your child's name).</li>" +
      "<li><strong>Mark it</strong> — tap ✓ if she got it right, ✗ if not, or type the marks (e.g. 2 out of 3).</li>" +
      '<li><strong>Save</strong> — that\'s it. Adding extra detail is optional.</li>' +
      "</ol>" +
      "</div>" +
      '<label>Subject<select id="an-r-subject">' + subjOpts + "</select></label>" +
      overallNote +
      '<div id="an-rows"></div>' +
      '<button type="button" id="an-add-q" class="btn-secondary">＋ Add a question</button>' +
      keepBlock +
      '<div class="form-actions"><button type="button" id="an-save" class="btn-primary">Save worksheet</button></div>' +
      "</div>");
    $("an-r-subject").addEventListener("change", () => { anDraft.overall.subject = $("an-r-subject").value; });
    renderAnalyzerRows();
    $("an-add-q").addEventListener("click", () => {
      anDraft.attempts.push(makeAttempt("", anDraft.overall.subject));
      renderAnalyzerRows();
    });
    $("an-save").addEventListener("click", saveAnalysis);
  }

  function renderAnalyzerRows() {
    const wrap = $("an-rows");
    if (!wrap) return;
    if (!anDraft.attempts.length) {
      wrap.innerHTML = '<p class="empty">No questions found. Tap “＋ Add a question” to record them by hand.</p>';
      return;
    }
    const enhanced = anDraft.mode === "enhanced";
    wrap.innerHTML = anDraft.attempts.map((a, i) => {
      const outcome = attemptOutcome(a);
      const errOpts = ['<option value="">— what happened? (optional) —</option>'].concat(
        AN_ERROR_CATEGORIES.map((c) => '<option value="' + c.key + '"' + (a.errorType === c.key ? " selected" : "") + ">" + esc(c.label) + "</option>")).join("");
      const supOpts = ['<option value="">— support (optional) —</option>'].concat(
        AN_SUPPORT_LEVELS.map((c) => '<option value="' + c.key + '"' + (a.supportLevel === c.key ? " selected" : "") + ">" + esc(c.label) + "</option>")).join("");
      const showErr = outcome === "incorrect" || outcome === "partial";
      const needsFlag = a.needsReview === true || (a.confidence != null && a.confidence < 0.6);
      const badge = needsFlag ? '<span class="an-badge">Please check</span>' : "";
      const aiNote = a.reasoningSummary ? '<p class="an-ai-note">' + esc(a.reasoningSummary) + "</p>" : "";
      const answers = enhanced
        ? '<div class="an-answers">' +
          '<label class="an-answer">Their answer<input class="an-q-sa" type="text" value="' + esc(a.studentAnswer || "") + '" /></label>' +
          '<label class="an-answer">Expected<input class="an-q-ea" type="text" value="' + esc(a.expectedAnswer || "") + '" /></label>' +
          "</div>"
        : "";
      return '<div class="an-row' + (needsFlag ? " an-needs-review" : "") + '" data-idx="' + i + '">' +
        '<div class="an-q-head">' +
        '<label class="an-q-label">Question ' + (i + 1) +
        '<textarea class="an-q-text" rows="2" placeholder="Type the question here">' + esc(a.questionText) + "</textarea></label>" +
        badge +
        '<button type="button" class="an-q-del" aria-label="Remove this question" title="Remove">🗑</button>' +
        "</div>" +
        aiNote +
        answers +
        '<div class="an-q-controls">' +
        '<span class="an-mark-label">How did she do?</span>' +
        '<button type="button" class="an-tick" title="Got it right (full marks)">✓ Right</button>' +
        '<button type="button" class="an-cross" title="Got it wrong (no marks)">✗ Wrong</button>' +
        '<span class="an-marks">or marks: <input class="an-q-aw" type="number" min="0" step="0.5" placeholder="got" value="' + (a.marksAwarded == null ? "" : a.marksAwarded) + '" /> out of <input class="an-q-av" type="number" min="1" step="0.5" placeholder="max" value="' + (a.marksAvailable == null ? "" : a.marksAvailable) + '" /></span>' +
        "</div>" +
        '<details class="an-detail">' +
        "<summary>Add detail (optional)</summary>" +
        '<label class="an-detail-field an-q-err-wrap' + (showErr ? "" : " hidden") + '">What happened?' +
        '<select class="an-q-err">' + errOpts + "</select></label>" +
        '<label class="an-detail-field">How much help did she need?<select class="an-q-sup">' + supOpts + "</select></label>" +
        '<label class="an-detail-field an-cx">How tricky was it? (1 = easy, 5 = hard)<input class="an-q-cx" type="number" min="1" max="5" value="' + (a.complexity || 2) + '" /></label>' +
        "</details>" +
        '<label class="an-approve"><input type="checkbox" class="an-q-ok"' + (a.parentApproved ? " checked" : "") + "> I've checked this one</label>" +
        "</div>";
    }).join("");
    // Mark an AI-prefilled attempt as parent-corrected when the parent edits it.
    const markCorrected = (a) => { if (enhanced) a.parentCorrected = true; };
    // Wire each row. Values write straight back into anDraft.attempts.
    wrap.querySelectorAll(".an-row").forEach((row) => {
      const i = Number(row.dataset.idx);
      const a = anDraft.attempts[i];
      row.querySelector(".an-q-text").addEventListener("input", (e) => {
        a.questionText = e.target.value;
        a.topic = guessTopic(a.questionText, anDraft.overall.subject);
        markCorrected(a);
      });
      const sa = row.querySelector(".an-q-sa"), ea = row.querySelector(".an-q-ea");
      if (sa) sa.addEventListener("input", (e) => { a.studentAnswer = e.target.value; markCorrected(a); });
      if (ea) ea.addEventListener("input", (e) => { a.expectedAnswer = e.target.value; markCorrected(a); });
      const aw = row.querySelector(".an-q-aw"), av = row.querySelector(".an-q-av");
      const syncMarks = () => {
        a.marksAwarded = aw.value === "" ? null : Number(aw.value);
        a.marksAvailable = av.value === "" ? null : Number(av.value);
        markCorrected(a);
        renderAnalyzerRows();
      };
      aw.addEventListener("change", syncMarks);
      av.addEventListener("change", syncMarks);
      row.querySelector(".an-tick").addEventListener("click", () => {
        const max = a.marksAvailable || 1; a.marksAvailable = max; a.marksAwarded = max; markCorrected(a); renderAnalyzerRows();
      });
      row.querySelector(".an-cross").addEventListener("click", () => {
        a.marksAvailable = a.marksAvailable || 1; a.marksAwarded = 0; markCorrected(a); renderAnalyzerRows();
      });
      row.querySelector(".an-q-cx").addEventListener("change", (e) => { a.complexity = Math.max(1, Math.min(5, Number(e.target.value) || 2)); markCorrected(a); });
      row.querySelector(".an-q-err").addEventListener("change", (e) => { a.errorType = e.target.value; markCorrected(a); });
      row.querySelector(".an-q-sup").addEventListener("change", (e) => { a.supportLevel = e.target.value; markCorrected(a); });
      row.querySelector(".an-q-ok").addEventListener("change", (e) => { a.parentApproved = e.target.checked; a.needsReview = !e.target.checked; });
      row.querySelector(".an-q-del").addEventListener("click", () => { anDraft.attempts.splice(i, 1); renderAnalyzerRows(); });
    });
  }

  async function saveAnalysis() {
    if (!anDraft) return;
    const attempts = anDraft.attempts.filter((a) => (a.questionText || "").trim() || a.marksAwarded != null);
    // Compute overall from marked attempts only.
    const marked = attempts.filter((a) => a.marksAvailable != null && a.marksAvailable > 0);
    let score = null;
    if (marked.length) {
      const got = marked.reduce((s, a) => s + (a.marksAwarded || 0), 0);
      const max = marked.reduce((s, a) => s + (a.marksAvailable || 0), 0);
      score = max > 0 ? Math.round((got / max) * 100) : null;
    }
    const cx = attempts.filter((a) => a.complexity);
    const avgComplexity = cx.length ? Math.round((cx.reduce((s, a) => s + a.complexity, 0) / cx.length) * 10) / 10 : null;
    // AI metadata is additive. Enhanced captures may delete the on-device photo
    // after approval; local captures always keep the photo (no cloud copy exists).
    const enhanced = anDraft.mode === "enhanced";
    const keep = $("an-keep-image") ? $("an-keep-image").checked === true : !enhanced;
    const record = {
      source: anDraft.source || "worksheet",
      mode: anDraft.mode || "local",
      provider: enhanced ? "anthropic" : null,
      aiConfidence: (anDraft.overall && anDraft.overall.aiConfidence) != null ? anDraft.overall.aiConfidence : null,
      imageDeletable: enhanced ? !keep : false,
      blobId: anDraft.blobId || null,
      overall: {
        subject: anDraft.overall.subject,
        score: score,
        avgComplexity: avgComplexity,
        reasoningSummary: (anDraft.overall && anDraft.overall.reasoningSummary) || "",
      },
      attempts: attempts,
    };
    // Delete-after-approval ordering: save the record with blobId nulled FIRST,
    // then delete the blob, so a failed delete never leaves a dangling pointer.
    if (enhanced && !keep && record.blobId) {
      const oldBlobId = record.blobId;
      record.blobId = null;
      await EduStore.addAnalysis(record);
      await EduStore.deleteBlob(oldBlobId);
    } else {
      await EduStore.addAnalysis(record);
    }
    anDraft = null;
    closeModal();
    renderAnalyzer();
  }

  async function renderAnalyzerList() {
    const list = $("an-list");
    if (!list) return;
    const rows = await EduStore.getAnalyses();
    if (!rows.length) {
      list.innerHTML = '<p class="empty">No worksheets yet — tap “📸 Scan a worksheet” to add the first one. 🌟</p>';
      return;
    }
    list.innerHTML = "";
    for (const r of rows) {
      const row = document.createElement("div");
      row.className = "an-card";
      let thumb = '<div class="thumb"></div>';
      if (r.blobId) {
        const b = await EduStore.getBlob(r.blobId);
        if (b && b.blob) thumb = '<img class="thumb" src="' + trackURL(URL.createObjectURL(b.blob)) + '" alt="worksheet" />';
      }
      const subj = SUBJECT_LABEL[r.overall && r.overall.subject] || (r.overall && r.overall.subject) || "";
      const scoreChip = (r.overall && r.overall.score != null) ? '<span class="score-badge">' + r.overall.score + "%</span>" : "";
      const cxChip = (r.overall && r.overall.avgComplexity != null) ? '<span class="chip">~ complexity ' + r.overall.avgComplexity + "</span>" : "";
      const approved = (r.attempts || []).filter((a) => a.parentApproved).length;
      const okChip = approved ? '<span class="chip an-ok">✓ ' + approved + " approved</span>" : "";
      const date = new Date(r.createdAt || Date.now()).toISOString().slice(0, 10);
      row.innerHTML = thumb +
        '<div class="entry-body"><div class="entry-top">' +
        '<span class="entry-subj">' + esc(subj) + "</span>" +
        '<span class="entry-date">' + esc(date) + "</span>" + scoreChip + "</div>" +
        '<div class="an-chips">' + cxChip + okChip + '<span class="chip">' + (r.attempts || []).length + " questions</span></div>" +
        "</div>" +
        '<button class="entry-del" aria-label="Delete">🗑</button>';
      row.querySelector(".entry-del").addEventListener("click", async () => {
        if (!confirm("Delete this worksheet?")) return;
        await EduStore.deleteAnalysis(r.id);
        renderAnalyzer();
      });
      list.appendChild(row);
    }
  }

  // ---- local insights (offline, evidence-only; only APPROVED attempts count) ----
  // These are "your recorded results, summarised" — NOT AI analysis. Every string
  // is count/time-bounded and free of deficit / identity / destiny language.
  async function renderAnalyzerInsights() {
    const el = $("an-insights");
    if (!el) return;
    const rows = await EduStore.getAnalyses();
    const approved = [];
    rows.forEach((r) => (r.attempts || []).forEach((a) => { if (a.parentApproved) approved.push(Object.assign({ _subject: r.overall && r.overall.subject }, a)); }));
    if (!approved.length) {
      el.innerHTML = '<div class="card an-insights"><p class="hint">Once you approve a few questions, a summary of your recorded results appears here. 🌱</p></div>';
      return;
    }
    const lines = [];
    // Per-topic "doing well / worth more practice" (partial-mark aware).
    const byTopic = {};
    approved.forEach((a) => {
      const key = a.topic || "general";
      const o = byTopic[key] || (byTopic[key] = { got: 0, max: 0, n: 0 });
      if (a.marksAvailable > 0) { o.got += a.marksAwarded || 0; o.max += a.marksAvailable; }
      o.n += 1;
    });
    Object.keys(byTopic).forEach((topic) => {
      const o = byTopic[topic];
      if (o.max <= 0) return;
      const pct = Math.round((o.got / o.max) * 100);
      const label = topic === "general" ? "these questions" : topic;
      if (pct >= 80) lines.push("You're doing well on " + esc(label) + " — " + pct + "% recorded so far. 🌟");
      else lines.push(esc(label.charAt(0).toUpperCase() + label.slice(1)) + " is worth a little more practice (" + pct + "% recorded). 💪");
    });
    // Complexity trend across worksheets (labelled "estimated").
    const withCx = rows.filter((r) => r.overall && r.overall.avgComplexity != null)
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).map((r) => r.overall.avgComplexity);
    let spark = "";
    if (withCx.length >= 2) {
      const first = withCx[0], last = withCx[withCx.length - 1];
      const dir = last > first ? "rising" : last < first ? "easing" : "steady";
      spark = '<p class="hint">Estimated challenge level is <b>' + dir + "</b> across " + withCx.length + " worksheets (" + first + " → " + last + "). 📈</p>";
    }
    // Optional error-category note (evidence only).
    const errCounts = {};
    approved.forEach((a) => { if (a.errorType) errCounts[a.errorType] = (errCounts[a.errorType] || 0) + 1; });
    const topErr = Object.keys(errCounts).sort((x, y) => errCounts[y] - errCounts[x])[0];
    if (topErr) {
      const lbl = (AN_ERROR_CATEGORIES.find((c) => c.key === topErr) || {}).label || topErr;
      lines.push("Most noted so far: “" + esc(lbl) + "” (" + errCounts[topErr] + "). Something to chat about together. 💬");
    }
    // School evidence echo (record + show only; read-only, caveated — §6b).
    let evidence = "";
    const mockEvidence = rows.filter((r) => r.source === "mock" && (r.attempts || []).some((a) => a.parentApproved)).length;
    if (mockEvidence) {
      evidence = '<p class="hint">📎 ' + mockEvidence + " approved mock worksheet" + (mockEvidence === 1 ? "" : "s") +
        " recorded as evidence. This is a record only — school readiness still comes from your Progress page.</p>";
    }
    el.innerHTML = '<div class="card an-insights"><h3>Your recorded results, summarised</h3>' +
      "<ul>" + lines.map((l) => "<li>" + l + "</li>").join("") + "</ul>" + spark + evidence + "</div>";
  }
  // ========== END HOMEWORK ANALYZER ==========

  // ============ SETTINGS ============
  async function renderSettings() {
    const el = $("app-version");
    if (el) el.textContent = "Education Planner · offline-first PWA";
    // Enhanced AI master switch (default OFF), persisted in EduStore meta.
    const toggle = $("set-enhanced-ai");
    if (toggle) {
      toggle.checked = (await EduStore.getMeta("analyzer.enhancedAi.enabled")) === true;
      if (!toggle.__wired) {
        toggle.__wired = true;
        toggle.addEventListener("change", async (e) => {
          await EduStore.setMeta("analyzer.enhancedAi.enabled", e.target.checked === true);
        });
      }
    }
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
      b.addEventListener("click", () => {
        showView(b.dataset.goto);
        // Optional one-tap hook: after switching view, click an in-view button
        // (e.g. open the lightweight capture modal straight from the dashboard).
        if (b.dataset.gotoThen) { const t = $(b.dataset.gotoThen); if (t) t.click(); }
      }));
    $("menu-btn").addEventListener("click", toggleDrawer);
    $("drawer-backdrop").addEventListener("click", closeDrawer);
    $("modal-close").addEventListener("click", closeModal);
    $("modal-backdrop").addEventListener("click", closeModal);
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if ($("modal") && !$("modal").classList.contains("hidden")) { closeModal(); return; }
      if ($("drawer").classList.contains("open")) { closeDrawer(); $("menu-btn").focus(); }
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
