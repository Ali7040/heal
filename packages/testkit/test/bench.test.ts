/**
 * The benchmark's arithmetic. If these numbers lie, every roadmap decision made
 * from them inherits the lie — so the honesty rules are tested, not assumed.
 */
import { describe, expect, it } from 'vitest';

import { compare, formatComparison, summarize, summarizeAll, type BenchReport, type BenchRun } from '../src/bench.js';

function run(overrides: Partial<BenchRun> = {}): BenchRun {
  return {
    fixture: 'f',
    run: 1,
    state: 'HEALED',
    healed: true,
    attempts: 1,
    durationMs: 1000,
    modelCalls: 1,
    costUsd: 0.1,
    promptBytes: [400],
    harnessFailures: [],
    reason: '',
    ...overrides,
  };
}

function report(runs: BenchRun[]): BenchReport {
  const { summary, total } = summarizeAll(runs);
  return { version: 1, startedAt: '', harness: 'h', dry: false, runsPerFixture: 1, runs, summary, total };
}

describe('summarize', () => {
  it('charges cost per heal, so a run that heals nothing is not cheap', () => {
    const summary = summarize('f', [
      run({ costUsd: 0.1 }),
      run({ healed: false, state: 'ESCALATED', attempts: 2, modelCalls: 2, costUsd: 0.3 }),
    ]);

    expect(summary.healRate).toBe(0.5);
    expect(summary.totalCostUsd).toBeCloseTo(0.4);
    // $0.40 bought one heal — not $0.20 a run.
    expect(summary.costPerHealUsd).toBeCloseTo(0.4);
    expect(summary.modelCallsPerHeal).toBe(3);
    expect(summary.meanAttempts).toBe(1.5);
  });

  it('treats an unknown cost as unknown, never as zero', () => {
    const summary = summarize('f', [run({ costUsd: 0.1 }), run({ costUsd: null })]);
    expect(summary.totalCostUsd).toBeNull();
    expect(summary.costPerHealUsd).toBeNull();
  });

  it('has no per-heal figures when nothing healed', () => {
    const summary = summarize('f', [run({ healed: false })]);
    expect(summary.costPerHealUsd).toBeNull();
    expect(summary.modelCallsPerHeal).toBeNull();
  });

  it('averages prompt size per proposal, and takes the median time', () => {
    const summary = summarize('f', [
      run({ promptBytes: [100, 300], durationMs: 1000 }),
      run({ promptBytes: [200], durationMs: 9000 }),
      run({ promptBytes: [], durationMs: 2000 }),
    ]);
    expect(summary.meanPromptBytes).toBe(200);
    expect(summary.medianMs).toBe(2000);
  });

  it('summarises each fixture in first-seen order, plus a total', () => {
    const { summary, total } = summarizeAll([run({ fixture: 'b' }), run({ fixture: 'a' }), run({ fixture: 'b' })]);
    expect(summary.map((s) => [s.fixture, s.runs])).toEqual([
      ['b', 2],
      ['a', 1],
    ]);
    expect(total.runs).toBe(3);
  });
});

describe('compare', () => {
  it('pairs fixtures present in both, and always the total', () => {
    const before = report([run({ fixture: 'a', promptBytes: [1000] }), run({ fixture: 'gone' })]);
    const after = report([run({ fixture: 'a', promptBytes: [600] }), run({ fixture: 'new' })]);

    const deltas = compare(before, after);

    expect(new Set(deltas.map((d) => d.fixture))).toEqual(new Set(['a', 'all']));
    expect(deltas.find((d) => d.fixture === 'a' && d.metric === 'meanPromptBytes')).toEqual({
      fixture: 'a',
      metric: 'meanPromptBytes',
      before: 1000,
      after: 600,
    });
  });

  it('reports heal rate in points and the rest as a relative change', () => {
    const before = report([run({ fixture: 'a', healed: false, promptBytes: [1000] }), run({ fixture: 'a', promptBytes: [1000] })]);
    const after = report([run({ fixture: 'a', promptBytes: [600] }), run({ fixture: 'a', promptBytes: [600] })]);

    const text = formatComparison(compare(before, after).filter((d) => d.fixture === 'a'));

    expect(text).toMatch(/healRate\s+50%\s+100%\s+\+50 pts/);
    expect(text).toMatch(/meanPromptBytes\s+1000\s+600\s+-40%/);
  });
});
