# Changelog

All notable changes to the Education Planner app are documented here.
The format is loosely based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Profiles — per-child picker inside the family login

- **"Who's practising?" profile picker.** A new profile pill in the top-right of
  the header shows the active child (coloured initial + name). Tapping it opens a
  picker to **switch child**, **+ Add child**, **rename** (✏️), or **remove** (✕).
  Switching instantly re-scopes the whole app — dashboard, Analyzer worksheets,
  Practice, Play & Create, Curiosity, Daily Log, Homework, Reading, Mocks, and
  per-child game/practice mastery — to the selected child.
- **All practice data is now per-child.** Daily Log, Homework, Reading, and Mocks
  join the already-scoped stores; records made before profiles existed are treated
  as belonging to the first child, so nothing is lost. Backups export every
  child's data.
- **The child list syncs; the active selection stays on the device.** Adding /
  renaming / removing a child propagates across devices via the existing Family
  Sync, while which child is "active" is remembered per device — so two devices
  can have different children open at once.
- **Safe by design.** You can't remove the last child; removing the active child
  falls back to the first remaining one. A removed child's worksheets are kept
  (hidden) rather than hard-deleted.
- **Under the hood.** New `updateStudent` / `deleteStudent` in storage; the four
  previously-global stores now filter by active student (with an `*ALL*` opt-out
  used by export); new pure helpers `resolveActiveStudent` / `sortStudents` /
  `studentInitial` / `studentColor` (unit-tested). Service worker cache bumped
  v55 → v56.

### Practice — generate similar questions with AI (opt-in, all subjects)

- **"Generate similar (AI) ✨" for any subject.** Blind-spot buckets the offline
  engine can't reproduce — English and every non-maths subject, plus maths topics
  like fractions, geometry, and measures — now offer a cloud-generated practice
  option. It creates fresh, auto-checkable questions that mirror the same skill
  and difficulty as the child's own wrong questions.
- **Off by default, gated + consented.** The button only appears when the
  **Enhanced AI** master switch is on, and each use asks for explicit consent
  before anything leaves the device. **Privacy by design:** only the derived
  question text and expected answers are sent — never photos, names, or notes.
- **Bonus practice, checked the same way.** Generated questions run through the
  same session loop and lenient matching as offline practice, and (like the maths
  generator) they're ephemeral bonus reps that never graduate the stored list.
- **Under the hood.** New serverless endpoint `api/generate-practice.js`
  (Anthropic, Structured Outputs for guaranteed-valid JSON) mirroring the coach
  and analyse-homework conventions; new client `generatePracticeQuestions()`; new
  `test/generate-practice-api.test.js`. Service worker cache bumped v54 → v55.

### Practice — re-attempt weak-area questions (offline)

- **New "Practice" section.** Questions the Homework Analyzer marked incorrect or
  partial are grouped into weak-area buckets by **subject + topic + error type**
  and offered back to the child to try again, so practice targets real blind
  spots rather than random drills. Fully offline — it reads the worksheet
  attempts already stored on-device.
- **Answer once, master, clear.** The child types an answer; it's checked
  leniently against the expected answer the Analyzer recorded (trim / case /
  spacing insensitive, and `1/2` counts as `0.5`). Questions with no stored
  expected answer fall back to a **"Show answer"** flashcard reveal, and a parent
  can **"Mark it right anyway"** to override the auto-check. Each question clears
  from the list after 2 correct attempts. Per-question mastery persists in meta
  (`practiceMastery.<studentId>`) so it survives across devices via backup/sync.
- **Generate more (maths).** For arithmetic blind-spot buckets, a **"Generate
  more like these ✨"** button reuses the offline Number Ninja generator to serve
  fresh, auto-checkable questions of the same operation (+, −, ×, ÷, or order of
  operations), inferred from the operators in the child's own wrong questions.
  These generated reps are bonus practice — they're checked leniently but do not
  graduate the stored blind-spot list. Still fully offline; no AI/network.
- **Under the hood.** New pure, unit-tested analytics (`blindSpotGroups`,
  `normalizeAnswer`, `answersMatch`, `mathsNinjaCatForGroup`) added to the shared
  analytics block. Service worker cache bumped v52 → v54.

