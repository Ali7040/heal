import type { Diagnosis } from '@self-heal/core/contracts/diagnosis';
import type { Fixer } from '@self-heal/core/contracts/fixer';
import type { Patch } from '@self-heal/core/contracts/patch';

/**
 * A fixer that proposes nothing.
 *
 * This is what the state machine is tested against — the whole loop runs end to end
 * with no network and no model call, which is the point (AGENTS.md, testing
 * expectations). It is also what `--dry-run` exercises in development.
 */
export class NoopFixer implements Fixer {
  readonly id = 'noop';

  readonly proposals: Diagnosis[] = [];

  async propose(diagnosis: Diagnosis): Promise<Patch> {
    this.proposals.push(diagnosis);
    return {
      fixerId: this.id,
      signature: diagnosis.issue.signature,
      edits: [],
      rationale: `noop: would diagnose ${diagnosis.issue.kind} across ${diagnosis.slices.length} slice(s)`,
    };
  }
}
