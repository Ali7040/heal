/**
 * Turning an `Issue` into a bounded `Diagnosis`.
 *
 * This is the cost-control layer of the entire system. Everything a fixer sees
 * passes through here, so this is where "just send the whole file" is refused —
 * growing the context window is the failure mode the project exists to avoid
 * (AGENTS.md).
 *
 * Lines the measurement's own output reported (`issue.related`, D-024) are sliced
 * first; then the issue's location; then extra files. Per target, two cases,
 * because a target either has a line or does not (D-019):
 *
 *   - **A line is known.** The slice is the enclosing declaration — the largest
 *     function, method, or class around the line that fits the line limit. A
 *     window cuts a function in half; a declaration is the unit a fix is written
 *     in. When nothing fits, the old line window is the fallback, so this is
 *     never worse than it was.
 *   - **No line is known** (every command detector today). A small file is sent
 *     whole — cheaper than the round trip of the model reading it. Anything larger
 *     becomes an outline: top-level declarations with line numbers, a map the
 *     harness can use to read exactly the part it needs.
 *
 * Declarations are found by indentation, not by a parser. That is a heuristic,
 * and it is allowed to be one: it is language-agnostic, needs no dependency in
 * `core`, and every miss falls back to the window. The byte budget is enforced
 * here, outside the slicer, so no slicer can ever exceed it.
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
  /** Lines of context on each side of the reported line, when no declaration fits. */
  readonly contextLines?: number;
  readonly budgetBytes?: number;
  /** Extra files worth showing, beyond the issue's own location. */
  readonly extraFiles?: readonly string[];
}

/** A file at or under this size is sent whole when no line is known. */
export const WHOLE_FILE_BYTES = 2_048;

/** Most declarations an outline lists before it stops. */
export const OUTLINE_MAX_ENTRIES = 120;

/** A "declaration" shorter than this is a statement, and too little context on its own. */
const MIN_BLOCK_LINES = 3;

export async function buildDiagnosis(issue: Issue, options: BuildDiagnosisOptions): Promise<Diagnosis> {
  const contextLines = options.contextLines ?? 40;
  const budget = options.budgetBytes ?? DIAGNOSIS_SLICE_BUDGET_BYTES;

  // Most precise first: the lines the measurement's own output pointed at (D-024),
  // then the issue's location, then extra files. Each line belongs to its own file
  // only — an extra file is always unlocated.
  const targets: { readonly path: string; readonly line: number | undefined }[] = [
    ...(issue.related ?? []).map((related) => ({ path: related.file ?? '', line: related.line })),
    { path: issue.location.file ?? '', line: issue.location.line },
    ...(options.extraFiles ?? []).map((path) => ({ path, line: undefined })),
  ].filter((target) => target.path !== '');

  const slices: CodeSlice[] = [];
  const sources = new Map<string, string | null>();
  let spent = 0;

  for (const { path, line } of targets) {
    if (covered(slices, path, line)) continue;

    if (!sources.has(path)) sources.set(path, await readFileOrNull(join(options.repoRoot, path)));
    const source = sources.get(path);
    if (source === null || source === undefined) continue;

    const slice =
      line === undefined ? sliceUnlocated(path, source) : sliceAround(path, source, line, contextLines);
    const cost = Buffer.byteLength(slice.source, 'utf8');

    // Skip rather than trim mid-file: a truncated slice that looks complete is
    // worse than one file fewer. Skip rather than stop: a smaller file later in
    // the list may still fit.
    if (spent + cost > budget) continue;

    slices.push(slice);
    spent += cost;
  }

  return { issue, slices, editableFiles: options.editableFiles };
}

/** The enclosing declaration if one fits, else a line window. `line` is 1-based. */
export function sliceAround(path: string, source: string, line: number, context: number): CodeSlice {
  const lines = source.split('\n');
  const target = Math.min(Math.max(line, 1), lines.length) - 1;
  const maxLines = context * 2 + 1;

  const block = enclosingBlock(lines, target, maxLines);
  if (block !== undefined && block.end - block.start + 1 <= maxLines) {
    return slice(path, lines, block.start, block.end, symbolOf(lines[block.header]));
  }

  // Too big to send whole: a window, but kept inside the declaration and still
  // named after it, so the model knows where the lines came from.
  const lower = block?.start ?? 0;
  const upper = block?.end ?? lines.length - 1;
  const start = Math.max(lower, target - context);
  const end = Math.min(upper, target + context);
  return slice(path, lines, start, end, block !== undefined ? symbolOf(lines[block.header]) : undefined);
}

