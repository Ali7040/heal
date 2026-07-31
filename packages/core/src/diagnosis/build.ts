/**
 * Turning an `Issue` into a bounded `Diagnosis`.
 *
 * This is the cost-control layer of the entire system. Everything a fixer sees
 * passes through here, so this is where "just send the whole file" is refused —
 * growing the context window is the failure mode the project exists to avoid
 * (AGENTS.md).
 *
 * The slicer is a line window around the reported location, hard-capped by a byte
 * budget. It is deliberately not an AST slicer yet: a window is language-agnostic,
 * has no parser dependency, and is good enough to prove the loop closes. The
 * budget is enforced here rather than inside a smarter slicer, so when an AST
 * slicer replaces the window the ceiling still holds.
 *
 * Note what is *not* included: evidence. Screenshots and response bodies stay on
 * disk as paths. A blob has no route into a prompt through this function.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CodeSlice, Diagnosis } from '../contracts/diagnosis.js';
import { DIAGNOSIS_SLICE_BUDGET_BYTES } from '../contracts/diagnosis.js';
import type { Issue } from '../contracts/issue.js';

export interface BuildDiagnosisOptions {
  readonly repoRoot: string;
  /** Files the fixer may edit for this issue. */
  readonly editableFiles: readonly string[];
  /** Lines of context on each side of the reported line. */
  readonly contextLines?: number;
  readonly budgetBytes?: number;
  /** Extra files worth showing, beyond the issue's own location. */
  readonly extraFiles?: readonly string[];
}

export async function buildDiagnosis(issue: Issue, options: BuildDiagnosisOptions): Promise<Diagnosis> {
  const contextLines = options.contextLines ?? 40;
  const budget = options.budgetBytes ?? DIAGNOSIS_SLICE_BUDGET_BYTES;

  const candidates = [issue.location.file, ...(options.extraFiles ?? [])].filter(
    (path): path is string => typeof path === 'string' && path !== '',
  );

  const slices: CodeSlice[] = [];
  let spent = 0;

  for (const path of unique(candidates)) {
    const source = await readFileOrNull(join(options.repoRoot, path));
    if (source === null) continue;

    const slice = sliceAround(path, source, issue.location.line, contextLines);
    const cost = Buffer.byteLength(slice.source, 'utf8');

    // Stop at the ceiling rather than trimming mid-file: a truncated slice that
    // looks complete is worse than one file fewer.
    if (spent + cost > budget) break;

    slices.push(slice);
    spent += cost;
  }

  return { issue, slices, editableFiles: options.editableFiles };
}

function sliceAround(path: string, source: string, line: number | undefined, context: number): CodeSlice {
  const lines = source.split('\n');

  // With no line number, the whole (small) file is the best window available.
  if (line === undefined) {
    return { path, startLine: 1, endLine: lines.length, source };
  }

  const startLine = Math.max(1, line - context);
  const endLine = Math.min(lines.length, line + context);

  return {
    path,
    startLine,
    endLine,
    source: lines.slice(startLine - 1, endLine).join('\n'),
  };
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
