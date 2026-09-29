/**
 * Where a failing command says the problem is.
 *
 * Compilers, linters, and test runners all print `file:line` somewhere — a type
 * error, a lint row, an assertion's stack frame. Without it, a command issue has no
 * line, and the diagnosis can only offer an outline of a file (D-019). With it, the
 * model is shown the function that failed.
 *
 * This is parsing, not understanding: a handful of patterns that cover the formats
 * of tsc, eslint, vitest/jest/node stacks, pytest/Python tracebacks, go, and rustc.
 * Every match is then checked against the repository — a path that is not a file
 * in the repo is dropped — so a timestamp or a URL that happens to look like
 * `name.ext:12` costs nothing. A miss just falls back to the outline.
 */
import { stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import type { IssueLocation } from '@self-heal/core/contracts/issue';
import { matches } from '@self-heal/core/safety/allowlist';

/** Most locations kept. The diagnosis budget decides how many are shown. */
export const MAX_REPORTED_LOCATIONS = 5;

const PATH = String.raw`[A-Za-z0-9_@.\/\\-]*[A-Za-z0-9_@-]\.[A-Za-z0-9]{1,8}`;

const PATTERNS: readonly RegExp[] = [
  // Python traceback:        File "app/models.py", line 12, in load
  /File "([^"]+)", line (\d+)/g,
  // tsc (default format):    src/a.ts(12,5): error TS2322
  new RegExp(String.raw`(${PATH})\((\d+),\d+\)`, 'g'),
  // everything else:         src/a.ts:12:5  ·  at f (src/a.ts:12:5)  ·  --> src/main.rs:12:5  ·  a.py:12: AssertionError
  new RegExp(String.raw`(${PATH}):(\d+)`, 'g'),
];

/** eslint's default "stylish" format: a path alone on a line, then indented `12:5  error …` rows. */
const ESLINT_HEADER = new RegExp(String.raw`^(${PATH})$`);
const ESLINT_ROW = /^\s+(\d+):\d+\s+(?:error|warning)\b/;

export interface FindLocationsOptions {
  readonly repoRoot: string;
  /** Globs the check may edit. Matching locations are ranked first. */
  readonly editable?: readonly string[];
  readonly limit?: number;
}

export async function findLocations(output: string, options: FindLocationsOptions): Promise<IssueLocation[]> {
  const candidates = candidatesIn(stripRoot(output, options.repoRoot));

  const exists = new Map<string, boolean>();
  const found: IssueLocation[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const file = normalize(candidate.file);
    if (file === null) continue;

    const key = `${file}:${candidate.line}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (!exists.has(file)) exists.set(file, await isFile(join(options.repoRoot, file)));
    if (exists.get(file) !== true) continue;

    found.push({ file, line: candidate.line });
  }

  // The file a fix will be written in beats the test that noticed — but both are
  // kept, and order of appearance breaks ties, which is usually causal order.
  const editable = options.editable ?? [];
  const rank = (location: IssueLocation) =>
    editable.some((glob) => matches(location.file ?? '', glob)) ? 0 : 1;
  return found
    .map((location, index) => ({ location, index }))
    .sort((a, b) => rank(a.location) - rank(b.location) || a.index - b.index)
    .slice(0, options.limit ?? MAX_REPORTED_LOCATIONS)
    .map(({ location }) => location);
}

interface Candidate {
  readonly file: string;
  readonly line: number;
  readonly at: number;
}

function candidatesIn(output: string): Candidate[] {
  const candidates: Candidate[] = [];

  for (const pattern of PATTERNS) {
    for (const match of output.matchAll(pattern)) {
      const line = Number(match[2]);
      if (match[1] !== undefined && Number.isInteger(line) && line > 0) {
        candidates.push({ file: match[1], line, at: match.index });
      }
    }
  }

  let offset = 0;
  let header: string | undefined;
  for (const text of output.split('\n')) {
    const trimmed = text.trim();
    const row = ESLINT_ROW.exec(text);
    if (ESLINT_HEADER.test(trimmed)) header = trimmed;
    else if (row !== null && header !== undefined) candidates.push({ file: header, line: Number(row[1]), at: offset });
    else if (trimmed === '') header = undefined;
    offset += text.length + 1;
  }

  // Order of appearance in the output, whichever pattern found it.
  return candidates.sort((a, b) => a.at - b.at);
}

/**
 * Absolute paths into the repo become relative before matching, so a Windows
 * `C:\repo\src\a.ts:12` is not misread as a file named `C` at line `\repo…`.
 */
function stripRoot(output: string, repoRoot: string): string {
  const variants = new Set([repoRoot, repoRoot.replace(/\\/g, '/'), repoRoot.replace(/\//g, '\\')]);
  let text = output.replace(/file:\/\/\/?/g, '');
  for (const root of variants) {
    const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(`${escaped}[\\\\/]`, 'gi'), '');
  }
  return text;
}

function normalize(file: string): string | null {
  const posix = file.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  if (posix === '' || isAbsolute(posix) || /^[A-Za-z]:/.test(posix)) return null;
  if (posix.startsWith('../') || posix.includes('/../')) return null;
  // Library frames are real files but never the fix.
  if (posix.includes('node_modules/') || posix.startsWith('.git/')) return null;
  return posix;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
