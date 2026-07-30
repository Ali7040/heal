/**
 * A disposable git repository, built from a file map and thrown away after.
 *
 * Why this exists as shared infrastructure rather than inline test setup:
 * everything this project does is defined by "what changed on disk, relative to
 * a known-good commit". Detectors need a repo to measure, fixers need a repo to
 * edit, and the safety layer needs a repo to check out. If each of them builds
 * its own scratch directory, they drift — one forgets `git init`, another leaves
 * temp dirs behind, a third can't commit on a machine with no git identity.
 *
 * A sandbox is also the containment boundary for the riskiest thing this system
 * does: letting a model edit files. The model runs against a copy in the OS temp
 * directory, never the user's working tree, and the copy is deleted afterwards.
 */
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { GitRepo } from '@self-heal/core/git/repo';

/** Repository-relative POSIX path → file contents. */
export type FileMap = Readonly<Record<string, string>>;

export interface SandboxOptions {
  readonly files: FileMap;
  /** Prefix for the temp directory, to make stray dirs identifiable. */
  readonly prefix?: string;
  /** Message for the baseline commit every sandbox starts from. */
  readonly baselineMessage?: string;
}

export class Sandbox {
  readonly dir: string;
  readonly git: GitRepo;
  /** The commit every measurement and diff is taken against. */
  readonly baseline: string;

  private constructor(dir: string, git: GitRepo, baseline: string) {
    this.dir = dir;
    this.git = git;
    this.baseline = baseline;
  }

  static async create(options: SandboxOptions): Promise<Sandbox> {
    const dir = await mkdtemp(join(tmpdir(), options.prefix ?? 'self-heal-'));
    await writeFiles(dir, options.files);

    const git = new GitRepo({ dir });
    await git.init();
    const baseline = await git.checkpoint(options.baselineMessage ?? 'baseline');
    if (baseline === null) {
      await rm(dir, { recursive: true, force: true });
      throw new Error(`failed to create baseline commit in sandbox: ${dir}`);
    }

    return new Sandbox(dir, git, baseline);
  }

  path(relative: string): string {
    return join(this.dir, relative);
  }

  async read(relative: string): Promise<string> {
    return readFile(this.path(relative), 'utf8');
  }

  async write(relative: string, contents: string): Promise<void> {
    await writeFiles(this.dir, { [relative]: contents });
  }

  /** Undo everything since the baseline — the same operation the loop's revert uses. */
  async reset(): Promise<boolean> {
    return this.git.restore(this.baseline);
  }

  async dispose(): Promise<void> {
    // Never let cleanup failure fail a test or a run; a leaked temp dir is a
    // nuisance, a thrown error in a `finally` block hides the real problem.
    await rm(this.dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function writeFiles(root: string, files: FileMap): Promise<void> {
  for (const [relative, contents] of Object.entries(files)) {
    const target = join(root, relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, 'utf8');
  }
}
