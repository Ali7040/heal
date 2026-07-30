/**
 * Run a fixture's check and report what it measured.
 *
 * This is the entire "is it broken?" question, reduced to an exit code. It has
 * no access to a model, no notion of what a patch is, and no opinion about why
 * something failed — which is exactly the property that makes a later `HEALED`
 * meaningful (D-001, D-002).
 *
 * The same function is called before and after a fix attempt. Calling it twice
 * with the same code path is the point: a verification that ran different logic
 * from the detection would not be a verification.
 */
import { runCommand } from '@self-heal/core/process';

import type { Fixture } from './fixtures.js';

export interface Measurement {
  readonly healthy: boolean;
  readonly exitCode: number | null;
  /** Combined output, trimmed — this is what gets handed to a fixer as evidence. */
  readonly output: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

export async function measure(fixture: Fixture, dir: string, timeoutMs = 30_000): Promise<Measurement> {
  const result = await runCommand(fixture.check.command, fixture.check.args, { cwd: dir, timeoutMs });

  return {
    // A timeout is not health. Only a clean exit 0 counts as healthy.
    healthy: result.ok,
    exitCode: result.code,
    output: `${result.stdout}${result.stderr}`.trim(),
    durationMs: result.durationMs,
    timedOut: result.timedOut,
  };
}
