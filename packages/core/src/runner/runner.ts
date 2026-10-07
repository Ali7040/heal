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
import type { Diagnosis, PriorAttempt } from '../contracts/diagnosis.js';
import type { AttemptRecord, EscalationReport } from '../contracts/escalation.js';
import { ESCALATION_DIFF_LIMIT } from '../contracts/escalation.js';
import { PRIOR_ATTEMPT_TEXT_LIMIT } from '../contracts/diagnosis.js';
import type { Fixer } from '../contracts/fixer.js';
import type { Issue } from '../contracts/issue.js';
import type { JournalPort } from '../contracts/journal.js';
import { NullJournal } from '../contracts/journal.js';
import type { Patch } from '../contracts/patch.js';
import type { GitRepo } from '../git/repo.js';
import { checkPatch } from '../safety/allowlist.js';
import { applyPatch } from '../safety/apply.js';
import { staleEdits, stampBases } from '../safety/base.js';
import { CircuitBreaker } from '../safety/circuit-breaker.js';
import { canTransition, type RunState } from './state.js';

export interface RunnerOptions {
  readonly detectors: readonly Detector[];
  readonly fixer: Fixer;
  readonly repo: GitRepo;
  readonly ctx: RunContext;
  /** Globs a patch may touch. Anything else is rejected before it is written. */
  readonly allowlist: readonly string[];
  /**
   * Globs no patch may touch, whatever the allowlist says — tests, the config.
   * Joined by `ALWAYS_PROTECTED` and every detector's own `protectedPaths()`.
   */
  readonly protectedPaths?: readonly string[];
  readonly diagnose: (issue: Issue, ctx: RunContext) => Promise<Diagnosis>;
  readonly journal?: JournalPort;
  readonly attemptCap?: number;
  readonly failureThreshold?: number;
  /**
   * After a fix passes its own detector, re-run every detector and revert if a
   * check that was passing now fails (D-025). Default on; off trades that
   * guarantee for one less full detection per heal.
   */
  readonly collateralCheck?: boolean;
  /**
   * How many times a failure must re-run and fail again before anything is spent
   * on it — and before a newly failing check counts against a fix (D-030).
   * Default 1; 0 trusts the first measurement.
   */
  readonly confirmFailures?: number;
  /** Proceed even though the working tree has uncommitted changes (invariant 5). */
  readonly allowDirty?: boolean;
  /**
   * Called when an issue is handed to a human, with everything the loop learned
   * about it (D-028). A failure here is logged, never fatal: the report is a
   * courtesy, the escalation is the outcome.
   */
  readonly onEscalate?: (report: EscalationReport) => void | Promise<void>;
  /** Called on every state change — the loop's timeline, used by logs and the demo. */
  readonly onTransition?: (event: TransitionEvent) => void;
}

/**
 * The loop's own state: baselines, recorded contracts, the journal, evidence.
 * Protected unconditionally, so no config can hand a patch the measurement.
 */
export const ALWAYS_PROTECTED: readonly string[] = ['.self-heal/**'];

export interface TransitionEvent {
  readonly from: RunState;
  readonly to: RunState;
  readonly signature?: string;
  readonly detail?: Record<string, unknown>;
}

export interface IssueOutcome {
  readonly issue: Issue;
  readonly state: 'HEALED' | 'RESOLVED' | 'FLAKY' | 'REVERTED' | 'ESCALATED' | 'PROPOSED';
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
  readonly #protected: readonly string[];
  readonly #confirmFailures: number;
  /** Set once a patch lands; from then on, later issues may already be gone. */
  #treeChanged = false;
  /**
   * Checks known to be failing right now, by `checkKey`. Starts as everything
   * detected; shrinks as issues heal. A fix may leave these failing — they are
   * someone else's issue — but must not add to them.
   */
  readonly #failing = new Set<string>();
  /** The diff of the attempt `#attempt` last restored away, for the escalation report. */
  #lastDiff: string | undefined;
  #state: RunState = 'IDLE';

  constructor(options: RunnerOptions) {
    this.#options = options;
    this.#journal = options.journal ?? new NullJournal();
    this.#protected = [
      ...ALWAYS_PROTECTED,
      ...(options.protectedPaths ?? []),
      ...options.detectors.flatMap((detector) => detector.protectedPaths?.() ?? []),
    ];
    this.#confirmFailures = Math.max(0, Math.floor(options.confirmFailures ?? 1));
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
    for (const issue of issues) this.#failing.add(checkKey(issue));

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

