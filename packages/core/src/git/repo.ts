/**
 * The one git wrapper in the system.
 *
 * Three very different consumers need git, and they must all get identical
 * behaviour or the safety invariants become unevenly enforced:
 *
 *   - Safety      — checkpoint before mutation (invariant 1), refuse a dirty
 *                   tree (invariant 5), restore after a failed verify.
 *   - Fixers      — read back what the harness changed, as a measurement rather
 *                   than as a claim.
 *   - Test tooling — build and tear down disposable repositories.
 *
 * Every method returns data, never throws for an ordinary git failure. The state
 * machine treats "git said no" as a transition, not as a crash.
 *
 * Note the `-c user.*` flags on commit: the checkpoint must succeed on a machine
 * with no global git identity (CI, a fresh container), and it must never mutate
 * the user's config to get there.
 */
import { runCommand, type CommandResult } from '../process.js';

export interface GitRepoOptions {
  readonly dir: string;
  readonly timeoutMs?: number;
  /** Identity used only for checkpoint commits this tool creates. */
  readonly authorName?: string;
  readonly authorEmail?: string;
}

export interface FileChange {
  readonly path: string;
  readonly status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';
}

export class GitRepo {
  readonly dir: string;
  readonly #timeoutMs: number;
  readonly #authorName: string;
  readonly #authorEmail: string;

  constructor(options: GitRepoOptions) {
    this.dir = options.dir;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#authorName = options.authorName ?? 'self-heal';
    this.#authorEmail = options.authorEmail ?? 'self-heal@localhost';
  }

  async git(...args: readonly string[]): Promise<CommandResult> {
    return runCommand('git', args, { cwd: this.dir, timeoutMs: this.#timeoutMs });
  }

  async isRepo(): Promise<boolean> {
    const result = await this.git('rev-parse', '--git-dir');
    return result.ok;
  }

  async init(): Promise<boolean> {
    return (await this.git('init', '-q')).ok;
  }

  /**
   * Invariant 5. `--porcelain` is the machine-readable form whose output format
   * git guarantees across versions — parsing human-facing `git status` would be
   * a silent breakage waiting for a version bump.
   */
  async isClean(): Promise<boolean> {
    const result = await this.git('status', '--porcelain');
    return result.ok && result.stdout.trim() === '';
  }

  async changes(): Promise<FileChange[]> {
    const result = await this.git('status', '--porcelain=v1');
    if (!result.ok) return [];

    return result.stdout
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => {
        const code = line.slice(0, 2);
        // Porcelain quotes paths containing spaces or non-ASCII bytes.
        const path = line.slice(3).trim().replace(/^"|"$/g, '');
        return { path, status: statusFromCode(code) };
      });
  }

  async diff(): Promise<string> {
    // HEAD (not the index) so staged and unstaged edits both appear — a harness
    // that stages its own work must not be able to hide a change from us.
    const result = await this.git('diff', 'HEAD');
    return result.ok ? result.stdout : '';
  }

  async currentCommit(): Promise<string | null> {
    const result = await this.git('rev-parse', 'HEAD');
    return result.ok ? result.stdout.trim() : null;
  }

  /**
   * Invariant 1. Returns the commit SHA to roll back to, or `null` if the
   * checkpoint could not be created — in which case the caller must not mutate
   * anything.
   */
  async checkpoint(message: string): Promise<string | null> {
    const staged = await this.git('add', '-A');
    if (!staged.ok) return null;

    const committed = await this.git(
      '-c',
      `user.name=${this.#authorName}`,
      '-c',
      `user.email=${this.#authorEmail}`,
      'commit',
      '--allow-empty',
      '-q',
      '-m',
      message,
    );
    if (!committed.ok) return null;

    return this.currentCommit();
  }

  /**
   * Roll the tree back to a checkpoint. `reset --hard` drops tracked edits;
   * `clean -fd` removes files the harness created, which a reset alone leaves
   * behind. Both are needed for "reverted" to mean the tree is actually
   * indistinguishable from before the attempt.
   */
  async restore(commit: string): Promise<boolean> {
    const reset = await this.git('reset', '--hard', commit);
    if (!reset.ok) return false;
    return (await this.git('clean', '-fd')).ok;
  }

  async readFileAtHead(path: string): Promise<string | null> {
    const result = await this.git('show', `HEAD:${path}`);
    return result.ok ? result.stdout : null;
  }
}

function statusFromCode(code: string): FileChange['status'] {
  if (code === '??') return 'untracked';
  if (code.includes('D')) return 'deleted';
  if (code.includes('R')) return 'renamed';
  if (code.includes('A')) return 'added';
  return 'modified';
}
