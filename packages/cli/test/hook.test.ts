/**
 * The hook is tested where it matters: installed in a real repository and run by
 * a real `git push`, with a stand-in CLI in node_modules/.bin recording what it
 * was asked to do. The push decision itself is a pure function, tested directly.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GitRepo } from '@self-heal/core/git/repo';
import type { IssueOutcome, RunReport } from '@self-heal/core/runner/runner';
import { afterEach, describe, expect, it } from 'vitest';

import { HOOK_MARKER, HookError, hookScript, installHook, prePushVerdict, uninstallHook } from '../src/hook.js';

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'self-heal-hook-'));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'core.autocrlf', 'false');
  await writeFile(join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'initial');
  return dir;
}

describe('installHook', () => {
  it('writes a marked pre-push hook that runs the loop', async () => {
    const dir = await repo();
    const result = await installHook(new GitRepo({ dir }), { detectOnly: true });

    const script = await readFile(result.path, 'utf8');
    expect(result.status).toBe('installed');
    expect(script.startsWith('#!/bin/sh\n')).toBe(true);
    expect(script).toContain(HOOK_MARKER);
    expect(script).toContain('self-heal run --pre-push --dry-run');
  });

  it('updates its own hook, but never overwrites or removes one it did not write', async () => {
    const dir = await repo();
    const repository = new GitRepo({ dir });
    await installHook(repository);
    expect((await installHook(repository, { detectOnly: true })).status).toBe('updated');

    const path = (await repository.gitPath('hooks/pre-push')) as string;
    await writeFile(path, '#!/bin/sh\necho mine\n');
    await expect(installHook(repository)).rejects.toBeInstanceOf(HookError);
    expect((await uninstallHook(repository)).status).toBe('foreign');
    expect(await readFile(path, 'utf8')).toBe('#!/bin/sh\necho mine\n');
  });

  it('honours core.hooksPath, the way git itself finds hooks', async () => {
    const dir = await repo();
    git(dir, 'config', 'core.hooksPath', 'githooks');
    const result = await installHook(new GitRepo({ dir }));
    expect(result.path.split('\\').join('/')).toMatch(/\/githooks\/pre-push$/);
  });

  it('uninstalls cleanly, and says so when there is nothing to remove', async () => {
    const dir = await repo();
    const repository = new GitRepo({ dir });
    const { path } = await installHook(repository);

    expect((await uninstallHook(repository)).status).toBe('removed');
    expect(existsSync(path)).toBe(false);
    expect((await uninstallHook(repository)).status).toBe('absent');
  });

  it('quotes a config path so the shell cannot split or expand it', () => {
    expect(hookScript({ config: "my configs/self heal's.json" })).toContain(`--config 'my configs/self heal'\\''s.json'`);
  });
});

describe('the installed hook, run by a real git push', () => {
  async function pushWith(exitCode: number) {
    const dir = await repo();
    const origin = await mkdtemp(join(tmpdir(), 'self-heal-hook-origin-'));
    dirs.push(origin);
    git(origin, 'init', '-q', '--bare');
    git(dir, 'remote', 'add', 'origin', origin);

    // A stand-in CLI, where the hook looks first. It records its arguments.
    await mkdir(join(dir, 'node_modules', '.bin'), { recursive: true });
    await writeFile(
      join(dir, 'node_modules', '.bin', 'self-heal'),
      `#!/bin/sh\necho "$@" > "${join(origin, 'args.txt').split('\\').join('/')}"\nexit ${exitCode}\n`,
      { mode: 0o755 },
    );
    await writeFile(join(dir, '.gitignore'), 'node_modules/\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'ignore deps');

    await installHook(new GitRepo({ dir }), { detectOnly: true });
    const push = spawnSync('git', ['push', '-q', 'origin', 'main'], { cwd: dir, encoding: 'utf8' });
    const args = await readFile(join(origin, 'args.txt'), 'utf8').catch(() => '');
    const pushed = spawnSync('git', ['rev-parse', '--verify', '-q', 'main'], { cwd: origin, encoding: 'utf8' }).status === 0;
    return { push, args: args.trim(), pushed };
  }

  it('calls `self-heal run --pre-push`, and lets the push through when it passes', async () => {
    const { push, args, pushed } = await pushWith(0);
    expect(args).toBe('run --pre-push --dry-run');
    expect(push.status).toBe(0);
    expect(pushed).toBe(true);
  });

  it('stops the push when it fails', async () => {
    const { push, pushed } = await pushWith(1);
    expect(push.status).not.toBe(0);
    expect(pushed).toBe(false);
  });
});

describe('prePushVerdict', () => {
  function report(states: IssueOutcome['state'][], extra: Partial<RunReport> = {}): RunReport {
    return {
      issues: states.length,
      outcomes: states.map(
        (state, i) =>
          ({
            issue: { signature: `s${i}`, detectorId: `check${i}`, kind: 'k', location: {}, expected: 0, actual: 1, evidence: [], severity: 'high', detectedAt: '' },
            state,
            attempts: 1,
            reason: 'r',
            replayed: false,
          }) as IssueOutcome,
      ),
      halted: false,
      dryRun: false,
      durationMs: 1,
      ...extra,
    };
  }

  it('lets a push through on a dirty tree, saying it was not measured', () => {
    const verdict = prePushVerdict({ dirty: true });
    expect(verdict.code).toBe(0);
    expect(verdict.message).toMatch(/skipped/);
  });

  it('lets a clean push through', () => {
    expect(prePushVerdict({ dirty: false, report: report([]) }).code).toBe(0);
  });

  it('stops a push after committing fixes, so they are reviewed and included', () => {
    const verdict = prePushVerdict({ dirty: false, report: report(['HEALED', 'RESOLVED']) });
    expect(verdict.code).toBe(1);
    expect(verdict.message).toMatch(/committed 1 verified fix/);
    expect(verdict.message).toMatch(/push again/);
  });

  it('stops a push while anything still fails — including a dry run that only proposed', () => {
    for (const state of ['ESCALATED', 'PROPOSED', 'FLAKY'] as const) {
      const verdict = prePushVerdict({ dirty: false, report: report([state]) });
      expect(verdict.code, state).toBe(1);
      expect(verdict.message).toMatch(/--no-verify/);
    }
  });

  it('stops a push when the run halted, and says why', () => {
    const verdict = prePushVerdict({ dirty: false, report: report([], { halted: true, haltReason: 'another self-heal run is in progress' }) });
    expect(verdict.code).toBe(1);
    expect(verdict.message).toMatch(/another self-heal run/);
  });
});