    // Re-measure before paying for anything. Two different questions, one check:
    //   - after a fix has landed, is this one already gone? (D-022) Once is enough.
    //   - before anything has landed, does the failure even reproduce? A check that
    //     fails then passes is flaky, and a patch would be "verified" by luck (D-030).
    const confirmations = this.#treeChanged ? 1 : this.#confirmFailures;
    if (await this.#passesWithin(detector, issue, confirmations)) {
      this.#failing.delete(checkKey(issue));
      if (this.#treeChanged) {
        const reason = 'already healthy: resolved by an earlier fix in this run';
        this.#to('RESOLVED', issue.signature, { reason });
        return { issue, state: 'RESOLVED', attempts: 0, reason, replayed: false };
      }
      const reason = 'failed once, then passed unchanged: a flaky check, not sent to a model';
      ctx.log.warn('flaky check', { signature: issue.signature, detector: detector.id });
      this.#to('FLAKY', issue.signature, { reason });
      return { issue, state: 'FLAKY', attempts: 0, reason, replayed: false };
    }

    // What already failed for this issue, fed to the next proposal so a retry is
    // a different guess rather than the same prompt paid for twice (D-018).
    const failures: PriorAttempt[] = [];
    // The same story at full resolution, for the person who takes over (D-028).
    const history: AttemptRecord[] = [];
    let lastDiagnosis: Diagnosis | undefined;
    const remember = (patch: Patch, reason: string, replayed: boolean) =>
      history.push(attemptRecord(history.length + 1, patch, reason, replayed, this.#lastDiff));

    // Free path first: a previously verified patch for this exact signature is
    // replayed without involving a fixer at all (D-006). Costs nothing.
    const remembered = await this.#journal.lookup(issue.signature);
    // A remembered patch is whole-file contents, so it fits only the files it was
    // made against. Replayed onto anything newer it would revert every change
    // since — often unmeasured by this detector, so verify could not catch it (D-020).
    const stale =
      remembered?.verified === true ? await staleEdits(remembered.patch, ctx.repoRoot, { requireBase: true }) : [];
    if (stale.length > 0) {
      ctx.log.info('remembered fix skipped: files changed since it was made', {
        signature: issue.signature,
        files: stale,
      });
    }
    if (remembered?.verified === true && remembered.patch.edits.length > 0 && stale.length === 0) {
      this.#to('REPLAY', issue.signature);
      const replayed = await this.#attempt(issue, detector, remembered.patch, true);
      if (replayed.state === 'HEALED') return replayed;
      failures.push(priorAttempt(remembered.patch, `previously verified fix no longer works: ${replayed.reason}`));
      remember(remembered.patch, replayed.reason, true);
      ctx.log.warn('replay failed, falling back to a fresh proposal', { signature: issue.signature });
    }

    let lastReason = 'no attempt was made';
    let lastPatch: Patch | undefined;

    // Invariant 3: the cap, not the loop, decides when to stop trying.
    while (this.#breaker.mayAttempt(issue.signature)) {
      this.#to('DIAGNOSING', issue.signature);
      const built = await this.#options.diagnose(issue, ctx);
      const diagnosis: Diagnosis = failures.length > 0 ? { ...built, priorAttempts: [...failures] } : built;
      lastDiagnosis = diagnosis;
      ctx.log.debug('diagnosis built', {
        signature: issue.signature,
        slices: diagnosis.slices.length,
        editable: diagnosis.editableFiles.length,
        priorAttempts: failures.length,
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
          return this.#escalate(issue, 'could not create a git checkpoint; refusing to mutate', lastPatch, {
            diagnosis,
            attempts: history,
          });
        }
      }

      this.#to('PROPOSING', issue.signature);
      // Stamped from the real tree, which is exactly what the fixer's sandbox was
      // copied from — so a later replay can prove it still fits (D-020).
      const patch = await stampBases(await this.#options.fixer.propose(diagnosis), ctx.repoRoot);
      lastPatch = patch;

      // Stop before APPLYING. Nothing has been written and nothing committed, so
      // there is nothing to undo.
      if (ctx.dryRun) {
        return {
          issue,
          state: 'PROPOSED',
          attempts: 0,
          patch,
          reason: dryRunReason(patch, this.#options.allowlist, this.#protected),
          replayed: false,
        };
      }

      const attempted = await this.#attempt(issue, detector, patch, false, checkpoint ?? undefined);
      if (attempted.state === 'HEALED') return attempted;
      lastReason = attempted.reason;
      failures.push(priorAttempt(patch, attempted.reason));
      remember(patch, attempted.reason, false);
    }

    return this.#escalate(issue, `attempt cap reached (${this.#breaker.attemptCap}); last: ${lastReason}`, lastPatch, {
      ...(lastDiagnosis !== undefined ? { diagnosis: lastDiagnosis } : {}),
      attempts: history,
    });
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
    this.#lastDiff = undefined;

