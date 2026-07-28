import type { Diagnosis } from './diagnosis.js';
import type { Patch } from './patch.js';

/**
 * The one place a model is allowed to be involved (D-001).
 *
 * How a fixer reaches a model — spawning the user's harness, or nothing at all — is
 * quarantined behind this interface (D-005). If the invocation mechanism changes,
 * exactly one package changes.
 */
export interface Fixer {
  readonly id: string;

  /**
   * Propose a patch. Returning an empty patch is a valid outcome, not a failure —
   * the runner treats it as "no proposal" and escalates rather than throwing.
   */
  propose(diagnosis: Diagnosis): Promise<Patch>;
}
