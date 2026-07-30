/**
 * The three failure modes are the whole reason `invokeHarness` exists, so they
 * are tested against real processes — no mocks. A stubbed spawn would only
 * prove our stub behaves as written.
 */
import { describe, expect, it } from 'vitest';

import { invokeHarness } from '../src/invoke.js';
import type { HarnessProfile } from '../src/profiles.js';

/** A profile pointed at plain node, so we can script any harness behaviour. */
function fakeProfile(script: string, overrides: Partial<HarnessProfile> = {}): HarnessProfile {
  return {
    id: 'fake',
    command: process.execPath,
    promptDelivery: 'stdin',
    buildArgs: () => ['-e', script],
    parseResult: (stdout) => {
      try {
        const parsed = JSON.parse(stdout) as Record<string, unknown>;
        return {
          text: String(parsed['result'] ?? ''),
          costUsd: null,
          turns: null,
          reportedError: parsed['is_error'] === true,
        };
      } catch {
        return null;
      }
    },
    ...overrides,
  };
}

describe('invokeHarness', () => {
  it('distinguishes a missing binary from a failed run', async () => {
    const result = await invokeHarness({
      profile: fakeProfile('', { command: 'definitely-not-a-real-binary-xyz' }),
      prompt: 'hi',
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });

    // 'unavailable' means the environment is broken; the runner must not spend
    // one of the issue's two attempts on it.
    expect(result.failure).toBe('unavailable');
    expect(result.ok).toBe(false);
  });

  it('reports a timeout as its own failure mode', async () => {
    const result = await invokeHarness({
      profile: fakeProfile('setTimeout(() => {}, 60000)'),
      prompt: 'hi',
      cwd: process.cwd(),
      timeoutMs: 1_000,
    });

    expect(result.failure).toBe('timeout');
  });

  it('flags unparseable output instead of guessing at it', async () => {
    const result = await invokeHarness({
      profile: fakeProfile('console.log("not json at all")'),
      prompt: 'hi',
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });

    expect(result.failure).toBe('unparseable');
  });

  it("treats the harness's own error flag as a failed run", async () => {
    const result = await invokeHarness({
      profile: fakeProfile('console.log(JSON.stringify({ result: "nope", is_error: true }))'),
      prompt: 'hi',
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });

    expect(result.failure).toBe('run-failed');
    expect(result.summary?.text).toBe('nope');
  });

  it('delivers the prompt on stdin, intact, without a shell touching it', async () => {
    // Newlines and quotes are exactly what argv delivery corrupts on Windows.
    const prompt = 'line one\nline "two" with % and $VAR\nline three';
    const script =
      'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.stringify({result:d})))';

    const result = await invokeHarness({
      profile: fakeProfile(script),
      prompt,
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });

    expect(result.ok).toBe(true);
    expect(result.summary?.text).toBe(prompt);
  });
});
