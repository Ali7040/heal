/**
 * One non-interactive harness run.
 *
 * Everything uncertain about driving someone else's CLI is concentrated here:
 * process spawning, timeouts, output parsing, and the fact that a harness can
 * fail in three genuinely different ways —
 *
 *   - it never started       (not installed, not on PATH)
 *   - it started and hung    (waiting on something we cannot see)
 *   - it ran and failed      (rate limit, auth expired, refused the task)
 *
 * The loop needs to tell these apart: the first two mean "stop, this environment
 * is broken", while the third is an ordinary failed attempt that counts against
 * the retry cap. Collapsing them into one boolean would make the circuit breaker
 * trip on a missing binary and burn a user's attempt budget for nothing.
 */
import { commandExists, runCommand } from '@self-heal/core/process';

import {
  DEFAULT_ALLOW_TOOLS,
  DEFAULT_DENY_TOOLS,
  type HarnessProfile,
  type HarnessRunSummary,
} from './profiles.js';

export type HarnessFailure = 'unavailable' | 'timeout' | 'unparseable' | 'run-failed';

export interface InvokeOptions {
  readonly profile: HarnessProfile;
  readonly prompt: string;
  /** Working directory. Must be a sandbox — never the user's repository. */
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly allowTools?: readonly string[];
  readonly denyTools?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface InvokeResult {
  readonly ok: boolean;
  readonly failure: HarnessFailure | null;
  readonly summary: HarnessRunSummary | null;
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly stderr: string;
}

/** A model turn is slow; a hung one is unbounded. Five minutes is the ceiling. */
export const DEFAULT_HARNESS_TIMEOUT_MS = 300_000;

export async function invokeHarness(options: InvokeOptions): Promise<InvokeResult> {
  const { profile } = options;

  // Pre-flight, before spending a timeout or an attempt: a harness that is not
  // installed is an environment problem the user has to fix, and saying so
  // plainly beats a confusing "the fix failed".
  if (!(await commandExists(profile.command))) {
    return {
      ok: false,
      failure: 'unavailable',
      summary: null,
      durationMs: 0,
      exitCode: null,
      stderr: `harness command not found on PATH: ${profile.command}`,
    };
  }

  const args = profile.buildArgs({
    prompt: options.prompt,
    allowTools: options.allowTools ?? DEFAULT_ALLOW_TOOLS,
    denyTools: options.denyTools ?? DEFAULT_DENY_TOOLS,
  });

  const result = await runCommand(profile.command, args, {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs ?? DEFAULT_HARNESS_TIMEOUT_MS,
    ...(options.signal ? { signal: options.signal } : {}),
    // Prompts go down the pipe, not through argv, so no shell ever re-parses
    // them. See the note on `promptDelivery` in profiles.ts.
    ...(profile.promptDelivery === 'stdin' ? { stdin: options.prompt } : {}),
    // Two env flags matter here:
    //   CI=1        nudges tools toward non-interactive behaviour.
    //   NO_COLOR=1  keeps ANSI escapes out of text we parse and log.
    env: { CI: '1', NO_COLOR: '1' },
  });

  const base = {
    durationMs: result.durationMs,
    exitCode: result.code,
    stderr: result.stderr.trim().slice(0, 2000),
  };

  if (result.timedOut) {
    return { ok: false, failure: 'timeout', summary: null, ...base };
  }
  // A null exit code with no timeout means spawn itself failed — the binary is
  // not there. That is an environment problem, not a failed fix attempt.
  if (result.code === null) {
    return { ok: false, failure: 'unavailable', summary: null, ...base };
  }

  const summary = profile.parseResult(result.stdout);
  if (summary === null) {
    return { ok: false, failure: 'unparseable', summary: null, ...base };
  }
  if (result.code !== 0 || summary.reportedError) {
    return { ok: false, failure: 'run-failed', summary, ...base };
  }

  return { ok: true, failure: null, summary, ...base };
}
