import { describe, expect, it } from 'vitest';

import type { SpendReport } from '@self-heal/journal/store';

import { ConfigError } from '../src/config.js';
import { formatRunSpend, formatSpend, parseSince } from '../src/stats.js';

function spend(overrides: Partial<SpendReport> = {}): SpendReport {
  return {
    since: null,
    calls: 3,
    failedCalls: 1,
    knownCostUsd: 0.06,
    unknownCostCalls: 0,
    heals: 1,
    replays: 2,
    failedMeasurements: 1,
    costPerHealUsd: 0.06,
    estimatedSavedUsd: 0.12,
    promptBytes: 1500,
    ...overrides,
  };
}

describe('parseSince', () => {
  const now = new Date('2026-10-06T12:00:00.000Z');

  it('reads days and hours relative to now', () => {
    expect(parseSince('7d', now)).toBe('2026-09-29T12:00:00.000Z');
    expect(parseSince('24h', now)).toBe('2026-10-05T12:00:00.000Z');
  });

  it('reads a date', () => {
    expect(parseSince('2026-10-01', now)).toBe('2026-10-01T00:00:00.000Z');
  });

  it('refuses anything else, instead of silently counting all time', () => {
    expect(() => parseSince('last week', now)).toThrow(ConfigError);
  });
});

describe('formatSpend', () => {
  it('reports spend, heals, cost per heal, and labels the saving as an estimate', () => {
    const text = formatSpend(spend());
    expect(text).toContain('spent          $0.0600');
    expect(text).toContain('model calls    3, 1 failed');
    expect(text).toContain('healed         1 by a model, 2 replayed from the journal');
    expect(text).toContain('cost per heal  $0.0600');
    expect(text).toContain('saved          ≈ $0.1200 (estimate: 2 replay(s) × cost per heal)');
  });

  it('shows a floor, not a total, when some calls did not report a cost', () => {
    const text = formatSpend(spend({ unknownCostCalls: 1, costPerHealUsd: null, estimatedSavedUsd: null }));
    expect(text).toContain('at least $0.0600 (1 call(s) did not report a cost)');
    expect(text).toContain('cost per heal  — (some calls did not report a cost)');
    expect(text).toContain('saved          unknown');
  });

  it('says so when there is nothing to report', () => {
    expect(formatSpend(spend({ calls: 0, heals: 0, replays: 0 }))).toBe('nothing measured yet\n');
  });
});

describe('formatRunSpend', () => {
  it('is silent when no model was called', () => {
    expect(formatRunSpend([])).toBe('');
  });

  it('sums the run, and never rounds an unknown down to zero', () => {
    expect(formatRunSpend([{ costUsd: 0.01 }, { costUsd: 0.02 }])).toBe('spent this run: $0.0300 over 2 model call(s)\n');
    expect(formatRunSpend([{ costUsd: 0.01 }, { costUsd: null }])).toBe('spent this run: at least $0.0100 over 2 model call(s)\n');
    expect(formatRunSpend([{ costUsd: null }])).toBe('spent this run: cost not reported over 1 model call(s)\n');
  });
});
