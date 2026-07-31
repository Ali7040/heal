/**
 * The runner's view of the outcome store.
 *
 * Declared in `core` as a port, implemented in `packages/journal` later (phase 4).
 * The dependency rule is why: the runner must be able to consult a journal without
 * `core` ever importing SQLite, or anything else.
 *
 * `NullJournal` is not a placeholder to be replaced — it is the honest behaviour
 * of a system with no memory yet, and it stays useful forever as the `--no-journal`
 * code path. The runner has no branch for "journal disabled"; it just gets a
 * journal that never remembers anything.
 */
import type { Patch } from './patch.js';

export interface RecordedOutcome {
  readonly signature: string;
  readonly kind: string;
  readonly patch: Patch;
  /** Measured by the originating detector's re-run. Never self-reported. */
  readonly verified: boolean;
  readonly attempts: number;
}

export interface JournalPort {
  lookup(signature: string): Promise<RecordedOutcome | undefined>;
  record(outcome: RecordedOutcome): Promise<void>;
}

export class NullJournal implements JournalPort {
  async lookup(): Promise<RecordedOutcome | undefined> {
    return undefined;
  }

  async record(): Promise<void> {
    // Deliberately nothing.
  }
}
