/**
 * The prompt is the whole of what the model is told, so its shape is tested
 * directly — no harness, no model.
 */
import { describe, expect, it } from 'vitest';

import type { Diagnosis } from '@self-heal/core/contracts/diagnosis';

import { buildPrompt } from '../src/index.js';

const diagnosis: Diagnosis = {
  issue: {
    signature: 'sig-1',
    detectorId: 'command',
    kind: 'wrong-value',
    location: { file: 'src/value.mjs', line: 1 },
    expected: 2,
    actual: 1,
    evidence: [],
    severity: 'high',
    detectedAt: '2026-01-01T00:00:00.000Z',
  },
  slices: [{ path: 'src/value.mjs', startLine: 1, endLine: 1, source: 'export const value = 1;' }],
  editableFiles: ['src/value.mjs'],
};

describe('buildPrompt', () => {
  it('says nothing about earlier attempts on a first try', () => {
    expect(buildPrompt(diagnosis)).not.toMatch(/Earlier attempts/);
  });

  it('names each failed attempt and its measured reason on a retry', () => {
    const prompt = buildPrompt({
      ...diagnosis,
      priorAttempts: [{ files: ['src/value.mjs'], rationale: 'set value to 999', reason: 'verification failed; tree restored' }],
    });

    expect(prompt).toMatch(/Earlier attempts at this issue were measured and FAILED/);
    expect(prompt).toContain('1. Edited src/value.mjs ("set value to 999") — verification failed; tree restored');
  });

  it('names every reported location, even those whose slice did not fit', () => {
    const prompt = buildPrompt({
      ...diagnosis,
      issue: { ...diagnosis.issue, related: [{ file: 'src/value.mjs', line: 1 }, { file: 'src/other.mjs', line: 40 }] },
    });
    expect(prompt).toContain('Reported at: src/value.mjs:1, src/other.mjs:40');
  });
});
