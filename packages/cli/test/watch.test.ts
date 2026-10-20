import type { IssueOutcome, RunReport } from '@self-heal/core/runner/runner';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { debounce, failingChecks, maybeRelevant, signaturesToHeal, statusChanges } from '../src/watch.js';

function report(entries: [string, IssueOutcome['state']][]): RunReport {
  return {
    issues: entries.length,
    outcomes: entries.map(
      ([id, state]) =>
        ({
          issue: { signature: `sig-${id}`, detectorId: id, kind: 'check-failed', location: {}, expected: 0, actual: 1, evidence: [], severity: 'high', detectedAt: '' },
          state,
          attempts: 0,
          reason: 'r',
          replayed: false,
        }) as IssueOutcome,
    ),
    halted: false,
    dryRun: true,
    durationMs: 1,
  };
}

describe('watch mode', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts a check as failing unless it healed, resolved, or turned out flaky', () => {
    const failing = failingChecks(report([['tests', 'PROPOSED'], ['types', 'RESOLVED'], ['lint', 'FLAKY'], ['api', 'ESCALATED']]));
    expect([...failing.values()].map((f) => f.label)).toEqual(['tests (check-failed)', 'api (check-failed)']);
  });

  it('reports only what changed between two measurements', () => {
    const before = failingChecks(report([['tests', 'PROPOSED'], ['lint', 'PROPOSED']]));
    const after = failingChecks(report([['lint', 'PROPOSED'], ['types', 'PROPOSED']]));

    expect(statusChanges(before, after)).toEqual(['✗ types (check-failed) is failing', '✔ tests (check-failed) passes again']);
    expect(statusChanges(after, after)).toEqual([]);
  });

  it('heals only with --heal, only on a clean tree, and never the same issue twice in a session', () => {
    const failing = failingChecks(report([['tests', 'PROPOSED'], ['types', 'PROPOSED']]));
    const attempted = new Set(['sig-tests']);

    expect(signaturesToHeal({ heal: false, clean: true, failing, attempted })).toEqual([]);
    expect(signaturesToHeal({ heal: true, clean: false, failing, attempted })).toEqual([]);
    expect(signaturesToHeal({ heal: true, clean: true, failing, attempted })).toEqual(['sig-types']);
  });

  it('ignores git internals, its own state, and dependencies — wherever they are nested', () => {
    for (const path of ['.git/index', '.self-heal/journal.sqlite', 'node_modules/x/a.js', 'packages/a/node_modules/b.js', '.git']) {
      expect(maybeRelevant(path), path).toBe(false);
    }
    for (const path of ['src/a.ts', 'README.md', 'src\\win\\path.ts', '.github/ci.yml', '.gitignore']) {
      expect(maybeRelevant(path), path).toBe(true);
    }
  });

  it('collects a burst of saves into one measurement, after the burst ends', () => {
    vi.useFakeTimers();
    const flushes: string[][] = [];
    const push = debounce(500, (paths) => flushes.push(paths));

    push('a.ts');
    vi.advanceTimersByTime(300);
    push('b.ts');
    push('a.ts');
    vi.advanceTimersByTime(499);
    expect(flushes).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(flushes).toEqual([['a.ts', 'b.ts']]);
  });
});