    const restorePoint = checkpoint ?? (await repo.currentCommit());
    if (restorePoint === null) {
      return this.#escalate(issue, 'no commit to roll back to; refusing to mutate', patch);
    }

    this.#to('APPLYING', issue.signature, { edits: patch.edits.length, replayed });
    const applied = await applyPatch(patch, {
      repoRoot: ctx.repoRoot,
      allowlist: this.#options.allowlist,
      protectedPaths: this.#protected,
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
      this.#lastDiff = await attemptDiff(repo);
      await repo.restore(restorePoint);
      this.#breaker.recordFailure();
      const reason = 'verification failed; tree restored';
      this.#to('REVERTED', issue.signature, { reason });
      await this.#journal.record({ signature: issue.signature, kind: issue.kind, patch, verified: false, attempts, replayed });
      return { issue, state: 'REVERTED', attempts, patch, reason, replayed };
    }

    // Its own check passes. That proves the fix fixed *this*; it does not prove the
    // fix broke nothing else — a patch can make one test pass by breaking another.
    // Still part of verification: HEALED requires both (D-025).
    const broke = this.#options.collateralCheck === false ? [] : await this.#collateral(issue);
    if (broke.length > 0) {
      this.#lastDiff = await attemptDiff(repo);
      await repo.restore(restorePoint);
      this.#breaker.recordFailure();
      const reason = `fixed its own check but broke ${broke.join(', ')}; tree restored`;
      this.#to('REVERTED', issue.signature, { reason, broke });
      await this.#journal.record({ signature: issue.signature, kind: issue.kind, patch, verified: false, attempts, replayed });
      return { issue, state: 'REVERTED', attempts, patch, reason, replayed };
    }

    this.#breaker.recordSuccess();
    this.#treeChanged = true;
    this.#failing.delete(checkKey(issue));

    // One commit per verified fix, named for what it fixed. The history then reads
    // as a list of repairs, each revertible on its own, and the tree is clean for
    // the next issue's checkpoint (D-023). A failed commit does not undo a
    // measured heal; the next checkpoint will carry it.
    const committed = await repo.commitAll(healCommitMessage(issue, detector, patch, replayed));
    if (committed === null) ctx.log.warn('fix verified but could not be committed', { signature: issue.signature });

    this.#to('HEALED', issue.signature, { replayed });
    await this.#journal.record({ signature: issue.signature, kind: issue.kind, patch, verified: true, attempts, replayed });

    return {
      issue,
      state: 'HEALED',
      attempts,
      patch,
      reason: replayed ? 'replayed a previously verified patch' : 'verified by the originating detector',
      replayed,
    };
  }

