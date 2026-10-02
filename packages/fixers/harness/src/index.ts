/**
 * The `Fixer` implementation that drives a real agent harness.
 *
 * The sequence is fixed, and every step exists to keep the model boxed in:
 *
 *   1. Copy the relevant files into a disposable sandbox repository.
 *   2. Run the harness there, with a tool grant that excludes shell access.
 *   3. Read the resulting change out of git — not out of the model's reply.
 *   4. Destroy the sandbox and hand back an untrusted `Patch`.
 *
 * The model never sees, and cannot reach, the user's working tree. Whatever it
 * does inside the sandbox is bounded by the sandbox's lifetime, and the only
 * thing that escapes is a data structure the safety layer gets to reject.
 *
 * Nothing in this file decides whether the fix is correct. That question belongs
 * to the originating detector's re-run, later, in the runner (D-002).
 */
import type { Diagnosis } from '@self-heal/core/contracts/diagnosis';
import type { Fixer } from '@self-heal/core/contracts/fixer';
import type { Patch } from '@self-heal/core/contracts/patch';
import { GitRepo } from '@self-heal/core/git/repo';

import { capturePatch } from './capture.js';
import { invokeHarness, DEFAULT_HARNESS_TIMEOUT_MS } from './invoke.js';
import { getProfile, type HarnessProfile } from './profiles.js';

export { capturePatch } from './capture.js';
export { invokeHarness, DEFAULT_HARNESS_TIMEOUT_MS } from './invoke.js';
export { getProfile, HARNESS_PROFILES, DEFAULT_ALLOW_TOOLS, DEFAULT_DENY_TOOLS } from './profiles.js';
export { createGitWorkspace, WorkspaceError, DEFAULT_MAX_FILE_BYTES } from './workspace.js';

export interface HarnessFixerOptions {
  /** Profile id (`claude-code`) or a fully custom profile from user config. */
  readonly harness: string | HarnessProfile;
  readonly timeoutMs?: number;
  /**
   * Builds the sandbox the harness runs in. Injected rather than imported so
   * `core` and this package never depend on test tooling, and so a caller can
   * choose between a temp-dir copy and a git worktree without touching this file.
   */
  readonly createWorkspace: (diagnosis: Diagnosis) => Promise<HarnessWorkspace>;
  /**
   * Called once per harness run with what it cost. Observation only — nothing it
   * reports feeds a decision (D-001). This is how a benchmark, or a cost report,
   * learns what a proposal was worth paying for (D-026).
   */
  readonly onInvoke?: (record: InvocationRecord) => void;
}

/** One harness run, as measured from outside it. */
export interface InvocationRecord {
  readonly signature: string;
  readonly ok: boolean;
  readonly failure: string | null;
  readonly durationMs: number;
  /** As the harness reported it; `null` when the harness does not say. */
  readonly costUsd: number | null;
  readonly turns: number | null;
  /** Bytes of prompt sent — the part of the cost this project controls. */
  readonly promptBytes: number;
}

export interface HarnessWorkspace {
  readonly dir: string;
  dispose(): Promise<void>;
}

export class HarnessFixer implements Fixer {
  readonly id = 'harness';

  readonly #profile: HarnessProfile;
  readonly #timeoutMs: number;
  readonly #createWorkspace: (diagnosis: Diagnosis) => Promise<HarnessWorkspace>;
  readonly #onInvoke: ((record: InvocationRecord) => void) | undefined;

  constructor(options: HarnessFixerOptions) {
    this.#profile = typeof options.harness === 'string' ? getProfile(options.harness) : options.harness;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_HARNESS_TIMEOUT_MS;
    this.#createWorkspace = options.createWorkspace;
    this.#onInvoke = options.onInvoke;
  }

