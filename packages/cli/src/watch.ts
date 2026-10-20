/**
 * Watch mode (D-036): re-measure on every save, and say only what changed.
 *
 * The loop will not touch a dirty tree (invariant 5), and while someone is editing
 * the tree is dirty by definition. So watching is detection, which is free; healing
 * happens only with `--heal`, only when the tree is clean — just after a commit,
 * typically — and only once per issue per session. Without that last rule, a fix
 * that keeps failing would be retried, and paid for, every few seconds.
 *
 * The pieces with decisions in them are plain functions, tested on their own; the
 * loop around them is file watching and timers.
 */
import type { Issue } from '@self-heal/core/contracts/issue';
import type { RunReport } from '@self-heal/core/runner/runner';

/** Which check an issue is, regardless of how it fails today. Mirrors the runner's own key. */
export function checkKeyOf(issue: Issue): string {
  const { file, line, endpoint, selector } = issue.location;
  return JSON.stringify([issue.detectorId, issue.kind, file ?? null, line ?? null, endpoint ?? null, selector ?? null]);
}

export interface Failing {
  readonly label: string;
  readonly signature: string;
}

/** Checks still failing after a run: not healed, not resolved, and not a flake. */
export function failingChecks(report: RunReport): Map<string, Failing> {
  const failing = new Map<string, Failing>();
  for (const outcome of report.outcomes) {
    if (outcome.state === 'HEALED' || outcome.state === 'RESOLVED' || outcome.state === 'FLAKY') continue;
    failing.set(checkKeyOf(outcome.issue), {
      label: `${outcome.issue.detectorId} (${outcome.issue.kind})`,
      signature: outcome.issue.signature,
    });
  }
  return failing;
}

/** One line per check that started or stopped failing. Unchanged checks say nothing. */
export function statusChanges(previous: ReadonlyMap<string, Failing>, current: ReadonlyMap<string, Failing>): string[] {
  const lines: string[] = [];
  for (const [key, check] of current) if (!previous.has(key)) lines.push(`✗ ${check.label} is failing`);
  for (const [key, check] of previous) if (!current.has(key)) lines.push(`✔ ${check.label} passes again`);
  return lines;
}

/**
 * Heal only what has not been tried this session, and only on a clean tree. A
 * signature attempted once and escalated stays escalated until the session ends —
 * or until a change makes it fail differently, which gives it a new signature.
 */
export function signaturesToHeal(input: {
  readonly heal: boolean;
  readonly clean: boolean;
  readonly failing: ReadonlyMap<string, Failing>;
  readonly attempted: ReadonlySet<string>;
}): string[] {
  if (!input.heal || !input.clean) return [];
  return [...input.failing.values()].map((f) => f.signature).filter((sig) => !input.attempted.has(sig));
}

/** Paths that are never the user's edits: git internals, this tool's state, dependencies. */
const NEVER_RELEVANT = ['.git/', '.self-heal/', 'node_modules/'];

export function maybeRelevant(path: string): boolean {
  const posix = path.split('\\').join('/');
  return !NEVER_RELEVANT.some((prefix) => posix === prefix.slice(0, -1) || posix.startsWith(prefix) || posix.includes(`/${prefix}`));
}

/**
 * Collect bursts of events into one call, `delayMs` after the last of them. A save
 * is often several events (write, rename, chmod); a branch switch is hundreds.
 */
export function debounce(delayMs: number, flush: (paths: string[]) => void): (path: string) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Set<string>();
  return (path: string) => {
    pending.add(path);
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      const paths = [...pending];
      pending.clear();
      flush(paths);
    }, delayMs);
  };
}
