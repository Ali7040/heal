/**
 * Phase 4: the second occurrence of a known regression skips the model entirely.
 *
 * The economics are the point. A fix attempt costs a model call; a journal hit
 * costs a file read. Nothing else in the system changes a run's cost by that
 * much, which is why the signature work in phases 1 and 2 mattered — a journal
 * keyed on an unstable identity never hits, and never hitting makes it decoration.
 *
 * The rule that keeps it safe: **a journal hit is never trusted.** It is a cheaper
 * first guess. A replayed patch is applied, then measured by the originating
 * detector exactly like a fresh proposal, and a replay that fails falls back to
 * proposing. A patch also carries the hash of each file it was made against, and
 * the runner refuses to replay it once those files have moved on — whole-file
 * contents written onto a newer file would revert work no detector measures
 * (D-020). So a stale patch costs a fresh proposal, never correctness.
 *
 * Backed by `node:sqlite`, so this package still has zero dependencies.
 */
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { JournalPort, MeasuredOutcome, RecordedOutcome } from '@self-heal/core/contracts/journal';
import type { Patch } from '@self-heal/core/contracts/patch';

import type { DatabaseSync } from 'node:sqlite';

import { migrate, type OutcomeRow } from './schema.js';

/**
 * The slice of `node:sqlite` this package uses, spelled out.
 *
 * The import has to be dynamic so an older Node fails with a sentence instead of
 * a module-resolution stack trace — and naming only what is used keeps that
 * dynamic call from importing an untyped `any` back into the codebase.
 */
interface SqliteModule {
  readonly DatabaseSync: new (path: string) => DatabaseSync;
}

export interface JournalOptions {
  /**
   * Patches larger than this are measured, reported, and then not stored.
   *
   * A journal exists to make the *next* occurrence cheap. A patch rewriting a
   * generated file of several megabytes would bloat the file for every future
   * read to save one call, so the trade is refused rather than taken silently.
   */
  readonly maxPatchBytes?: number;
}

export const DEFAULT_MAX_PATCH_BYTES = 1_048_576;
export const DEFAULT_JOURNAL_PATH = '.self-heal/journal.sqlite';

export class UnsupportedRuntimeError extends Error {}

export interface JournalStats {
  readonly total: number;
  readonly verified: number;
  readonly replays: number;
}

/**
 * One remembered outcome, as a person would want to read it.
 *
 * Deliberately without the patch body. Listing what is remembered is a question
 * about *which* fixes are held and how they have behaved, and dumping whole file
 * contents into a terminal answers a different question badly.
 */
export interface JournalEntry {
  readonly signature: string;
  readonly kind: string;
  readonly verified: boolean;
  readonly attempts: number;
  readonly replays: number;
  readonly files: readonly string[];
  readonly firstSeen: string;
  readonly lastSeen: string;
}

/** Implements the port `core` declares, so the runner never learns SQLite exists. */
export interface Journal extends JournalPort {
  stats(): JournalStats;
  /** Most recently seen first — the order anyone investigating actually wants. */
  list(limit?: number): JournalEntry[];
  /**
   * Forget one outcome, by signature or by an unambiguous prefix of one.
   *
   * The escape hatch for a replay that keeps being offered and keeps being
   * wrong. It is a deletion rather than a "never replay this" flag on purpose:
   * the journal is a record of measurements, and a permanent veto stored beside
   * them would be an opinion, which is the one thing this table does not hold.
   *
   * Prefixes are accepted because every other surface — the run report, the
   * listing — shows eight characters. Printing a short id and then demanding the
   * long one is a small cruelty that shows up the first time anyone tries it.
   */
  forget(signature: string): ForgetResult;
  close(): void;
}

/** Ambiguity is a distinct outcome: deleting the wrong remembered fix is silent. */
export type ForgetResult =
  | { readonly status: 'forgotten'; readonly signature: string }
  | { readonly status: 'not-found' }
  | { readonly status: 'ambiguous'; readonly matches: readonly string[] };

