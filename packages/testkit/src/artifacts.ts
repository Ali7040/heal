/**
 * What `self-heal init` writes to `.gitignore`, kept in one place.
 *
 * Not cosmetic. Run artifacts — the journal, evidence, recorded screenshots —
 * live inside the repository being measured, and an untracked file dirties the
 * tree, which halts the *next* run (invariant 5). A fixture without these entries
 * reproduces a bug in the tool rather than the bug it was written for.
 *
 * Deliberately not `.self-heal/` wholesale: recorded contracts and visual
 * baselines live there too, and those are reviewed and committed — they are the
 * only human judgement in the loop.
 */
export const IGNORED_ARTIFACTS = [
  '.self-heal/evidence/',
  '.self-heal/journal.sqlite',
  '.self-heal/journal.sqlite-*',
  '',
].join('\n');
