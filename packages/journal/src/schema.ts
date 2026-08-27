/**
 * Not a cache of answers — a record of measured outcomes.
 *
 * `verified` is written from the originating detector's re-run, never from a
 * model's claim of success. That distinction is the whole value of this table:
 * without it, this would be a store of things a model once said, which is worth
 * nothing.
 *
 * Migrations exist from the first version on purpose. This file lives in a user's
 * repository and outlives the release that created it, so "just delete it and
 * start again" is a real cost — every discarded row is a model call somebody has
 * to pay for a second time.
 */
import type { DatabaseSync } from 'node:sqlite';

export interface OutcomeRow {
  readonly signature: string;
  readonly kind: string;
  /** JSON-serialized `Patch`. */
  readonly patch: string;
  readonly verified: number;
  readonly attempts: number;
  readonly first_seen: string;
  readonly last_seen: string;
  /** How many times a replay of this row was tried and measured healthy. */
  readonly replays: number;
}

/**
 * Each entry migrates the database from `index` to `index + 1`.
 *
 * Append only. Editing a migration that has already shipped changes what an
 * existing file means without changing its version, which is the one mistake a
 * migration system cannot recover from.
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE IF NOT EXISTS outcomes (
    signature    TEXT PRIMARY KEY,
    kind         TEXT NOT NULL,
    patch        TEXT NOT NULL,
    verified     INTEGER NOT NULL,  -- 0/1 - measured, never self-reported
    attempts     INTEGER NOT NULL,
    first_seen   TEXT NOT NULL,
    last_seen    TEXT NOT NULL,
    replays      INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS outcomes_verified ON outcomes (verified);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function migrate(db: DatabaseSync): number {
  const current = readVersion(db);
  if (current > SCHEMA_VERSION) {
    // A file written by a newer self-heal. Refusing beats guessing: the columns
    // this build knows about might mean something different there.
    throw new Error(
      `journal schema is version ${current}, but this build understands ${SCHEMA_VERSION}. Upgrade self-heal, or point --journal at a different file.`,
    );
  }

  for (let version = current; version < SCHEMA_VERSION; version += 1) {
    // One transaction per step, so a failure half way through a chain leaves the
    // file at the last version that fully applied rather than in between two.
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version] as string);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return SCHEMA_VERSION;
}

function readVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return typeof row?.user_version === 'number' ? row.user_version : 0;
}
