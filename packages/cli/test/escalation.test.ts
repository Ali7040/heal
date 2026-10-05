import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AttemptRecord, EscalationReport } from '@self-heal/core/contracts/escalation';

import { renderEscalation, writeEscalation } from '../src/escalation.js';

let dir: string | undefined;

afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

function reportWith(attempts: AttemptRecord[], overrides: Partial<EscalationReport> = {}): EscalationReport {
  return {
    issue: {
      signature: 'fa0f950f1234',
      detectorId: 'tests',
      kind: 'check-failed',
      location: { file: 'src/**' },
      related: [{ file: 'src/pricing.mjs', line: 3 }],
      expected: { exitCode: 0 },
      actual: { exitCode: 1, failure: 'FAIL totalWithTax' },
      evidence: [],
      severity: 'high',
      detectedAt: '2026-01-01T00:00:00.000Z',
    },
    reason: 'attempt cap reached (2); last: verification failed; tree restored',
    diagnosis: {
      issue: {} as EscalationReport['issue'],
      slices: [{ path: 'src/pricing.mjs', startLine: 1, endLine: 3, source: 'function f() {\n  return 1;\n}', symbol: 'function f()' }],
      editableFiles: ['src/**'],
    },
    attempts,
    escalatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const attempt = (overrides: Partial<AttemptRecord> = {}): AttemptRecord => ({
  number: 1,
  replayed: false,
  files: ['src/pricing.mjs'],
  rationale: 'apply the rate',
  reason: 'verification failed; tree restored',
  diff: '-  return 1;\n+  return 2;',
  ...overrides,
});

describe('renderEscalation', () => {
  it('leads with the measurement, then what was shown, then every attempt and its diff', () => {
    const text = renderEscalation(reportWith([attempt(), attempt({ number: 2, rationale: 'try again' })]));

    const order = ['## What was measured', '## What the model was shown', '## Attempts', '### 1', '### 2'];
    const positions = order.map((heading) => text.indexOf(heading));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);

    expect(text).toContain('**Output pointed at:** `src/pricing.mjs:3`');
    expect(text).toContain('```diff\n-  return 1;\n+  return 2;\n```');
    expect(text).toContain("**The fixer's own account:** try again");
  });

  it('points at the pattern in what failed', () => {
    const same = renderEscalation(reportWith([attempt(), attempt({ number: 2 })]));
    expect(same).toContain('Every proposal applied cleanly and still failed the check');
    expect(same).toContain('Every attempt edited only `src/pricing.mjs`');

    const guarded = renderEscalation(
      reportWith([attempt({ reason: 'patch rejected: src/pricing.test.mjs (protected)', diff: undefined })]),
    );
    expect(guarded).toContain('tried to edit a protected file');
    expect(guarded).toContain('_Never applied, so there is no diff._');

    const silent = renderEscalation(
      reportWith([attempt({ reason: 'fixer proposed no change', files: [], diff: undefined })], {
        diagnosis: { issue: {} as EscalationReport['issue'], slices: [], editableFiles: ['src/**'] },
      }),
    );
    expect(silent).toContain('The fixer never proposed a change');
    expect(silent).toContain('the model saw no code');
  });

  it('cannot be broken out of a code fence by backticks in the code', () => {
    const text = renderEscalation(reportWith([attempt({ diff: '+ const s = ```oops```;' })]));
    expect(text).toContain('````diff\n+ const s = ```oops```;\n````');
  });
});

describe('writeEscalation', () => {
  it('writes under the evidence directory, which init has always gitignored', async () => {
    dir = await mkdtemp(join(tmpdir(), 'escalation-test-'));
    const path = await writeEscalation(reportWith([attempt()]), join(dir, '.self-heal', 'evidence'));

    expect(path).toBe(join(dir, '.self-heal', 'evidence', 'escalations', 'fa0f950f.md'));
    expect(await readFile(path, 'utf8')).toMatch(/^# Escalated: check-failed \(fa0f950f\)/);
  });
});
