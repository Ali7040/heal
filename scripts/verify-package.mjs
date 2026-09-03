#!/usr/bin/env node
/**
 * Prove the *published* artifact works, not the workspace.
 *
 * `pnpm publish --dry-run` checks that a tarball can be built. It does not check
 * that the tarball, installed by a stranger who has never cloned this repo, can
 * actually run — and that is the only claim worth making before publishing. The
 * gap between the two is where the ordinary release bugs live: a file missing
 * from `files`, an export map pointing at a path that was never emitted, a
 * `workspace:*` that did not get rewritten, a bin without its execute bit.
 *
 * So this packs every publishable package, installs the tarballs into a clean
 * project outside the repository, and drives the resulting `self-heal` binary
 * against a scratch git repository containing a real failing check.
 *
 * It never touches the network for @self-heal packages: every one of them is
 * installed from the tarball beside it, so a version that does not line up
 * surfaces as a resolution failure here rather than as a broken install for
 * someone else.
 */
import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = 'self-heal';

/** The same two-level walk `prepare-release.mjs` does, minus the private ones. */
async function publishablePackages(dir = join(root, 'packages'), depth = 0) {
  if (depth > 2) return [];
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    const child = join(dir, entry.name);
    const manifest = await readManifest(join(child, 'package.json'));
    if (manifest === undefined) {
      found.push(...(await publishablePackages(child, depth + 1)));
    } else if (manifest.private !== true) {
      found.push(child);
    }
  }
  return found;
}

