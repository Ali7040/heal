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
 * proposing. So a stale patch costs a little time and can never cost correctness.
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

/** Implements the port `core` declares, so the runner never learns SQLite exists. */
export interface Journal extends JournalPort {
  stats(): JournalStats;
  close(): void;
}

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
