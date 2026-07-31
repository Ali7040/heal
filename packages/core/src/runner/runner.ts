/**
 * The loop.
 *
 * This file owns the state machine and nothing else. It cannot see pixels,
 * schemas, HTTP, or a model — it only knows the contracts, so any detector or
 * fixer plugs into it unchanged (ARCHITECTURE.md §1).
 *
 * Read the invariants as *ordering* constraints, because that is what they are:
 *
 *   checkpoint  BEFORE  apply          (1)  — mutation is always recoverable
 *   allowlist   BEFORE  apply          (4)  — nothing illegal is ever written
 *   verify      BEFORE  HEALED         (2)  — success is measured, not claimed
 *   dirty-tree  BEFORE  anything       (5)  — never touch unsaved human work
 *
 * Failure is a transition, not an exception. Every predictable thing that can go
 * wrong — a fixer proposing nothing, a patch outside the allowlist, a verify that
 * still fails, a harness that is not installed — moves the machine to `REVERTED`
 * or `ESCALATED` and the run continues. `throw` is reserved for programmer error.
 */
import type { RunContext } from '../contracts/context.js';
import type { Detector } from '../contracts/detector.js';
import type { Diagnosis } from '../contracts/diagnosis.js';
import type { Fixer } from '../contracts/fixer.js';
import type { Issue } from '../contracts/issue.js';
import type { JournalPort } from '../contracts/journal.js';
import { NullJournal } from '../contracts/journal.js';
import type { Patch } from '../contracts/patch.js';
import type { GitRepo } from '../git/repo.js';
import { applyPatch } from '../safety/apply.js';
import { CircuitBreaker } from '../safety/circuit-breaker.js';
import { canTransition, type RunState } from './state.js';

export interface RunnerOptions {
  readonly detectors: readonly Detector[];
  readonly fixer: Fixer;
  readonly repo: GitRepo;
  readonly ctx: RunContext;
  /** Globs a patch may touch. Anything else is rejected before it is written. */
  readonly allowlist: readonly string[];
  readonly diagnose: (issue: Issue, ctx: RunContext) => Promise<Diagnosis>;
  readonly journal?: JournalPort;
  readonly attemptCap?: number;
  readonly failureThreshold?: number;
  /** Proceed even though the working tree has uncommitted changes (invariant 5). */
  readonly allowDirty?: boolean;
  /** Called on every state change — the loop's timeline, used by logs and the demo. */
  readonly onTransition?: (event: TransitionEvent) => void;
}

export interface TransitionEvent {
  readonly from: RunState;
  readonly to: RunState;
  readonly signature?: string;
  readonly detail?: Record<string, unknown>;
}

export interface IssueOutcome {
  readonly issue: Issue;
  readonly state: 'HEALED' | 'REVERTED' | 'ESCALATED' | 'PROPOSED';
  readonly attempts: number;
  /** Present when a patch was produced, applied or not. */
  readonly patch?: Patch;
  /** Why it ended where it did — one line, for humans. */
  readonly reason: string;
  /** True when a journal hit avoided calling the fixer entirely. */
  readonly replayed: boolean;
}

export interface RunReport {
  readonly issues: number;
  readonly outcomes: readonly IssueOutcome[];
  readonly halted: boolean;
  readonly haltReason?: string;
  readonly dryRun: boolean;
  readonly durationMs: number;
}

export class Runner {
  readonly #options: RunnerOptions;
  readonly #journal: JournalPort;
  readonly #breaker: CircuitBreaker;
  #state: RunState = 'IDLE';

