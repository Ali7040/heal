/**
 * The slicer decides what the model is shown, so it decides both the cost of a
 * proposal and what the proposal can be based on. These tests pin the shape of
 * each case against real source text — no model, no harness.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildDiagnosis,
  EDITABLE_FALLBACK_MAX_FILES,
  sliceAround,
  sliceUnlocated,
  WHOLE_FILE_BYTES,
} from '../src/diagnosis/build.js';
import type { Issue } from '../src/contracts/issue.js';
import { Sandbox } from '@self-heal/testkit/sandbox';

const TS = [
  "import { x } from './x.js';", //                 1
  '', //                                              2
  '/** Adds. */', //                                  3
  'export function add(a: number, b: number) {', //  4
  '  const sum = a + b;', //                          5
  '  return sum;', //                                 6
  '}', //                                             7
  '', //                                              8
  'export class Cart {', //                           9
  '  items: number[] = [];', //                      10
  '', //                                             11
  '  total() {', //                                  12
  '    let t = 0;', //                               13
  '    for (const i of this.items) t += i;', //      14
  '    return t;', //                                15
  '  }', //                                          16
  '', //                                             17
  '  clear() {', //                                  18
  '    this.items = [];', //                         19
  '    return this;', //                             20
  '  }', //                                          21
  '}', //                                            22
].join('\n');

const PY = [
  'import os', //                 1
  '', //                          2
  '@cached', //                   3
  'def load(path):', //           4
  '    if not path:', //          5
  '        return None', //       6
  '    else:', //                 7
  '        return open(path)', // 8
  '', //                          9
  'def other():', //             10
  '    pass', //                 11
].join('\n');

describe('sliceAround', () => {
  it('sends the whole enclosing function, with its doc comment, not a window', () => {
    const slice = sliceAround('a.ts', TS, 5, 40);
    expect([slice.startLine, slice.endLine]).toEqual([3, 7]);
    expect(slice.symbol).toBe('export function add(a: number, b: number)');
  });

  it('narrows from a class to the method when the class is too big', () => {
    // 3 lines of context → at most 7 lines; Cart (14) does not fit, total() (5) does.
    const slice = sliceAround('a.ts', TS, 14, 3);
    expect([slice.startLine, slice.endLine]).toEqual([12, 16]);
    expect(slice.symbol).toBe('total()');
  });

  it('keeps a whole class when it fits, rather than narrowing needlessly', () => {
    const slice = sliceAround('a.ts', TS, 14, 40);
    expect([slice.startLine, slice.endLine]).toEqual([9, 22]);
  });

  it('keeps decorators and else-branches with their Python function', () => {
    const slice = sliceAround('a.py', PY, 8, 40);
    expect([slice.startLine, slice.endLine]).toEqual([3, 8]);
    expect(slice.symbol).toBe('def load(path)');
  });

  it('falls back to a line window when no declaration encloses the line', () => {
    const flat = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n');
    const slice = sliceAround('notes.txt', flat, 100, 5);
    expect([slice.startLine, slice.endLine]).toEqual([95, 105]);
    expect(slice.symbol).toBeUndefined();
  });

  it('windows inside a declaration too big to send, and still names it', () => {
    const body = Array.from({ length: 100 }, (_, i) => `  step${i}();`);
    const source = ['function huge() {', ...body, '}'].join('\n');
    const slice = sliceAround('a.ts', source, 50, 5);
    expect([slice.startLine, slice.endLine]).toEqual([45, 55]);
    expect(slice.symbol).toBe('function huge()');
  });
});

describe('sliceUnlocated', () => {
  it('sends a small file whole', () => {
    const slice = sliceUnlocated('a.ts', TS);
    expect(slice.source).toBe(TS);
    expect(slice.symbol).toBeUndefined();
  });

  it('sends a large file as an outline of top-level declarations', () => {
    const filler = Array.from({ length: 200 }, (_, i) => `  const v${i} = ${i};`).join('\n');
    const source = `${TS}\n\nexport function big() {\n${filler}\n}\n`;
    expect(Buffer.byteLength(source)).toBeGreaterThan(WHOLE_FILE_BYTES);

    const slice = sliceUnlocated('a.ts', source);

    expect(slice.symbol).toMatch(/^outline/);
    expect(slice.source.split('\n')).toEqual([
      "1: import { x } from './x.js';",
      '4: export function add(a: number, b: number) {',
      '9: export class Cart {',
      '24: export function big() {',
    ]);
    expect(slice.source).not.toContain('const v1');
  });
});