export async function openJournal(path: string, options: JournalOptions = {}): Promise<Journal> {
  const { DatabaseSync } = await loadSqlite();
  await mkdir(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  // WAL so a long-running detector reading the journal cannot block a write, and
  // a timeout so two runs against one repository queue instead of failing.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);

  const maxPatchBytes = options.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES;

  const select = db.prepare('SELECT * FROM outcomes WHERE signature = ?');
  const upsert = db.prepare(`
    INSERT INTO outcomes (signature, kind, patch, verified, attempts, first_seen, last_seen, replays)
    VALUES (:signature, :kind, :patch, :verified, :attempts, :now, :now, 0)
    ON CONFLICT(signature) DO UPDATE SET
      kind      = excluded.kind,
      patch     = excluded.patch,
      verified  = excluded.verified,
      attempts  = excluded.attempts,
      last_seen = excluded.last_seen,
      -- first_seen is never overwritten: it answers "how long has this been
      -- happening", which is the one question a single row can answer.
      replays   = outcomes.replays + :saved
  `);

  return {
    async lookup(signature: string): Promise<RecordedOutcome | undefined> {
      const row = select.get(signature) as OutcomeRow | undefined;
      if (row === undefined) return undefined;

      const patch = parsePatch(row.patch);
      // A row whose patch will not parse is a corrupt row, not a crash. The
      // caller's fallback - propose a fresh fix - is exactly right for it.
      if (patch === null) return undefined;

      return {
        signature: row.signature,
        kind: row.kind,
        patch,
        verified: row.verified === 1,
        attempts: row.attempts,
      };
    },

    async record(outcome: MeasuredOutcome): Promise<void> {
      const serialized = JSON.stringify(outcome.patch);
      if (Buffer.byteLength(serialized, 'utf8') > maxPatchBytes) return;

      upsert.run({
        signature: outcome.signature,
        kind: outcome.kind,
        patch: serialized,
        verified: outcome.verified ? 1 : 0,
        attempts: outcome.attempts,
        now: new Date().toISOString(),
        // Only a replay that actually held up saved a model call. A replay that
        // failed cost one, and a fresh proposal was never free to begin with.
        saved: outcome.replayed && outcome.verified ? 1 : 0,
      });
    },

    list(limit = 20): JournalEntry[] {
      // `rowid` breaks the tie, and the tie is not hypothetical: two outcomes
      // recorded in the same millisecond share a `last_seen` to the millisecond,
      // and SQLite is then free to return them in any order. Without this the
      // listing is unstable exactly when a run heals several issues at once.
      const rows = db
        .prepare('SELECT * FROM outcomes ORDER BY last_seen DESC, rowid DESC LIMIT ?')
        .all(limit) as unknown as OutcomeRow[];

      return rows.map((row) => {
        const patch = parsePatch(row.patch);
        return {
          signature: row.signature,
          kind: row.kind,
          verified: row.verified === 1,
          attempts: row.attempts,
          replays: row.replays,
          files: patch?.edits.map((edit) => edit.path) ?? [],
          firstSeen: row.first_seen,
          lastSeen: row.last_seen,
        };
      });
    },

    forget(signature: string): ForgetResult {
      const matches = (
        db.prepare('SELECT signature FROM outcomes WHERE signature LIKE ? ORDER BY signature').all(`${signature}%`) as {
          signature: string;
        }[]
      ).map((row) => row.signature);

      if (matches.length === 0) return { status: 'not-found' };
      if (matches.length > 1) return { status: 'ambiguous', matches };

      const exact = matches[0] as string;
      db.prepare('DELETE FROM outcomes WHERE signature = ?').run(exact);
      return { status: 'forgotten', signature: exact };
    },

    stats(): JournalStats {
      const row = db
        .prepare('SELECT COUNT(*) AS total, SUM(verified) AS verified, SUM(replays) AS replays FROM outcomes')
        .get() as { total: number; verified: number | null; replays: number | null };
      return { total: row.total, verified: row.verified ?? 0, replays: row.replays ?? 0 };
    },

    close(): void {
      db.close();
    },
  };
}

function parsePatch(serialized: string): Patch | null {
  try {
    const parsed = JSON.parse(serialized) as Patch;
    return Array.isArray(parsed.edits) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * `node:sqlite` landed in Node 22.5. Older runtimes get a message that says what
 * to do, rather than a module-resolution stack trace — the loop still works
 * without a journal, it just pays for every occurrence.
 */
async function loadSqlite(): Promise<SqliteModule> {
  try {
    return await import('node:sqlite');
  } catch {
    throw new UnsupportedRuntimeError(
      `the journal needs node:sqlite (Node >= 22.5); this is ${process.version}. Run with --no-journal, or upgrade Node.`,
    );
  }
}