  /** True if `verify` passes on any of up to `times` re-runs. Zero re-runs never passes. */
  async #passesWithin(detector: Detector, issue: Issue, times: number): Promise<boolean> {
    for (let run = 0; run < times; run += 1) {
      if (await detector.verify(issue, this.#options.ctx)) return true;
    }
    return false;
  }

  /**
   * Every detector, re-run on the patched tree. Returns the checks failing now
   * that were not failing before — empty means nothing new broke.
   *
   * Compared by `checkKey`, not by signature: a check that was already failing
   * may fail *differently* now (one of its failures fixed, another remaining),
   * which changes its signature without being a new break.
   */
  async #collateral(issue: Issue): Promise<string[]> {
    const { ctx, detectors } = this.#options;
    const own = checkKey(issue);
    const broke: string[] = [];

    for (const detector of detectors) {
      let found: Issue[];
      try {
        found = await detector.detect(ctx);
      } catch (error) {
        // A patch is on disk. A detector that cannot run against it is not
        // evidence of safety, so it counts against the patch.
        broke.push(`${detector.id} (could not run: ${error instanceof Error ? error.message : String(error)})`);
        continue;
      }
      for (const now of found) {
        const key = checkKey(now);
        if (key === own || this.#failing.has(key)) continue;
        // Reverting a good fix over a flaky check is as wrong as keeping a bad one,
        // so a newly failing check must fail again before it counts (D-030).
        if (await this.#passesWithin(detector, now, this.#confirmFailures)) {
          ctx.log.warn('flaky check ignored in collateral', { signature: issue.signature, check: describeCheck(now) });
          continue;
        }
        broke.push(describeCheck(now));
      }
    }

    if (broke.length > 0) ctx.log.warn('fix broke other checks', { signature: issue.signature, broke });
    return [...new Set(broke)];
  }

  async #escalate(
    issue: Issue,
    reason: string,
    patch?: Patch,
    context: { readonly diagnosis?: Diagnosis; readonly attempts?: readonly AttemptRecord[] } = {},
  ): Promise<IssueOutcome> {
    this.#to('ESCALATED', issue.signature, { reason });
    this.#options.ctx.log.warn('escalated', { signature: issue.signature, reason });

    if (this.#options.onEscalate !== undefined) {
      const report: EscalationReport = {
        issue,
        reason,
        ...(context.diagnosis !== undefined ? { diagnosis: context.diagnosis } : {}),
        attempts: context.attempts ?? [],
        escalatedAt: new Date().toISOString(),
      };
      try {
        await this.#options.onEscalate(report);
      } catch (error) {
        this.#options.ctx.log.warn('could not write the escalation report', {
          signature: issue.signature,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

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
    const restarting =
      (from === 'REVERTED' || from === 'HEALED' || from === 'RESOLVED' || from === 'FLAKY' || from === 'ESCALATED') &&
      next === 'TRIAGING';

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

function priorAttempt(patch: Patch, reason: string): PriorAttempt {
  return {
    files: patch.edits.map((edit) => edit.path),
    rationale: clip(patch.rationale),
    reason: clip(reason),
  };
}

function clip(text: string): string {
  return text.length > PRIOR_ATTEMPT_TEXT_LIMIT ? `${text.slice(0, PRIOR_ATTEMPT_TEXT_LIMIT)}…` : text;
}

/** A dry run reports what the gate would say, not just what the fixer wanted. */
function dryRunReason(patch: Patch, allowlist: readonly string[], protectedPaths: readonly string[]): string {
  if (patch.edits.length === 0) return 'dry run: fixer proposed no change';
  const check = checkPatch(patch, allowlist, protectedPaths);
  if (!check.ok) {
    return `dry run: patch would be rejected: ${check.rejected.map((r) => `${r.path} (${r.reason})`).join(', ')}`;
  }
  return `dry run: would edit ${patch.edits.map((e) => e.path).join(', ')}`;
}

function healCommitMessage(issue: Issue, detector: Detector, patch: Patch, replayed: boolean): string {
  const files = patch.edits.map((edit) => edit.path).join(', ');
  return [
    `self-heal: fix ${issue.kind} (${issue.signature.slice(0, 8)})`,
    '',
    patch.rationale,
    '',
    `Files: ${files}`,
    `Verified by re-running detector "${detector.id}".${replayed ? ' Replayed from the journal.' : ''}`,
  ].join('\n');
}

/** Which check an issue is — its detector, kind, and place — regardless of how it fails today. */
function checkKey(issue: Issue): string {
  const { file, line, endpoint, selector } = issue.location;
  return JSON.stringify([issue.detectorId, issue.kind, file ?? null, line ?? null, endpoint ?? null, selector ?? null]);
}

function describeCheck(issue: Issue): string {
  const { file, endpoint, selector } = issue.location;
  const where = endpoint ?? selector ?? file;
  return `${issue.detectorId} (${issue.kind}${where !== undefined ? ` at ${where}` : ''})`;
}

function attemptRecord(
  number: number,
  patch: Patch,
  reason: string,
  replayed: boolean,
  diff: string | undefined,
): AttemptRecord {
  return {
    number,
    replayed,
    files: patch.edits.map((edit) => edit.path),
    rationale: patch.rationale,
    reason,
    ...(diff !== undefined && diff !== '' ? { diff } : {}),
  };
}

/**
 * The applied attempt as git sees it, taken just before the restore wipes it.
 * New files are marked intent-to-add so `diff HEAD` shows them too; the restore's
 * `reset --hard` clears that again.
 */
async function attemptDiff(repo: GitRepo): Promise<string> {
  await repo.git('add', '--intent-to-add', '--all');
  const diff = await repo.diff();
  return diff.length > ESCALATION_DIFF_LIMIT
    ? `${diff.slice(0, ESCALATION_DIFF_LIMIT)}\n… diff truncated at ${ESCALATION_DIFF_LIMIT} characters`
    : diff;
}
