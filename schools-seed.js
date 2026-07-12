/*
 * schools-seed.js — a small bundled list of target schools that seeds into
 * IndexedDB ONCE (only when the schools store is empty). It never overwrites
 * anything the user later adds or edits.
 *
 * Only fields that are reliably published on the official sites are filled in.
 * Registration/key dates are for the current cycle and are marked to re-check
 * yearly. National rankings are from The Times / Sunday Times Parent Power Best
 * Schools 2026 table and are marked to re-check yearly (they change annually).
 * Cut-offs change yearly and are frequently not published by the schools
 * themselves, so they are left blank on purpose — fill them in inside the app
 * rather than trusting a guessed value (they drive the RAG readiness calc).
 *
 * `postcode` drives the straight-line distance shown on each card: app.js
 * geocodes it via postcodes.io (cached) and measures from the home postcode.
 * There is no manual distance/travel-time field — distance is computed.
 *
 * Seed-owned factual fields (ranking, subjects, registration, etc.) are kept
 * current on existing preset records by migrate(): bump SEED_VERSION when they
 * change and it refreshes them on load without a destructive reset and without
 * overwriting the user's own edits (cut-offs, exam/results dates, open day…).
 */
(function () {
  "use strict";

  // Bump whenever the factual seed fields below change (ranking, subjects,
  // registration, etc.). On load, migrate() refreshes those fields on existing
  // preset records whose stored version is older — so improvements reach users
  // without a destructive reset and without touching their own edits.
  const SEED_VERSION = 9;

  // Fields owned by the seed (authoritative, refreshed on a version bump).
  const SEED_OWNED = [
    "postcode", "nationalRanking", "pan", "examBoard", "registration",
    "subjectsSummary", "testsSubjects", "website", "notes",
  ];

  // Meta key holding the list of preset names ever introduced onto this device.
  // Lets migrate() insert genuinely-new presets exactly once while never
  // resurrecting a preset the user deleted on purpose.
  const INTRODUCED_KEY = "seedIntroducedNames";

  // Presets that shipped before the introduced-names watermark existed. On the
  // first run of the watermark-aware migrate() we treat these as already
  // introduced, so a user who had deleted one of them won't have it re-added.
  const LEGACY_SEED_NAMES = [
    "The Tiffin Girls' School",
    "Nonsuch High School for Girls",
    "The Henrietta Barnett School",
  ];

  const SEED_SCHOOLS = [
    {
      name: "The Tiffin Girls' School",
      postcode: "KT2 5PL",
      nationalRanking: "National 5 (The Sunday Times / The Times Parent Power Best Schools 2026, top state secondary schools). ⚠ Re-check yearly.",
      pan: "180",
      examBoard: "Bespoke / consortium",
      registration: "2027 entry: online Supplementary Information Form (SIF) opens Tue 2 Jun 2026, closes 12:00 noon Tue 1 Sep 2026 (firm deadline, no late entries). Open Evening Tue 7 Jul 2026. ⚠ Re-check dates each year on the school site.",
      examDate: "",
      resultsDate: "",
      subjectsSummary: "Two-stage test in English & Maths. Stage 1: multiple-choice English + Maths (computer-marked, under 60 min each). Stage 2: written English (reading comprehension + creative writing) + Maths.",
      testsSubjects: { vr: false, nvr: false, maths: true, english: true, creativeWriting: true },
      targetDifficulty: "hard",
      catchment: "",
      admissionNumbers: "",
      historicCutoffs: [],
      openDay: "",
      website: "https://www.tiffingirls.org/",
      notes: "Selective state grammar for girls 11–18, Kingston upon Thames. Richmond Road, Kingston upon Thames, Surrey KT2 5PL.",
    },
    {
      name: "Nonsuch High School for Girls",
      postcode: "SM3 8AB",
      nationalRanking: "National 13 (The Sunday Times / The Times Parent Power Best Schools 2026; also State Secondary School of the Year in the Southeast 2026). ⚠ Re-check yearly.",
      pan: "210",
      examBoard: "Bespoke / consortium",
      registration: "2027 entry (Sutton SET consortium): registration opens Fri 1 May 2026, closes Fri 31 Jul 2026 (access-arrangements deadline Fri 12 Jun 2026). SET Tue 15 Sep 2026; Stage 2 (NWSSEE, with Wallington) Sat 26 Sep 2026. Also name Nonsuch on the LA Common Application Form by 31 Oct. ⚠ Re-check dates each year.",
      examDate: "",
      resultsDate: "",
      subjectsSummary: "Two-stage test in English & Maths (no VR/NVR). Stage 1 (Sutton SET): multiple-choice English + Maths. Stage 2 (NWSSEE, joint with Wallington): written English (incl. a writing task) + Maths, not multiple-choice.",
      testsSubjects: { vr: false, nvr: false, maths: true, english: true, creativeWriting: true },
      targetDifficulty: "hard",
      catchment: "",
      admissionNumbers: "",
      historicCutoffs: [],
      openDay: "",
      website: "https://www.nonsuchschool.org/",
      notes: "Part of the Girls' Learning Trust. Ewell Road, Cheam, Surrey SM3 8AB. Tel 020 8394 3400.",
    },
    {
      name: "The Henrietta Barnett School",
      postcode: "NW11 7BN",
      nationalRanking: "National 8 (The Sunday Times / The Times Parent Power Best Schools 2026, top state secondary schools). ⚠ Re-check yearly.",
      pan: "120",
      examBoard: "GL Assessment",
      registration: "2027 entry: online entrance-test registration opens ~1 Apr 2026, closes 5pm Wed 1 Jul 2026 (no late applications). Open Day 30 Jun 2026 (booking required). Round 1 early Sep 2026. ⚠ Re-check dates each year on the school site.",
      examDate: "",
      resultsDate: "",
      subjectsSummary: "Two-round test. Round 1 (GL Assessment): multiple-choice Verbal Reasoning, Non-Verbal Reasoning & English (computer-marked); top ~300 invited to Round 2. Round 2: written English (comprehension + creative writing) + Maths.",
      testsSubjects: { vr: true, nvr: true, maths: true, english: true, creativeWriting: true },
      targetDifficulty: "hard",
      catchment: "",
      admissionNumbers: "",
      historicCutoffs: [],
      openDay: "",
      website: "https://www.hbschool.org.uk/",
      notes: "Non-denominational grammar for girls 11–18. Central Square, Hampstead Garden Suburb, London NW11 7BN. Tel 020 8458 8999.",
    },
    {
      name: "Wallington High School for Girls",
      postcode: "SM6 0PH",
      nationalRanking: "National 24 (The Sunday Times / The Times Parent Power Best Schools 2026; 10th in London). ⚠ Re-check yearly.",
      pan: "210",
      examBoard: "Bespoke / consortium",
      registration: "2027 entry (Sutton SET consortium): registration opens Fri 1 May 2026, closes Fri 31 Jul 2026 (access-arrangements deadline Fri 12 Jun 2026). SET Tue 15 Sep 2026; Stage 2 (NWSSEE, with Nonsuch) Sat 26 Sep 2026. Also name Wallington on the LA Common Application Form by 31 Oct. ⚠ Re-check dates each year.",
      examDate: "",
      resultsDate: "",
      subjectsSummary: "Two-stage test in English & Maths (no VR/NVR). Stage 1 (Sutton SET): multiple-choice English + Maths. Stage 2 (NWSSEE, joint with Nonsuch): written English (incl. a writing task, no comprehension) + Maths, not multiple-choice (each paper 40–50 min).",
      testsSubjects: { vr: false, nvr: false, maths: true, english: true, creativeWriting: true },
      targetDifficulty: "hard",
      catchment: "",
      admissionNumbers: "",
      historicCutoffs: [],
      openDay: "",
      website: "https://www.wallingtongirls.org.uk/",
      notes: "Part of the Girls' Learning Trust. Woodcote Road, Wallington, Surrey SM6 0PH. Tel 020 8394 3400 (admissions@girlslearningtrust.org).",
    },
    {
      name: "Watford Grammar School for Girls",
      postcode: "WD18 0AE",
      nationalRanking: "National 111 (SchoolGuide Top 200 State Secondary 2026 — NOT the Parent Power table used for the other schools; partially selective, so it doesn't appear in the Parent Power grammar list). ⚠ Different source; re-check yearly.",
      pan: "210",
      examBoard: "GL Assessment",
      registration: "2027 entry (SW Herts Consortium): register for the tests at swhertsschools.org.uk (window ~late Apr–mid Jun 2026); also apply via your home LA by 31 Oct 2026. Test ~5 Sep 2026; results ~Oct. ⚠ Re-check dates each year.",
      examDate: "",
      resultsDate: "",
      subjectsSummary: "SW Herts Consortium test (GL Assessment): Maths + Verbal Reasoning, ~50 min each. ⚠ Only 52 of 210 places (25%) are academic-selective — 137 are distance/community places (non-selective) + 21 music aptitude.",
      testsSubjects: { vr: true, nvr: false, maths: true, english: false, creativeWriting: false },
      targetDifficulty: "medium",
      catchment: "",
      admissionNumbers: "",
      historicCutoffs: [],
      openDay: "",
      website: "https://www.watfordgrammarschoolforgirls.org.uk/",
      notes: "Partially selective academy for girls 11–18. Lady's Close, Watford WD18 0AE. Tel 01923 223403. ⚠ Academic places are restricted to the school's Admission Area (Watford-area postcodes); check whether your postcode qualifies before relying on this.",
    },
    {
      name: "Beaconsfield High School",
      postcode: "HP9 1RR",
      nationalRanking: "National 57 (The Sunday Times / The Times Parent Power Best Schools 2026; 56th among grammar schools). ⚠ Re-check yearly.",
      pan: "180",
      examBoard: "Other",
      registration: "2027 entry (Buckinghamshire): register for the Bucks Secondary Transfer Test with Buckinghamshire Council ~1 May–2 Jun 2026 (state-school pupils in Bucks are entered automatically). Test ~10 Sep 2026; name the school on your LA form by 31 Oct 2026. ⚠ Re-check dates each year.",
      examDate: "",
      resultsDate: "",
      subjectsSummary: "Buckinghamshire Secondary Transfer Test (STT), qualifying score 121. Two papers covering Verbal Reasoning, Non-Verbal Reasoning and Maths (GL-style, administered by Bucks Council). ⚠ Catchment-based: out-of-catchment qualified applicants are ranked lower.",
      testsSubjects: { vr: true, nvr: true, maths: true, english: false, creativeWriting: false },
      targetDifficulty: "medium",
      catchment: "",
      admissionNumbers: "",
      historicCutoffs: [],
      openDay: "",
      website: "https://www.beaconsfieldhigh.school/",
      notes: "Buckinghamshire girls' grammar 11–18 (Ofsted Outstanding). Wattleton Road, Beaconsfield HP9 1RR. Tel 01494 673043. ⚠ Requires the separate Bucks 11+ (STT) and is catchment-based — a stretch from a TW13 base.",
    },
  ];

  function stamp(seed) {
    return Object.assign({}, seed, { seedSchoolVersion: SEED_VERSION });
  }

  // Read the watermark of preset names ever introduced onto this device.
  // Returns a plain object used as a set ({ name: true }).
  async function getIntroduced() {
    if (!window.EduStore || !window.EduStore.getMeta) return null;
    const stored = await window.EduStore.getMeta(INTRODUCED_KEY);
    if (!Array.isArray(stored)) return null;
    const set = {};
    for (const n of stored) set[n] = true;
    return set;
  }
  async function setIntroduced(set) {
    if (!window.EduStore || !window.EduStore.setMeta) return;
    await window.EduStore.setMeta(INTRODUCED_KEY, Object.keys(set));
  }
  function allSeedNames() {
    return SEED_SCHOOLS.map((s) => s.name);
  }

  // Seed only when the schools store is empty, so it never clobbers user data.
  async function seedIfEmpty() {
    if (!window.EduStore) return false;
    const existing = await window.EduStore.getSchools();
    if (existing && existing.length) return false;
    for (const s of SEED_SCHOOLS) {
      await window.EduStore.saveSchool(stamp(s));
    }
    // Record every seeded name so migrate() never re-adds one after deletion.
    const set = {};
    for (const n of allSeedNames()) set[n] = true;
    await setIntroduced(set);
    return true;
  }

  // Non-destructive migrate. Two responsibilities:
  //  1) Refresh the seed-owned (authoritative) fields on existing preset
  //     records whose stored seedSchoolVersion is older than SEED_VERSION.
  //  2) Insert genuinely-new presets (never seen on this device) exactly once,
  //     tracked via the INTRODUCED_KEY watermark so a preset the user deleted
  //     on purpose is never resurrected.
  // Matches by name, preserves each record's id/createdAt and every user-owned
  // field (historic cut-offs, exam/results dates, open day, catchment, etc.),
  // and never touches schools the user added themselves. Returns the number of
  // records updated or inserted. Entries/photos are untouched.
  async function migrate() {
    if (!window.EduStore) return 0;
    const existing = await window.EduStore.getSchools();
    if (!existing || !existing.length) return 0;
    const byName = {};
    for (const e of existing) byName[e.name] = e;

    // First run of the watermark-aware code: seed the watermark with the
    // legacy presets (plus any of them still present) so previously-deleted
    // legacy presets are treated as already introduced, not new.
    let introduced = await getIntroduced();
    if (!introduced) {
      introduced = {};
      for (const n of LEGACY_SEED_NAMES) introduced[n] = true;
      for (const e of existing) introduced[e.name] = true;
    }

    let changed = 0;
    for (const seed of SEED_SCHOOLS) {
      const cur = byName[seed.name];
      if (!cur) {
        // Not currently in the DB. Insert it only if it's a genuinely-new
        // preset we've never introduced here; otherwise the user deleted it.
        if (!introduced[seed.name]) {
          await window.EduStore.saveSchool(stamp(seed));
          introduced[seed.name] = true;
          changed++;
        }
        continue;
      }
      introduced[seed.name] = true; // present now — record it
      // Fill-if-missing: targetDifficulty is user-owned (not in SEED_OWNED), so
      // we only seed a suggested default when the record has none yet. This
      // backfills presets that predate the field without clobbering user edits,
      // and runs even for records already at the current version.
      const needsFill = !cur.targetDifficulty && seed.targetDifficulty;
      const needsVersion = (cur.seedSchoolVersion || 0) < SEED_VERSION;
      if (!needsFill && !needsVersion) continue; // up to date
      const next = Object.assign({}, cur);
      if (needsFill) next.targetDifficulty = seed.targetDifficulty;
      if (needsVersion) {
        for (const f of SEED_OWNED) next[f] = seed[f];
        next.seedSchoolVersion = SEED_VERSION;
      }
      await window.EduStore.saveSchool(next);
      changed++;
    }
    await setIntroduced(introduced);
    return changed;
  }

  // Deletes ALL schools and re-inserts the seed. Destructive — call only after
  // an explicit user confirmation. Entries/photos are untouched.
  async function reseed() {
    if (!window.EduStore) return false;
    const existing = await window.EduStore.getSchools();
    for (const s of existing) await window.EduStore.deleteSchool(s.id);
    for (const s of SEED_SCHOOLS) {
      await window.EduStore.saveSchool(stamp(s));
    }
    // A reset re-introduces every preset, so reset the watermark accordingly.
    const set = {};
    for (const n of allSeedNames()) set[n] = true;
    await setIntroduced(set);
    return true;
  }

  window.SchoolsSeed = { SEED_SCHOOLS, SEED_VERSION, seedIfEmpty, migrate, reseed };
})();