  async propose(diagnosis: Diagnosis): Promise<Patch> {
    const workspace = await this.#createWorkspace(diagnosis);

    try {
      const prompt = buildPrompt(diagnosis);
      const result = await invokeHarness({
        profile: this.#profile,
        prompt,
        cwd: workspace.dir,
        timeoutMs: this.#timeoutMs,
      });
      this.#onInvoke?.({
        signature: diagnosis.issue.signature,
        ok: result.ok,
        failure: result.failure,
        durationMs: result.durationMs,
        costUsd: result.summary?.costUsd ?? null,
        turns: result.summary?.turns ?? null,
        promptBytes: Buffer.byteLength(prompt, 'utf8'),
      });

      // A failed invocation yields an empty patch, never a throw. The runner
      // treats "no proposal" as a transition it already knows how to handle.
      if (!result.ok) {
        return emptyPatch(this.id, diagnosis, `harness ${result.failure}`);
      }

      const captured = await capturePatch({
        repo: new GitRepo({ dir: workspace.dir }),
        fixerId: this.id,
        signature: diagnosis.issue.signature,
        rationale: firstLine(result.summary?.text) ?? 'harness proposed a change',
      });

      return captured.patch;
    } finally {
      await workspace.dispose();
    }
  }
}

/**
 * The prompt is built from the diagnosis and nothing else.
 *
 * It carries the measured expectation, the measured actual, and the bounded code
 * slices — never whole files, and never the evidence blobs those slices came
 * from. The instruction not to touch tests matters: a model asked to make a
 * check pass can always delete the check, and that would be indistinguishable
 * from a fix to anything downstream.
 */
export function buildPrompt(diagnosis: Diagnosis): string {
  const { issue } = diagnosis;
  const slices = diagnosis.slices
    .map((slice) => {
      const symbol = slice.symbol !== undefined ? ` (${slice.symbol})` : '';
      return `--- ${slice.path}:${slice.startLine}-${slice.endLine}${symbol}\n${slice.source}`;
    })
    .join('\n\n');

  return [
    `A deterministic check detected a ${issue.kind}.`,
    '',
    `Location: ${formatLocation(issue)}`,
    // Named even when the budget left their slice out, so the model can read them.
    ...(issue.related !== undefined && issue.related.length > 0
      ? [`Reported at: ${issue.related.map((r) => `${r.file ?? '?'}${r.line !== undefined ? `:${r.line}` : ''}`).join(', ')}`]
      : []),
    `Expected: ${JSON.stringify(issue.expected)}`,
    `Actual:   ${JSON.stringify(issue.actual)}`,
    '',
    'Relevant code:',
    slices,
    ...priorAttemptLines(diagnosis),
    '',
    `Edit only these files: ${diagnosis.editableFiles.join(', ')}`,
    'Fix the underlying cause. Do not modify tests or checks.',
    'Do not create new files. Do not run git.',
  ].join('\n');
}

/**
 * Earlier failed attempts, stated as measurements. Without this a retry is the
 * identical prompt at the identical price, and tends to earn the identical patch.
 */
function priorAttemptLines(diagnosis: Diagnosis): string[] {
  const prior = diagnosis.priorAttempts ?? [];
  if (prior.length === 0) return [];

  return [
    '',
    'Earlier attempts at this issue were measured and FAILED. Do not repeat them;',
    'take a different approach:',
    ...prior.map((attempt, index) => {
      const files = attempt.files.length > 0 ? attempt.files.join(', ') : 'no files';
      return `${index + 1}. Edited ${files} ("${attempt.rationale}") — ${attempt.reason}`;
    }),
  ];
}

function formatLocation(issue: Diagnosis['issue']): string {
  const { file, line, endpoint, selector } = issue.location;
  return endpoint ?? selector ?? (file !== undefined ? `${file}${line !== undefined ? `:${line}` : ''}` : 'unknown');
}

function firstLine(text: string | undefined): string | undefined {
  return text?.split('\n').find((line) => line.trim() !== '')?.slice(0, 200);
}

function emptyPatch(fixerId: string, diagnosis: Diagnosis, rationale: string): Patch {
  return { fixerId, signature: diagnosis.issue.signature, edits: [], rationale };
}
