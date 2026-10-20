/**
 * The pre-push hook (D-036).
 *
 * A regression is cheapest to fix minutes after it was written, while the change
 * is still in its author's head — and the last moment before it leaves the machine
 * is `git push`. The hook runs the loop there, then turns the outcome into a push
 * decision:
 *
 *   - nothing failing            → push
 *   - fixes were committed       → stop, so the person reviews them and pushes again
 *                                  (the push in progress would not include them)
 *   - something is still failing → stop; `git push --no-verify` is the way past
 *   - uncommitted changes        → skip, and say so: the tree being measured is not
 *                                  what is being pushed, and the loop will not touch
 *                                  a dirty tree anyway (invariant 5)
 *
 * The hook is a few lines of `sh` — git runs hooks with sh everywhere, Git for
 * Windows included — that finds the CLI and hands over. A hook this tool did not
 * write is never overwritten or removed.
 */
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { GitRepo } from '@self-heal/core/git/repo';
import type { RunReport } from '@self-heal/core/runner/runner';

/** Identifies a hook this tool wrote, so it is the only kind it will replace or remove. */
export const HOOK_MARKER = '# installed by self-heal';

export class HookError extends Error {}

export interface HookOptions {
  /** Block on failures without calling a model: `run --dry-run`. Free. */
  readonly detectOnly?: boolean;
  /** Config path to pass through, relative to the repository root. */
  readonly config?: string;
}

export function hookScript(options: HookOptions = {}): string {
  const args = ['run', '--pre-push'];
  if (options.detectOnly === true) args.push('--dry-run');
  if (options.config !== undefined && options.config !== './self-heal.config.json') args.push('--config', options.config);
  const argv = args.map(shellQuote).join(' ');

  return [
    '#!/bin/sh',
    `${HOOK_MARKER} — remove with \`self-heal hook uninstall\`.`,
    '# Runs the self-heal loop before a push; see `self-heal --help`.',
    '# git runs hooks from the top of the working tree, so ./node_modules is this project\'s.',
    'if [ -x ./node_modules/.bin/self-heal ]; then',
    `  exec ./node_modules/.bin/self-heal ${argv}`,
    'elif command -v self-heal >/dev/null 2>&1; then',
    `  exec self-heal ${argv}`,
    'else',
    '  echo "self-heal: not installed here, so the pre-push check was skipped" >&2',
    '  exit 0',
    'fi',
    '',
  ].join('\n');
}

export type InstallResult = { readonly path: string; readonly status: 'installed' | 'updated' };

export async function installHook(repo: GitRepo, options: HookOptions = {}): Promise<InstallResult> {
  const path = await hookPath(repo);
  const existing = await readFile(path, 'utf8').catch(() => null);
  if (existing !== null && !existing.includes(HOOK_MARKER)) {
    throw new HookError(
      `${path} already exists and was not written by self-heal; it was left alone.\n` +
        'Add `self-heal run --pre-push` to it yourself, or move it aside and install again.',
    );
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, hookScript(options), 'utf8');
  // Ignored on Windows, where Git for Windows runs hooks regardless.
  await chmod(path, 0o755);
  return { path, status: existing === null ? 'installed' : 'updated' };
}

export type UninstallResult = { readonly path: string; readonly status: 'removed' | 'absent' | 'foreign' };

export async function uninstallHook(repo: GitRepo): Promise<UninstallResult> {
  const path = await hookPath(repo);
  const existing = await readFile(path, 'utf8').catch(() => null);
  if (existing === null) return { path, status: 'absent' };
  if (!existing.includes(HOOK_MARKER)) return { path, status: 'foreign' };
  await unlink(path);
  return { path, status: 'removed' };
}

/** `--git-path` honours `core.hooksPath` and worktrees; joining `.git/hooks` by hand does not. */
async function hookPath(repo: GitRepo): Promise<string> {
  const path = await repo.gitPath('hooks/pre-push');
  if (path === null) throw new HookError(`${repo.dir} is not a git repository`);
  return path;
}

export interface PrePushVerdict {
  /** 0 lets the push proceed; anything else stops it. */
  readonly code: number;
  readonly message: string;
}

/** The push decision, from the run that just happened — or did not, on a dirty tree. */
export function prePushVerdict(input: { readonly dirty: boolean; readonly report?: RunReport }): PrePushVerdict {
  if (input.dirty || input.report === undefined) {
    return {
      code: 0,
      message:
        'self-heal: uncommitted changes, so the pre-push check was skipped — what is being pushed was not measured.\n' +
        'Commit or stash them to have it checked.',
    };
  }

  const { report } = input;
  if (report.halted) {
    return { code: 1, message: `self-heal: push stopped — ${report.haltReason ?? 'the run halted'}.` };
  }
  if (report.issues === 0) return { code: 0, message: 'self-heal: all checks pass.' };

  const healed = report.outcomes.filter((o) => o.state === 'HEALED').length;
  const failing = report.outcomes.filter((o) => o.state !== 'HEALED' && o.state !== 'RESOLVED');

  const lines: string[] = [];
  if (healed > 0) {
    lines.push(
      `self-heal committed ${healed} verified fix(es) on top of what you were pushing — this push would not include them.`,
      'Review them (git log --author=self-heal), then push again.',
    );
  }
  if (failing.length > 0) {
    const names = [...new Set(failing.map((o) => o.issue.detectorId))].join(', ');
    lines.push(
      `self-heal: push stopped — still failing: ${names}.`,
      'Fix it, or push anyway with `git push --no-verify`.',
    );
  }
  if (lines.length === 0) return { code: 0, message: 'self-heal: all checks pass.' };
  return { code: 1, message: lines.join('\n') };
}

function shellQuote(arg: string): string {
  return /^[\w./=-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}
