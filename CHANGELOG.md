# Changelog

All notable changes to the Education Planner app are documented here.
The format is loosely based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

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
