/**
 * The GitHub Action's script, run for real against a throwaway repository.
 *
 * GitHub itself cannot run here, but everything the action does is git, a
 * process, and a call to `gh` — so `origin` is a bare repo, and `self-heal` and
 * `gh` are small node stand-ins. What is asserted is what matters: which refs
 * were pushed where, and what the PR was asked to be (D-032).
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../action/heal.sh');

/** Git Bash on Windows — a bare `bash` there may be WSL, which cannot use these paths. */
function findBash(): string | undefined {
  if (process.platform !== 'win32') return 'bash';
  return ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'].find((p) => existsSync(p));
}
const bash = findBash();

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true }).catch(() => {});
  dir = undefined;
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

/** A repo on `main` with a bare `origin`, plus stand-ins for self-heal and gh. */
async function setup() {
  dir = await mkdtemp(join(tmpdir(), 'self-heal-action-'));
  const origin = join(dir, 'origin.git');
  const work = join(dir, 'work');
  const temp = join(dir, 'runner-temp');
  for (const path of [work, temp]) await import('node:fs/promises').then((fs) => fs.mkdir(path, { recursive: true }));

  git(dir, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
  git(dir, 'init', '--quiet', '--initial-branch=main', work);
  git(work, 'config', 'user.name', 'test');
  git(work, 'config', 'user.email', 'test@localhost');
  git(work, 'config', 'core.autocrlf', 'false');
  await writeFile(join(work, 'value.txt'), 'broken\n');
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '-m', 'initial');
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '--quiet', 'origin', 'main');

  // `self-heal run …`: STUB_FIX=1 makes one fix commit, as a heal would.
  await writeFile(
    join(dir, 'self-heal-stub.mjs'),
    `import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const report = args[args.indexOf('--report-md') + 1];
if (process.env.STUB_FIX === '1') {
  writeFileSync('value.txt', 'fixed\\n');
  execFileSync('git', ['-c', 'user.name=self-heal', '-c', 'user.email=self-heal@localhost', 'commit', '-qam', 'self-heal: fix check-failed (abc12345)']);
}
writeFileSync(report, '## self-heal: stub report\\n');
process.exit(Number(process.env.STUB_EXIT ?? 0));
`,
  );
  // `gh pr create …`: records its arguments, prints a URL.
  await writeFile(
    join(dir, 'gh-stub.mjs'),
    `import { appendFileSync } from 'node:fs';
appendFileSync(process.env.GH_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write('https://github.com/acme/app/pull/7\\n');
`,
  );

  return { origin, work, temp };
}

function heal(work: string, temp: string, env: Record<string, string>) {
  const ghLog = join(temp, 'gh.log');
  const outputs = join(temp, 'outputs');
  const summary = join(temp, 'summary.md');
  const result = spawnSync(bash as string, [SCRIPT], {
    cwd: work,
    encoding: 'utf8',
    env: {
      ...process.env,
      SELF_HEAL_BASE: 'main',
      SELF_HEAL_BRANCH: 'self-heal/42-1',
      SELF_HEAL_CMD: `node ${join(dir as string, 'self-heal-stub.mjs').replace(/\\/g, '/')}`,
      GH: `node ${join(dir as string, 'gh-stub.mjs').replace(/\\/g, '/')}`,
      GH_LOG: ghLog,
      RUNNER_TEMP: temp,
      GITHUB_OUTPUT: outputs,
      GITHUB_STEP_SUMMARY: summary,
      GITHUB_EVENT_NAME: 'workflow_run',
      GITHUB_REPOSITORY: 'acme/app',
      ...env,
    },
  });
  const read = async (path: string) => (existsSync(path) ? readFile(path, 'utf8') : '');
  return {
    status: result.status,
    stderr: result.stderr,
    gh: async () => (await read(ghLog)).split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]),
    outputs: async () =>
      Object.fromEntries(
        (await read(outputs))
          .split('\n')
          .filter(Boolean)
          .map((line) => line.split('=', 2) as [string, string]),
      ),
    summary: () => read(summary),
  };
}

describe.skipIf(bash === undefined)('the GitHub Action script', () => {
  it('pushes the fix to a self-heal branch and opens a PR against the base — never touching the base', async () => {
    const { origin, work, temp } = await setup();
    const mainBefore = git(origin, 'rev-parse', 'main');

    const run = heal(work, temp, { STUB_FIX: '1' });

    expect(run.status, run.stderr).toBe(0);
    expect(git(origin, 'rev-parse', 'main')).toBe(mainBefore);
    expect(git(origin, 'log', '-1', '--format=%s', 'self-heal/42-1')).toBe('self-heal: fix check-failed (abc12345)');
    // bash joins with "/", node with the platform separator — the same file either way.
    const calls = (await run.gh()).map((args) => args.map((arg) => arg.replace(/\\/g, '/')));
    expect(calls).toEqual([
      [
        'pr', 'create', '--base', 'main', '--head', 'self-heal/42-1',
        '--title', 'self-heal: 1 verified fix(es)',
        '--body-file', join(temp, 'self-heal-report.md').replace(/\\/g, '/'),
      ],
    ]);
    expect(await run.outputs()).toMatchObject({ fixes: '1', 'exit-code': '0', 'pr-url': 'https://github.com/acme/app/pull/7' });
    expect(await run.summary()).toContain('## self-heal: stub report');
  });

  it('pushes nothing and opens nothing when no fix was verified, and passes the exit code through', async () => {
    const { origin, work, temp } = await setup();

    const run = heal(work, temp, { STUB_EXIT: '1' });

    expect(run.status).toBe(1);
    expect(git(origin, 'branch', '--list', 'self-heal/*')).toBe('');
    expect(await run.gh()).toEqual([]);
    expect(await run.outputs()).toMatchObject({ fixes: '0', 'exit-code': '1' });
  });

  it('commits but does not push when open-pr is off', async () => {
    const { origin, work, temp } = await setup();

    const run = heal(work, temp, { STUB_FIX: '1', SELF_HEAL_OPEN_PR: 'false' });

    expect(run.status).toBe(0);
    expect(git(origin, 'branch', '--list', 'self-heal/*')).toBe('');
    expect(await run.gh()).toEqual([]);
  });

  it('refuses to push to a branch it does not own', async () => {
    const { origin, work, temp } = await setup();
    const mainBefore = git(origin, 'rev-parse', 'main');

    for (const branch of ['main', 'release', 'fix/self-heal']) {
      const run = heal(work, temp, { STUB_FIX: '1', SELF_HEAL_BRANCH: branch });
      expect(run.status, branch).toBe(64);
      expect(run.stderr).toContain('refusing');
    }
    expect(git(origin, 'rev-parse', 'main')).toBe(mainBefore);
  });

  it("refuses to run on a fork's code with this repository's secrets", async () => {
    const { work, temp } = await setup();
    const event = join(temp, 'event.json');
    await writeFile(event, JSON.stringify({ workflow_run: { head_repository: { full_name: 'stranger/app' } } }));

    const fromFork = heal(work, temp, { STUB_FIX: '1', GITHUB_EVENT_PATH: event });
    expect(fromFork.status).toBe(64);
    expect(fromFork.stderr).toContain('came from stranger/app');

    const target = heal(work, temp, { STUB_FIX: '1', GITHUB_EVENT_NAME: 'pull_request_target' });
    expect(target.status).toBe(64);
    expect(await target.gh()).toEqual([]);
  });
});
