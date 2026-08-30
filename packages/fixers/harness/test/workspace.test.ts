/**
 * The workspace is the containment boundary: whatever a model does, it does in
 * here, and this directory stops existing afterwards. So these tests are about
 * isolation and cleanup rather than about copying files correctly.
 */
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { GitRepo } from '@self-heal/core/git/repo';
import { Sandbox } from '@self-heal/testkit/sandbox';
import { afterEach, describe, expect, it } from 'vitest';

import { createGitWorkspace, WorkspaceError } from '../src/workspace.js';
import type { HarnessWorkspace } from '../src/index.js';

let sandbox: Sandbox | undefined;
const workspaces: HarnessWorkspace[] = [];

afterEach(async () => {
  for (const workspace of workspaces.splice(0)) await workspace.dispose().catch(() => {});
  await sandbox?.dispose();
  sandbox = undefined;
});

async function open(repoRoot: string): Promise<HarnessWorkspace> {
  const workspace = await createGitWorkspace({ repoRoot });
  workspaces.push(workspace);
  return workspace;
}

const FILES = {
  'src/pricing.mjs': 'export const rate = 0;\n',
  'README.md': '# demo\n',
  '.gitignore': 'secrets/\n.env\n',
};

describe('createGitWorkspace', () => {
  it('copies the tracked tree into a directory of its own', async () => {
    sandbox = await Sandbox.create({ files: FILES, prefix: 'self-heal-ws-src-' });
    const workspace = await open(sandbox.dir);

    expect(workspace.dir).not.toBe(sandbox.dir);
    expect(await readFile(join(workspace.dir, 'src/pricing.mjs'), 'utf8')).toBe(FILES['src/pricing.mjs']);
  });

  it('does not copy what the project has told git to ignore', async () => {
    sandbox = await Sandbox.create({ files: FILES, prefix: 'self-heal-ws-src-' });
    await mkdir(join(sandbox.dir, 'secrets'), { recursive: true });
    await writeFile(join(sandbox.dir, 'secrets/key.txt'), 'hunter2', 'utf8');
    await writeFile(join(sandbox.dir, '.env'), 'TOKEN=abc123', 'utf8');

    const workspace = await open(sandbox.dir);

    // `.gitignore` is the right authority to delegate to: a team has already
    // decided these files do not leave the machine, and a model is a very
    // effective way for them to leave the machine.
    await expect(stat(join(workspace.dir, 'secrets/key.txt'))).rejects.toThrow();
    await expect(stat(join(workspace.dir, '.env'))).rejects.toThrow();
  });

  it('is a git repository with a baseline, so a change can be measured against it', async () => {
    sandbox = await Sandbox.create({ files: FILES, prefix: 'self-heal-ws-src-' });
    const workspace = await open(sandbox.dir);
    const repo = new GitRepo({ dir: workspace.dir });

    expect(await repo.isClean()).toBe(true);
    await writeFile(join(workspace.dir, 'src/pricing.mjs'), 'export const rate = 0.2;\n', 'utf8');

    // This is exactly what `capturePatch` relies on — without a baseline commit
    // there is nothing to diff a proposal against.
    expect((await repo.changes()).map((change) => change.path)).toEqual(['src/pricing.mjs']);
  });

  it('leaves the real repository untouched no matter what happens inside', async () => {
    sandbox = await Sandbox.create({ files: FILES, prefix: 'self-heal-ws-src-' });
    const workspace = await open(sandbox.dir);

    await writeFile(join(workspace.dir, 'src/pricing.mjs'), 'wrecked\n', 'utf8');
    await writeFile(join(workspace.dir, 'invented.mjs'), 'new file\n', 'utf8');
    await rm(join(workspace.dir, 'README.md'));

    // The containment claim, asserted rather than assumed.
    expect(await sandbox.read('src/pricing.mjs')).toBe(FILES['src/pricing.mjs']);
    expect(await sandbox.read('README.md')).toBe(FILES['README.md']);
    expect(await new GitRepo({ dir: sandbox.dir }).isClean()).toBe(true);
  });

  it('deletes itself on dispose, and does not mind being disposed twice', async () => {
    sandbox = await Sandbox.create({ files: FILES, prefix: 'self-heal-ws-src-' });
    const workspace = await createGitWorkspace({ repoRoot: sandbox.dir });

    await workspace.dispose();
    await expect(stat(workspace.dir)).rejects.toThrow();
    // Called from a `finally` on the happy path and from cleanup on the unhappy
    // one — sometimes both.
    await workspace.dispose();
  });

  it('skips a file too large to be worth showing a model', async () => {
    sandbox = await Sandbox.create({ files: FILES, prefix: 'self-heal-ws-src-' });
    await writeFile(join(sandbox.dir, 'huge.bin'), 'x'.repeat(4096), 'utf8');
    await new GitRepo({ dir: sandbox.dir }).checkpoint('add a large file');

    const workspace = await createGitWorkspace({ repoRoot: sandbox.dir, maxFileBytes: 64 });
    workspaces.push(workspace);

    await expect(stat(join(workspace.dir, 'huge.bin'))).rejects.toThrow();
    expect(await readFile(join(workspace.dir, 'README.md'), 'utf8')).toBe(FILES['README.md']);
  });

  it('refuses a directory that is not a repository, instead of making an empty one', async () => {
    // An empty workspace would let the harness "fix" a problem by editing
    // nothing, and the failure would surface much later as an empty patch.
    await expect(createGitWorkspace({ repoRoot: join(process.cwd(), 'does-not-exist') })).rejects.toBeInstanceOf(
      WorkspaceError,
    );
  });
});