  constructor(options: RunnerOptions) {
    this.#options = options;
    this.#journal = options.journal ?? new NullJournal();
    this.#breaker = new CircuitBreaker({
      ...(options.attemptCap !== undefined ? { attemptCap: options.attemptCap } : {}),
      ...(options.failureThreshold !== undefined ? { failureThreshold: options.failureThreshold } : {}),
    });
  }

  get state(): RunState {
    return this.#state;
  }

  async run(): Promise<RunReport> {
    const startedAt = Date.now();
    const { ctx, repo, detectors } = this.#options;
    const outcomes: IssueOutcome[] = [];

    // Invariant 5, checked once, before anything else. Uncommitted work means we
    // cannot promise a clean rollback, so we do not start.
    if (this.#options.allowDirty !== true && !this.#options.ctx.dryRun) {
      if (!(await repo.isClean())) {
        return this.#halted(
          startedAt,
          outcomes,
          'working tree is dirty — commit or stash first, or pass --allow-dirty',
        );
      }
    }

    this.#to('DETECTING');
    const issues: Issue[] = [];
    for (const detector of detectors) {
      const found = await detector.detect(ctx);
      ctx.log.info('detector finished', { detector: detector.id, issues: found.length });
      issues.push(...found);
    }

    if (issues.length === 0) {
      this.#to('IDLE', undefined, { issues: 0 });
      return {
        issues: 0,
        outcomes,
        halted: false,
        dryRun: ctx.dryRun,
        durationMs: Date.now() - startedAt,
      };
    }

    for (const issue of issues) {
      // Invariant 6. One broken detector must not spend a budget or thrash a repo.
      if (this.#breaker.isTripped) {
        return this.#halted(
          startedAt,
          outcomes,
          `circuit breaker tripped after ${this.#breaker.consecutiveFailures} consecutive failures`,
        );
      }
      outcomes.push(await this.#handleIssue(issue));
    }

    return {
      issues: issues.length,
      outcomes,
      halted: false,
      dryRun: ctx.dryRun,
      durationMs: Date.now() - startedAt,
    };
  }

  async #handleIssue(issue: Issue): Promise<IssueOutcome> {
    const { ctx } = this.#options;
    const detector = this.#detectorFor(issue);

    // A detector that produced an issue but is not registered is a wiring bug,
    // not a runtime condition — nothing could verify a fix for it (invariant 2).
    if (detector === undefined) {
      throw new Error(`no registered detector with id "${issue.detectorId}" to verify its own issue`);
    }

    this.#to('TRIAGING', issue.signature);

    // Free path first: a previously verified patch for this exact signature is
    // replayed without involving a fixer at all (D-006). Costs nothing.
    const remembered = await this.#journal.lookup(issue.signature);
    if (remembered?.verified === true && remembered.patch.edits.length > 0) {
      this.#to('REPLAY', issue.signature);
      const replayed = await this.#attempt(issue, detector, remembered.patch, true);
      if (replayed.state === 'HEALED') return replayed;
      ctx.log.warn('replay failed, falling back to a fresh proposal', { signature: issue.signature });
    }

    let lastReason = 'no attempt was made';
    let lastPatch: Patch | undefined;

    // Invariant 3: the cap, not the loop, decides when to stop trying.
    while (this.#breaker.mayAttempt(issue.signature)) {
      this.#to('DIAGNOSING', issue.signature);
      const diagnosis = await this.#options.diagnose(issue, ctx);
      ctx.log.debug('diagnosis built', {
        signature: issue.signature,
        slices: diagnosis.slices.length,
        editable: diagnosis.editableFiles.length,
      });

      if (!ctx.dryRun) this.#breaker.recordAttempt(issue.signature);

      // Invariant 1. The checkpoint precedes the proposal, so even a fixer that
      // mutates the tree as a side effect is recoverable.
      //
      // A dry run walks this same edge but creates no commit: a checkpoint is
      // itself a mutation, and a mode whose promise is "I changed nothing" cannot
      // leave a commit behind. Taking the same path rather than branching around
      // it is what keeps `--dry-run` a real code path instead of a flag checked
      // at the end (invariant 7).
      this.#to('CHECKPOINTING', issue.signature, { skipped: ctx.dryRun });
      let checkpoint: string | null = null;
      if (!ctx.dryRun) {
        checkpoint = await this.#options.repo.checkpoint(
          `self-heal: checkpoint before ${issue.kind} (${issue.signature.slice(0, 8)})`,
        );
        if (checkpoint === null) {
          this.#breaker.recordFailure();
          return this.#escalate(issue, 'could not create a git checkpoint; refusing to mutate', lastPatch);
        }
      }

      this.#to('PROPOSING', issue.signature);
      const patch = await this.#options.fixer.propose(diagnosis);
      lastPatch = patch;

      // Stop before APPLYING. Nothing has been written and nothing committed, so
      // there is nothing to undo.
      if (ctx.dryRun) {
        return {
          issue,
          state: 'PROPOSED',
          attempts: 0,
          patch,
          reason:
            patch.edits.length === 0
              ? 'dry run: fixer proposed no change'
              : `dry run: would edit ${patch.edits.map((e) => e.path).join(', ')}`,
          replayed: false,
        };
      }

      const attempted = await this.#attempt(issue, detector, patch, false, checkpoint ?? undefined);
      if (attempted.state === 'HEALED') return attempted;
      lastReason = attempted.reason;
    }

    return this.#escalate(issue, `attempt cap reached (${this.#breaker.attemptCap}); last: ${lastReason}`, lastPatch);
  }

  /** Apply → verify → record. Shared by a fresh proposal and a journal replay. */
  async #attempt(
    issue: Issue,
    detector: Detector,
    patch: Patch,
    replayed: boolean,
    checkpoint?: string,
  ): Promise<IssueOutcome> {
    const { ctx, repo } = this.#options;
    const attempts = this.#breaker.attemptsFor(issue.signature);

    const restorePoint = checkpoint ?? (await repo.currentCommit());
    if (restorePoint === null) {
      return this.#escalate(issue, 'no commit to roll back to; refusing to mutate', patch);
    }

    this.#to('APPLYING', issue.signature, { edits: patch.edits.length, replayed });
    const applied = await applyPatch(patch, {
      repoRoot: ctx.repoRoot,
      allowlist: this.#options.allowlist,
      checkpoint: restorePoint,
    });

    if (!applied.applied) {
      const reason =
        applied.reason === 'rejected'
          ? `patch rejected: ${applied.rejected.map((r) => `${r.path} (${r.reason})`).join(', ')}`
          : applied.reason === 'empty'
            ? 'fixer proposed no change'
            : `write failed: ${applied.error}`;

      ctx.log.warn('patch not applied', { signature: issue.signature, reason });
      await repo.restore(restorePoint);
      this.#breaker.recordFailure();
      this.#to('REVERTED', issue.signature, { reason });
      return { issue, state: 'REVERTED', attempts, patch, reason, replayed };
    }

    // Invariant 2. The detector that found it decides whether it is gone —
    // and nothing else in this file can produce HEALED.
    this.#to('VERIFYING', issue.signature, { files: applied.files.length });
    const verified = await detector.verify(issue, ctx);

    if (!verified) {
      await repo.restore(restorePoint);
      this.#breaker.recordFailure();
      const reason = 'verification failed; tree restored';
      this.#to('REVERTED', issue.signature, { reason });
      await this.#journal.record({ signature: issue.signature, kind: issue.kind, patch, verified: false, attempts });
      return { issue, state: 'REVERTED', attempts, patch, reason, replayed };
    }

    this.#breaker.recordSuccess();
    this.#to('HEALED', issue.signature, { replayed });
    await this.#journal.record({ signature: issue.signature, kind: issue.kind, patch, verified: true, attempts });

    return {
      issue,
      state: 'HEALED',
      attempts,
      patch,
      reason: replayed ? 'replayed a previously verified patch' : 'verified by the originating detector',
      replayed,
    };
  }

  #escalate(issue: Issue, reason: string, patch?: Patch): IssueOutcome {
    this.#to('ESCALATED', issue.signature, { reason });
    this.#options.ctx.log.warn('escalated', { signature: issue.signature, reason });
    return {
      issue,
      state: 'ESCALATED',
      attempts: this.#breaker.attemptsFor(issue.signature),
      ...(patch !== undefined ? { patch } : {}),
      reason,
      replayed: false,
    };
  }

  #detectorFor(issue: Issue): Detector | undefined {
    return this.#options.detectors.find((detector) => detector.id === issue.detectorId);
  }

  /**
   * Every state change goes through here, and an illegal one throws.
   *
   * That is deliberate: an impossible transition means the machine's logic is
   * wrong, which is a programmer error, not a runtime condition. It fails loudly
   * in tests instead of quietly reaching `HEALED` by an unintended route.
   */
  #to(next: RunState, signature?: string, detail?: Record<string, unknown>): void {
    const from = this.#state;

    // Re-entering the loop for a retry, or moving to the next issue, resets the
    // per-issue path; the graph describes one attempt, not the whole run.
    const restarting = (from === 'REVERTED' || from === 'HEALED' || from === 'ESCALATED') && next === 'TRIAGING';

    if (!restarting && !canTransition(from, next)) {
      throw new Error(`illegal transition ${from} → ${next}`);
    }

    this.#state = next;
    this.#options.onTransition?.({
      from,
      to: next,
      ...(signature !== undefined ? { signature } : {}),
      ...(detail !== undefined ? { detail } : {}),
    });
  }

  #halted(startedAt: number, outcomes: IssueOutcome[], reason: string): RunReport {
    this.#options.ctx.log.error('run halted', { reason });
    return {
      issues: outcomes.length,
      outcomes,
      halted: true,
      haltReason: reason,
      dryRun: this.#options.ctx.dryRun,
      durationMs: Date.now() - startedAt,
    };
  }
}