async function readManifest(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

const run = (cmd, args, cwd, extra = {}) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32', ...extra });

const step = (message) => console.log(`\n→ ${message}`);
const ok = (message) => console.log(`  ✓ ${message}`);

function fail(message) {
  console.error(`\n  ✗ ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

const scratch = await mkdtemp(join(tmpdir(), 'self-heal-verify-'));
const tarballs = join(scratch, 'tarballs');
const consumer = join(scratch, 'consumer');
const target = join(scratch, 'target');

try {
  step('building and preparing');
  run('pnpm', ['build'], root, { stdio: 'inherit' });
  run('node', ['scripts/prepare-release.mjs'], root, { stdio: 'inherit' });

  step('packing every publishable package');
  await mkdir(tarballs, { recursive: true });
  // Packed one at a time rather than with `pnpm -r`, so a `private` package is
  // skipped rather than packed and then quietly ignored. `pnpm pack` rewrites
  // `workspace:*` on the way out, which is the exact transformation under test:
  // anything it fails to rewrite fails to install two steps below.
  for (const pkg of await publishablePackages()) {
    run('pnpm', ['pack', '--pack-destination', tarballs], pkg, { stdio: 'ignore' });
  }

  const packed = (await readdir(tarballs)).filter((name) => name.endsWith('.tgz'));
  const byPackage = new Map();
  for (const name of packed) {
    // self-heal-0.1.0.tgz -> self-heal;  self-heal-core-0.1.0.tgz -> @self-heal/core
    const base = name.replace(/-\d+\.\d+\.\d+.*\.tgz$/, '');
    const pkg = base === CLI ? CLI : `@self-heal/${base.replace(/^self-heal-/, '')}`;
    byPackage.set(pkg, join(tarballs, name));
  }
  if (!byPackage.has(CLI)) fail(`no ${CLI} tarball was produced`);
  ok(`${byPackage.size} tarball(s): ${[...byPackage.keys()].sort().join(', ')}`);

  step('installing them into a clean project, with no registry access to @self-heal');
  await mkdir(consumer, { recursive: true });
  // Every package is named directly with a *relative* `file:` spec. Relative
  // because an absolute Windows path in a `file:` spec is silently mis-parsed
  // (npm reads the drive letter as a protocol), which cost a run of this script
  // to discover. Naming them all rather than only the CLI is what makes the
  // install a real test: npm must satisfy each transitive `@self-heal/x@0.1.0`
  // from the tarball beside it, and a version that does not line up falls
  // through to the registry and 404s here instead of at someone else's install.
  for (const [, path] of byPackage) await copyFile(path, join(consumer, basename(path)));
  const dependencies = Object.fromEntries(
    [...byPackage].map(([name, path]) => [name, `file:./${basename(path)}`]),
  );
  await writeFile(
    join(consumer, 'package.json'),
    `${JSON.stringify({ name: 'self-heal-consumer', version: '0.0.0', private: true, dependencies }, null, 2)}\n`,
  );
  run('npm', ['install', '--no-audit', '--no-fund'], consumer, { stdio: 'inherit' });
  ok('installed');

  const bin = join(consumer, 'node_modules', '.bin', process.platform === 'win32' ? 'self-heal.cmd' : 'self-heal');
  const cli = (args, cwd, expected = 0) => {
    try {
      const stdout = run(bin, args, cwd);
      if (expected !== 0) fail(`\`self-heal ${args.join(' ')}\` exited 0, expected ${expected}`);
      return stdout;
    } catch (error) {
      if (error.status === undefined) throw error;
      if (error.status !== expected) {
        fail(`\`self-heal ${args.join(' ')}\` exited ${error.status}, expected ${expected}\n${error.stdout ?? ''}${error.stderr ?? ''}`);
      }
      return `${error.stdout ?? ''}`;
    }
  };

  step('the installed binary starts');
  const help = cli(['--help'], consumer);
  if (!help.includes('self-heal — detect, propose, verify, record')) fail('--help printed something unexpected');
  ok('--help');

  step('it detects a real failure in a repository that has never seen this project');
  await mkdir(join(target, 'src'), { recursive: true });
  await writeFile(
    join(target, 'src', 'check.mjs'),
    'process.stderr.write("total is missing from the response\\n");\nprocess.exit(1);\n',
  );
  run('git', ['init', '-q'], target);
  run('git', ['config', 'user.email', 'verify@example.com'], target);
  run('git', ['config', 'user.name', 'verify'], target);

  cli(['init'], target);
  ok('init wrote a config and a .gitignore');

  await writeFile(
    join(target, 'self-heal.config.json'),
    `${JSON.stringify(
      {
        allowlist: ['src/**/*.mjs'],
        checks: [{ id: 'smoke', command: 'node', args: ['src/check.mjs'], editable: ['src/**/*.mjs'] }],
        harness: 'claude-code',
        attemptCap: 1,
      },
      null,
      2,
    )}\n`,
  );
  run('git', ['add', '-A'], target);
  run('git', ['commit', '-qm', 'initial'], target);

  // `--fixer noop` keeps this free: it detects, diagnoses, and reports without
  // ever calling a model, so the check runs in CI and on a machine with no
  // harness installed. Exit 1 is the correct outcome — the issue is real.
  //
  // ESCALATED is the right verdict, not a disappointment: the check really did
  // fail, the noop fixer really did propose nothing, and the run really is
  // unhealed. Asserting on it pins the whole path — detect, propose, measure,
  // report, exit non-zero — rather than just "the binary did not crash".
  const report = cli(['run', '--fixer', 'noop'], target, 1);
  for (const expected of ['ESCALATED', 'check-failed', '0/1 healed']) {
    if (!report.includes(expected)) fail(`the run report is missing ${expected}:\n${report}`);
  }
  ok('detected the failing check, escalated it, and exited non-zero');

  step('--only narrows the run, and refuses a name it does not know');
  const narrowed = cli(['run', '--fixer', 'noop', '--only', 'smoke'], target, 1);
  if (!narrowed.includes('ESCALATED')) fail(`--only smoke did not run the smoke detector:
${narrowed}`);
  // Exit 2 is a config error, and that is the point: a typo must never be a
  // green run that measured nothing.
  cli(['run', '--fixer', 'noop', '--only', 'smoek'], target, 2);
  ok('--only smoke ran it; --only smoek was refused');

  step('the journal command works on a fresh install');
  cli(['journal'], target);
  ok('journal');

  console.log(`\n✓ the published artifact works. ${byPackage.size} package(s) ready at 0.1.0.\n`);
} finally {
  run('node', ['scripts/prepare-release.mjs', '--clean'], root, { stdio: 'inherit' });
  await rm(scratch, { recursive: true, force: true });
}