/** A small file whole; a larger one as an outline of its top-level declarations. */
export function sliceUnlocated(path: string, source: string): CodeSlice {
  const lines = source.split('\n');
  if (Buffer.byteLength(source, 'utf8') <= WHOLE_FILE_BYTES) {
    return slice(path, lines, 0, lines.length - 1, undefined);
  }

  const whole = { start: 0, end: lines.length - 1, header: -1 };
  const indent = childIndent(lines, whole, 0);
  const headers = indent === undefined ? [] : blocksIn(lines, whole, 0, indent).map((block) => block.header);

  const entries = headers
    .slice(0, OUTLINE_MAX_ENTRIES)
    .map((index) => `${index + 1}: ${(lines[index] ?? '').trimEnd().slice(0, 160)}`);
  if (headers.length > OUTLINE_MAX_ENTRIES) entries.push(`… ${headers.length - OUTLINE_MAX_ENTRIES} more`);

  return {
    path,
    startLine: 1,
    endLine: lines.length,
    source: entries.join('\n'),
    symbol: 'outline: top-level declarations only, as "line: text"; read the file for bodies',
  };
}

interface Block {
  /** 0-based, inclusive, including leading comments and decorators. */
  readonly start: number;
  readonly end: number;
  /** The declaration line itself. */
  readonly header: number;
}

/**
 * The largest declaration around `target` that fits `maxLines`, narrowing from
 * top level inward (class → method). Returns the innermost block reached when
 * nothing fits, so the caller can still window inside it.
 */
function enclosingBlock(lines: readonly string[], target: number, maxLines: number): Block | undefined {
  let found: Block | undefined;
  let range: Block = { start: 0, end: lines.length - 1, header: -1 };
  let bodyStart = 0;

  for (;;) {
    const indent = childIndent(lines, range, bodyStart);
    if (indent === undefined) return found;

    const block = blocksIn(lines, range, bodyStart, indent).find((b) => b.start <= target && target <= b.end);
    // Narrower than a few lines means we have reached statements, not declarations.
    if (block === undefined || block.end - block.start + 1 < MIN_BLOCK_LINES) return found;

    found = block;
    if (block.end - block.start + 1 <= maxLines || block.header === target) return found;

    range = block;
    bodyStart = block.header + 1;
  }
}

/** The indentation of the shallowest declaration-like line in a body. */
function childIndent(lines: readonly string[], range: Block, bodyStart: number): number | undefined {
  const parent = range.header >= 0 ? indentOf(lines[range.header] ?? '') : -1;
  let min: number | undefined;
  for (let i = bodyStart; i <= range.end; i++) {
    const text = lines[i] ?? '';
    if (!isHeader(text)) continue;
    const indent = indentOf(text);
    if (indent > parent && (min === undefined || indent < min)) min = indent;
  }
  return min;
}

/** Split a body into declarations at one indentation level. */
function blocksIn(lines: readonly string[], range: Block, bodyStart: number, indent: number): Block[] {
  const headers: number[] = [];
  for (let i = bodyStart; i <= range.end; i++) {
    const text = lines[i] ?? '';
    if (indentOf(text) === indent && isHeader(text)) headers.push(i);
  }

  return headers.map((header, index) => {
    // Comments and decorators directly above belong to the declaration below.
    let start = header;
    while (start - 1 >= bodyStart && isAttachment(lines[start - 1] ?? '')) start--;

    // It runs to the next declaration, minus whatever that one claimed and any
    // trailing blank lines.
    let end = (headers[index + 1] ?? range.end + 1) - 1;
    while (end > header && (isBlank(lines[end] ?? '') || isAttachment(lines[end] ?? ''))) end--;

    return { start, end, header };
  });
}

function isHeader(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '' || isAttachment(text)) return false;
  // Closers and continuations belong to the declaration above them.
  return !/^[}\])]/.test(trimmed) && !/^(else|elif|except|finally|catch)\b/.test(trimmed);
}

function isAttachment(text: string): boolean {
  return /^\s*(\/\/|\/\*|\*|#|@|<!--)/.test(text);
}

function isBlank(text: string): boolean {
  return text.trim() === '';
}

function indentOf(text: string): number {
  return text.length - text.trimStart().length;
}

function symbolOf(header: string | undefined): string | undefined {
  const trimmed = header?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed.replace(/\s*[{:]\s*$/, '').slice(0, 120);
}

function slice(path: string, lines: readonly string[], start: number, end: number, symbol: string | undefined): CodeSlice {
  return {
    path,
    startLine: start + 1,
    endLine: end + 1,
    source: lines.slice(start, end + 1).join('\n'),
    ...(symbol !== undefined ? { symbol } : {}),
  };
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Already shown: a line inside an existing slice of the file, or any view at all
 * of a file when the target has no line. Two errors in one function cost one slice.
 */
function covered(slices: readonly CodeSlice[], path: string, line: number | undefined): boolean {
  return slices.some(
    (slice) => slice.path === path && (line === undefined || (slice.startLine <= line && line <= slice.endLine)),
  );
}
