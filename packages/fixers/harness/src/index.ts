import type { Diagnosis } from '@self-heal/core/contracts/diagnosis';
import type { Fixer } from '@self-heal/core/contracts/fixer';
import type { Patch } from '@self-heal/core/contracts/patch';

/**
 * The one genuinely unknown piece of the design (ARCHITECTURE.md §5, D-005).
 *
 * How to trigger a harness non-interactively and capture a patch is settled by a
 * timeboxed phase-0 spike, not by reasoning about it. Until then this package
 * exists only to prove the uncertainty is quarantined: when the mechanism lands,
 * this file changes and nothing in `core`, no detector, and no safety code does.
 */
export interface HarnessFixerOptions {
  /** Executable to spawn, e.g. `claude`. */
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly timeoutMs?: number;
}

export class HarnessFixer implements Fixer {
  readonly id = 'harness';

  readonly options: HarnessFixerOptions;

  constructor(options: HarnessFixerOptions) {
    this.options = options;
  }

  async propose(_diagnosis: Diagnosis): Promise<Patch> {
    throw new Error(
      `HarnessFixer is not implemented: phase-0 spike pending (see ARCHITECTURE.md §5). ` +
        `Configured command: ${this.options.command}`,
    );
  }
}
