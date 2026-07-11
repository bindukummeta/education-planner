/*
 * schools-seed.js — a small bundled list of target schools that seeds into
 * IndexedDB ONCE (only when the schools store is empty). It never overwrites
 * anything the user later adds or edits.
 *
 * Only fields that are reliably published on the official sites are filled in.
 * Dates, cut-offs and rankings change yearly and are frequently not published
 * by the schools themselves, so they are left blank on purpose — fill them in
 * inside the app rather than trusting a guessed value (they drive the RAG
 * readiness calculation).
 *
 * `postcode` is a new field used only for straight-line distance from the
 * home postcode; app.js geocodes it via postcodes.io and caches the result.
 */
(function () {
  "use strict";

  const SEED_SCHOOLS = [
    {
      name: "The Tiffin Girls' School",
      postcode: "KT2 5PL",
      distance: "",
      travelTime: "",
      nationalRanking: "",
      pan: "180",
      registration: "",
      examDate: "",
      resultsDate: "",
      subjectsSummary: "Two-stage test in English & Maths. Stage 1: multiple-choice English + Maths (computer-marked, under 60 min each). Stage 2: written English (reading comprehension + creative writing) + Maths.",
      testsSubjects: { vr: false, nvr: false, maths: true, english: true, creativeWriting: true },
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
      distance: "",
      travelTime: "",
      nationalRanking: "",
      pan: "",
      registration: "",
      examDate: "",
      resultsDate: "",
      subjectsSummary: "Two-stage test in English & Maths (no VR/NVR). Stage 1 (Sutton SET): multiple-choice English + Maths. Stage 2 (NWSSEE, joint with Wallington): written English (incl. a writing task) + Maths, not multiple-choice.",
      testsSubjects: { vr: false, nvr: false, maths: true, english: true, creativeWriting: true },
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
      distance: "",
      travelTime: "",
      nationalRanking: "",
      pan: "120",
      registration: "",
      examDate: "",
      resultsDate: "",
      subjectsSummary: "Two-round test. Round 1 (GL Assessment): multiple-choice Verbal Reasoning, Non-Verbal Reasoning & English (computer-marked); top ~300 invited to Round 2. Round 2: written English (comprehension + creative writing) + Maths.",
      testsSubjects: { vr: true, nvr: true, maths: true, english: true, creativeWriting: true },
      catchment: "",
      admissionNumbers: "",
      historicCutoffs: [],
      openDay: "",
      website: "https://www.hbschool.org.uk/",
      notes: "Non-denominational grammar for girls 11–18. Central Square, Hampstead Garden Suburb, London NW11 7BN. Tel 020 8458 8999.",
    },
  ];

  // Seed only when the schools store is empty, so it never clobbers user data.
  async function seedIfEmpty() {
    if (!window.EduStore) return false;
    const existing = await window.EduStore.getSchools();
    if (existing && existing.length) return false;
    for (const s of SEED_SCHOOLS) {
      await window.EduStore.saveSchool(Object.assign({}, s));
    }
    return true;
  }

  // Deletes ALL schools and re-inserts the seed. Destructive — call only after
  // an explicit user confirmation. Entries/photos are untouched.
  async function reseed() {
    if (!window.EduStore) return false;
    const existing = await window.EduStore.getSchools();
    for (const s of existing) await window.EduStore.deleteSchool(s.id);
    for (const s of SEED_SCHOOLS) {
      await window.EduStore.saveSchool(Object.assign({}, s));
    }
    return true;
  }

  window.SchoolsSeed = { SEED_SCHOOLS, seedIfEmpty, reseed };
})();
