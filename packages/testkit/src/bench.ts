/**
 * Turning benchmark runs into numbers worth comparing.
 *
 * The benchmark exists because every improvement on the roadmap claims to make a
 * fix cheaper or likelier, and a claim is exactly what this project refuses to
 * trust (D-001) — including its own (D-026). This file is the arithmetic: pure,
 * deterministic, and tested, so a surprising number is a fact about the runs and
 * never about the summing.
 *
 * Two rules keep the numbers honest:
 *   - An unknown is not a zero. A harness that does not report cost makes the
 *     cost `null`, and any total that includes it is `null` too.
 *   - Cost is per *heal*, not per run. A cheap run that heals nothing is the most
 *     expensive outcome there is, and a per-run average would hide it.
 */

/** One fixture, one cold run of the loop. */
export interface BenchRun {
  readonly fixture: string;
  readonly run: number;
  readonly state: string;
  readonly healed: boolean;
  readonly attempts: number;
  readonly durationMs: number;
  readonly modelCalls: number;
  /** Sum over this run's model calls; `null` if any call's cost was unknown. */
  readonly costUsd: number | null;
  /** Prompt size of each proposal, in order — the cost the project controls. */
  readonly promptBytes: readonly number[];
  /** Harness failure kinds (`timeout`, `run-failed`, …), one per failed call. */
  readonly harnessFailures: readonly string[];
  readonly reason: string;
}

export interface BenchSummary {
  readonly fixture: string;
  readonly runs: number;
  readonly healed: number;
  readonly healRate: number;
  readonly meanAttempts: number;
  readonly modelCallsPerHeal: number | null;
  readonly costPerHealUsd: number | null;
  readonly totalCostUsd: number | null;
  readonly meanPromptBytes: number | null;
  readonly medianMs: number;
}

export interface BenchReport {
  readonly version: 1;
  readonly startedAt: string;
  readonly harness: string;
  readonly dry: boolean;
  readonly runsPerFixture: number;
  readonly runs: readonly BenchRun[];
  readonly summary: readonly BenchSummary[];
  readonly total: BenchSummary;
}

export function summarize(fixture: string, runs: readonly BenchRun[]): BenchSummary {
  const healed = runs.filter((run) => run.healed).length;
  const calls = sum(runs.map((run) => run.modelCalls));
  const costs = runs.map((run) => run.costUsd);
  const totalCostUsd = costs.some((cost) => cost === null) ? null : sum(costs as number[]);
  const prompts = runs.flatMap((run) => run.promptBytes);

  return {
    fixture,
    runs: runs.length,
    healed,
    healRate: runs.length === 0 ? 0 : healed / runs.length,
    meanAttempts: runs.length === 0 ? 0 : sum(runs.map((run) => run.attempts)) / runs.length,
    modelCallsPerHeal: healed === 0 ? null : calls / healed,
    costPerHealUsd: healed === 0 || totalCostUsd === null ? null : totalCostUsd / healed,
    totalCostUsd,
    meanPromptBytes: prompts.length === 0 ? null : sum(prompts) / prompts.length,
    medianMs: median(runs.map((run) => run.durationMs)),
  };
}

/** Per-fixture summaries, in first-seen order, plus one over everything. */
export function summarizeAll(runs: readonly BenchRun[]): { summary: BenchSummary[]; total: BenchSummary } {
  const fixtures = [...new Set(runs.map((run) => run.fixture))];
  return {
    summary: fixtures.map((fixture) => summarize(fixture, runs.filter((run) => run.fixture === fixture))),
    total: summarize('all', runs),
  };
}

export interface Delta {
  readonly fixture: string;
  readonly metric: keyof BenchSummary;
  readonly before: number | null;
  readonly after: number | null;
}

const COMPARED: readonly (keyof BenchSummary)[] = [
  'healRate',
  'meanAttempts',
  'costPerHealUsd',
  'meanPromptBytes',
  'medianMs',
];

/** Before/after for every fixture present in both reports, and the total. */
export function compare(before: BenchReport, after: BenchReport): Delta[] {
  const pairs: [BenchSummary, BenchSummary][] = [];
  for (const next of after.summary) {
    const previous = before.summary.find((summary) => summary.fixture === next.fixture);
    if (previous !== undefined) pairs.push([previous, next]);
  }
  pairs.push([before.total, after.total]);

  return pairs.flatMap(([previous, next]) =>
    COMPARED.map((metric) => ({
      fixture: next.fixture,
      metric,
      before: previous[metric] as number | null,
      after: next[metric] as number | null,
    })),
  );
}

export function formatSummary(summaries: readonly BenchSummary[]): string {
  const header = ['fixture', 'healed', 'attempts', 'calls/heal', '$/heal', 'prompt B', 'median'];
  const rows = summaries.map((s) => [
    s.fixture,
    `${s.healed}/${s.runs} (${percent(s.healRate)})`,
    s.meanAttempts.toFixed(2),
    s.modelCallsPerHeal === null ? '—' : s.modelCallsPerHeal.toFixed(2),
    s.costPerHealUsd === null ? '—' : `$${s.costPerHealUsd.toFixed(4)}`,
    s.meanPromptBytes === null ? '—' : String(Math.round(s.meanPromptBytes)),
    `${(s.medianMs / 1000).toFixed(1)}s`,
  ]);
  return table([header, ...rows]);
}

export function formatComparison(deltas: readonly Delta[]): string {
  const rows = deltas.map((d) => [d.fixture, d.metric, show(d.metric, d.before), show(d.metric, d.after), change(d)]);
  return table([['fixture', 'metric', 'before', 'after', 'change'], ...rows]);
}

function change(delta: Delta): string {
  if (delta.before === null || delta.after === null) return '—';
  if (delta.metric === 'healRate') {
    const points = (delta.after - delta.before) * 100;
    return `${points >= 0 ? '+' : ''}${points.toFixed(0)} pts`;
  }
  if (delta.before === 0) return delta.after === 0 ? '0%' : 'new';
  const ratio = (delta.after - delta.before) / delta.before;
  return `${ratio >= 0 ? '+' : ''}${(ratio * 100).toFixed(0)}%`;
}

function show(metric: keyof BenchSummary, value: number | null): string {
  if (value === null) return '—';
  if (metric === 'healRate') return percent(value);
  if (metric === 'costPerHealUsd') return `$${value.toFixed(4)}`;
  if (metric === 'medianMs') return `${(value / 1000).toFixed(1)}s`;
  if (metric === 'meanPromptBytes') return String(Math.round(value));
  return value.toFixed(2);
}

function table(rows: readonly (readonly string[])[]): string {
  const widths = rows[0]?.map((_, column) => Math.max(...rows.map((row) => (row[column] ?? '').length))) ?? [];
  return rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  ').trimEnd()).join('\n');
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}