### Cross-device Family Sync (optional, offline-first)

- **New: optional cloud sync via Supabase.** A new "Family Sync" card in Settings
  lets you sign in with a single shared family email (passwordless **magic link**)
  so data appears across your devices. It is **additive and off by default** —
  with no network or no configured `sync-config.js`, the app boots and behaves
  exactly as before (IndexedDB stays the local source-of-truth).
- **How it works.** Local writes are queued (`_dirty`) and deletes leave
  tombstones (`_tombstones`); a background engine (`sync.js`) pushes them to a
  single generic `records` table and pulls remote changes. Conflicts resolve
  **last-write-wins** by a client-authored `updatedAt`. Worksheet/mock photos
  sync via a private Supabase Storage bucket (`blobs`) — image bytes never live
  in DB rows. Sync triggers on sign-in, app foreground, coming online, a short
  debounce after edits, and a manual **"Sync now"** button.
- **Config & security.** Supabase URL + anon key live in `sync-config.js`. The
  **anon key is public by design and safe to ship** — real protection comes from
  Row Level Security (RLS), which restricts every row to authenticated sessions.
  Enabling sync means the child's data leaves the device and is stored in
  Supabase; leave it off to stay fully on-device.
- **Local schema.** IndexedDB bumped `DB_VERSION` 5 → 6 (guarded migration; all
  existing data preserved). Service worker cache bumped v33 → v34.

### Play & Create — Spelling Wizard

- **New game: Spelling Wizard.** A letter-tile spelling game in the Play & Create
  section: 6 words per round, each with a meaning hint and a "Hear the word"
  button (reads it aloud via speech synthesis). The child taps shuffled letter
  tiles to build the spelling, with Undo/Clear and a "Show answer" option.
- **Instant feedback + flow.** Auto-checks once all letters are placed; a correct
  spelling auto-advances after a brief pause, while a wrong one reveals the
  correct spelling and waits for a tap so the child can study it.
- **Remembers what the child knows.** Uses the same per-student, per-word mastery
  seam as Vocabulary Quest (stored via `EduStore` meta), so mastered spellings
  appear far less often while un-mastered ones are favoured.
- **Saves to progress.** Results can be logged to the daily log under English.

### Play & Create — Vocabulary Quest

- **New game: Vocabulary Quest.** A multiple-choice word-meaning game in the
  Play & Create section: 8 questions per round, instant colour feedback,
  running score, a results screen, "Play again", and an optional
  "Save to progress" that logs the round to the daily log (VR).
- **Full-screen play.** Games now open as a true full-screen cover
  (edge to edge, safe-area aware) so the child stays focused on the game
  rather than the dashboard behind it.
- **Auto-close on save.** "Save to progress" now closes the dialog
  automatically once the round is saved.
- **Harder words.** Expanded the word bank from 24 to 41 entries with more
  challenging 11+ vocabulary.
- **Remembers what the child knows.** Per-student, per-word mastery
  (seen/correct counts) is stored so the game adapts over time.
- **Less repetition.** Word selection is mastery-weighted: un-mastered words
  are strongly favoured, while mastered words appear far less often (but still
  resurface occasionally for review).
- **Auto-advance on correct answers.** A correct answer moves to the next
  question automatically after a brief pause; wrong answers wait for a tap so
  the correct meaning can be read.
- **"I don't know" option.** A distinct opt-out button lets the child be honest
  instead of guessing; it reveals the meaning kindly and keeps the word in
  rotation (not counted as known).

### App

- **Smarter update prompt.** The "Reload" prompt now appears only when a genuine
  new version is available and hides once the update is applied, so users are no
  longer left with a lingering prompt (and it no longer shows on first install).

### Tests

- Added `test/vocab-quest.test.js` covering the word bank integrity and the pure
  quiz/selection logic (`buildVocabQuiz`, `pickVocabWords`, `shuffleArr`),
  including mastery weighting and determinism.
- Added `test/spelling-wizard.test.js` covering the spelling word bank integrity
  and the pure round/selection logic (`buildSpellRound`, `pickSpellWords`),
  including tile integrity, mastery weighting and determinism.
