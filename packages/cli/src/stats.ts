/**
 * What the loop has cost, said plainly (D-029).
 *
 * The one rule that matters in a cost report is not to round an unknown down to
 * zero. A harness that does not report its cost leaves a floor — "at least $x" —
 * and every derived figure that depends on it is shown as unknown, not guessed.
 */
import type { SpendReport } from '@self-heal/journal/store';

import { ConfigError } from './config.js';

/** `7d`, `24h`, or any date `Date` can parse. Returns ISO-8601. */
export function parseSince(value: string, now: Date = new Date()): string {
  const relative = /^(\d+)\s*([dh])$/i.exec(value.trim());
  if (relative !== null) {
    const amount = Number(relative[1]);
    const hours = relative[2]?.toLowerCase() === 'd' ? amount * 24 : amount;
    return new Date(now.getTime() - hours * 3_600_000).toISOString();
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new ConfigError(`--since "${value}" is not a duration (7d, 24h) or a date (2026-10-01)`);
  }
  return new Date(parsed).toISOString();
}

export function formatSpend(report: SpendReport): string {
  const scope = report.since === null ? 'all time' : `since ${report.since.slice(0, 16).replace('T', ' ')}`;
  if (report.calls === 0 && report.heals === 0 && report.replays === 0) {
    return `nothing measured ${scope === 'all time' ? 'yet' : scope}\n`;
  }

  const unknown = report.unknownCostCalls > 0;
  const spent = unknown
    ? `at least ${usd(report.knownCostUsd)} (${report.unknownCostCalls} call(s) did not report a cost)`
    : usd(report.knownCostUsd);
  const failed = report.failedCalls > 0 ? `, ${report.failedCalls} failed` : '';

  const lines = [
    `self-heal spend — ${scope}`,
    '',
    `  spent          ${spent}`,
    `  model calls    ${report.calls}${failed}`,
    `  healed         ${report.heals} by a model, ${report.replays} replayed from the journal`,
    `  rejected       ${report.failedMeasurements} measurement(s) failed and were reverted`,
    `  cost per heal  ${report.costPerHealUsd === null ? unknownBecause(report) : usd(report.costPerHealUsd)}`,
  ];
  if (report.replays > 0) {
    lines.push(
      `  saved          ${report.estimatedSavedUsd === null ? 'unknown' : `≈ ${usd(report.estimatedSavedUsd)}`} ` +
        `(estimate: ${report.replays} replay(s) × cost per heal)`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** One line for the end of a run. Empty when no model was called. */
export function formatRunSpend(calls: readonly { readonly costUsd: number | null }[]): string {
  if (calls.length === 0) return '';
  const known = calls.reduce((total, call) => total + (call.costUsd ?? 0), 0);
  const unknown = calls.filter((call) => call.costUsd === null).length;
  const amount = unknown === 0 ? usd(known) : unknown === calls.length ? 'cost not reported' : `at least ${usd(known)}`;
  return `spent this run: ${amount} over ${calls.length} model call(s)\n`;
}

function unknownBecause(report: SpendReport): string {
  if (report.heals === 0) return '— (nothing healed by a model yet)';
  return '— (some calls did not report a cost)';
}

function usd(value: number): string {
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}