describe('buildDiagnosis', () => {
  let sandbox: Sandbox | undefined;

  afterEach(async () => {
    await sandbox?.dispose();
    sandbox = undefined;
  });

  function issueAt(file: string, line?: number): Issue {
    return {
      signature: 'sig',
      detectorId: 'd',
      kind: 'k',
      location: line === undefined ? { file } : { file, line },
      expected: null,
      actual: null,
      evidence: [],
      severity: 'high',
      detectedAt: '2026-01-01T00:00:00.000Z',
    };
  }

  it("does not apply the issue's line number to an extra file", async () => {
    sandbox = await Sandbox.create({ files: { 'a.ts': TS, 'b.py': PY }, prefix: 'diag-test-' });
    const diagnosis = await buildDiagnosis(issueAt('a.ts', 14), {
      repoRoot: sandbox.dir,
      editableFiles: ['a.ts'],
      extraFiles: ['b.py'],
    });

    const extra = diagnosis.slices.find((s) => s.path === 'b.py');
    expect(extra?.source).toBe(PY);
  });

  it('slices around the lines the output reported, and skips the outline once a file is covered', async () => {
    sandbox = await Sandbox.create({ files: { 'a.ts': TS }, prefix: 'diag-test-' });
    const issue: Issue = {
      ...issueAt('a.ts'),
      related: [
        { file: 'a.ts', line: 14 },
        { file: 'a.ts', line: 15 }, // same method — no second slice
        { file: 'a.ts', line: 5 },
      ],
    };

    const diagnosis = await buildDiagnosis(issue, { repoRoot: sandbox.dir, editableFiles: ['a.ts'], contextLines: 3 });

    expect(diagnosis.slices.map((s) => [s.startLine, s.endLine])).toEqual([
      [12, 16],
      [3, 7],
    ]);
  });

  it('skips a file over budget without dropping the smaller files after it', async () => {
    const big = Array.from({ length: 400 }, (_, i) => `const v${i} = ${i};`).join('\n');
    sandbox = await Sandbox.create({ files: { 'big.ts': big, 'small.ts': 'export const s = 1;\n' }, prefix: 'diag-test-' });

    const diagnosis = await buildDiagnosis(issueAt('big.ts', 200), {
      repoRoot: sandbox.dir,
      editableFiles: ['big.ts'],
      extraFiles: ['small.ts'],
      budgetBytes: 200,
    });

    expect(diagnosis.slices.map((s) => s.path)).toEqual(['small.ts']);
  });

  describe('when nothing located the problem (D-027)', () => {
    const PRICING = 'export function totalWithTax(cents, rate) {\n  return cents;\n}\n';

    it("falls back to the check's editable files, rather than sending no code", async () => {
      // The pricing fixture's shape: location is a glob, the output names no file.
      sandbox = await Sandbox.create({
        files: { 'src/pricing.mjs': PRICING, 'src/util.mjs': 'export const x = 1;\n', 'check.mjs': 'run();\n' },
        prefix: 'diag-test-',
      });

      const diagnosis = await buildDiagnosis(issueAt('src/**/*.mjs'), {
        repoRoot: sandbox.dir,
        editableFiles: ['src/**/*.mjs'],
      });

      expect(diagnosis.slices.map((s) => s.path)).toEqual(['src/pricing.mjs', 'src/util.mjs']);
      expect(diagnosis.slices[0]?.source).toBe(PRICING);
    });

    it('offers only tracked files — what the fixer sandbox will contain', async () => {
      sandbox = await Sandbox.create({ files: { 'src/a.mjs': 'a\n' }, prefix: 'diag-test-' });
      await sandbox.write('src/scratch.mjs', 'not committed\n');

      const diagnosis = await buildDiagnosis(issueAt('src/**'), { repoRoot: sandbox.dir, editableFiles: ['src/**'] });

      expect(diagnosis.slices.map((s) => s.path)).toEqual(['src/a.mjs']);
    });

    it('stops at a handful of files, so a broad glob is not the whole repository', async () => {
      const files = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`src/f${String(i).padStart(2, '0')}.mjs`, `${i}\n`]));
      sandbox = await Sandbox.create({ files, prefix: 'diag-test-' });

      const diagnosis = await buildDiagnosis(issueAt('src/**'), { repoRoot: sandbox.dir, editableFiles: ['**'] });

      expect(diagnosis.slices).toHaveLength(EDITABLE_FALLBACK_MAX_FILES);
    });

    it('is not used when anything else produced a slice', async () => {
      sandbox = await Sandbox.create({ files: { 'a.ts': TS, 'src/other.mjs': 'x\n' }, prefix: 'diag-test-' });

      const diagnosis = await buildDiagnosis(issueAt('a.ts', 5), { repoRoot: sandbox.dir, editableFiles: ['**'] });

      expect(diagnosis.slices.map((s) => s.path)).toEqual(['a.ts']);
    });
  });
});
