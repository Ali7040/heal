/**
 * Harness definitions as data.
 *
 * The project never holds an API key (D-003, D-004) — it drives whatever agent
 * CLI the user has already installed and authenticated. Different users have
 * different ones, and each has its own flags for "run without a TTY", "do not
 * ask me to approve edits", and "emit machine-readable output".
 *
 * Encoding that as a lookup table rather than as branching code means supporting
 * a new harness is a new entry here — no changes to the fixer, the runner, or
 * any safety code. It also means a user can override the profile in config when
 * upstream changes a flag, without waiting for a release.
 *
 * Two properties every profile must satisfy, because the loop depends on them:
 *   - It must terminate on its own. No interactive prompt, ever.
 *   - It must be constrainable — we decide which tools it may use, so a fixer
 *     cannot run arbitrary shell commands or commit on our behalf.
 */

export interface HarnessRequest {
  /** The instruction handed to the model. Built from a Diagnosis. */
  readonly prompt: string;
  /** Tools the harness may use. Anything not listed is denied. */
  readonly allowTools: readonly string[];
  readonly denyTools: readonly string[];
}

export interface HarnessProfile {
  readonly id: string;
  /** Executable name, resolved on PATH. */
  readonly command: string;
  /**
   * How the prompt reaches the process.
   *
   * `stdin` is strongly preferred and is not a stylistic choice: on Windows an
   * npm-installed CLI is a `.cmd` shim that Node can only launch through
   * `cmd.exe`, and cmd.exe re-parses the command line. A prompt containing
   * newlines, quotes, or `%` is silently mangled before the harness ever sees
   * it — which looks exactly like the model ignoring instructions. Piping the
   * prompt in removes the shell from the payload path entirely.
   */
  readonly promptDelivery: 'stdin' | 'argv';
  /** Builds argv for one non-interactive run. Excludes the prompt when delivery is stdin. */
  buildArgs(request: HarnessRequest): string[];
  /**
   * Pulls the fields we care about out of the harness's own output.
   * Returning `null` means "unparseable" — a failure state, not an empty result.
   */
  parseResult(stdout: string): HarnessRunSummary | null;
}

export interface HarnessRunSummary {
  /** The model's final message. Used for logs and rationale — never trusted as truth. */
  readonly text: string;
  readonly costUsd: number | null;
  readonly turns: number | null;
  /** The harness's own claim of success. Recorded, never acted on. */
  readonly reportedError: boolean;
}

const claudeCode: HarnessProfile = {
  id: 'claude-code',
  command: 'claude',
  promptDelivery: 'stdin',
  buildArgs(request) {
    return [
      // Non-interactive: print the result and exit. Without this the process
      // opens a TUI and waits forever for a human. With no prompt argument it
      // reads the prompt from stdin.
      '-p',
      // Machine-readable envelope: cost, turn count, and an error flag alongside
      // the text, so we are not regex-scraping a human-facing transcript.
      '--output-format',
      'json',
      // Edits apply without a prompt. Safe only because the working directory is
      // a disposable sandbox, not the user's repository.
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      request.allowTools.join(' '),
      '--disallowedTools',
      request.denyTools.join(' '),
    ];
  },
  parseResult(stdout) {
    try {
      const parsed: unknown = JSON.parse(stdout);
      if (typeof parsed !== 'object' || parsed === null) return null;
      const record = parsed as Record<string, unknown>;
      return {
        text: typeof record['result'] === 'string' ? record['result'] : '',
        costUsd: typeof record['total_cost_usd'] === 'number' ? record['total_cost_usd'] : null,
        turns: typeof record['num_turns'] === 'number' ? record['num_turns'] : null,
        reportedError: record['is_error'] === true,
      };
    } catch {
      return null;
    }
  },
};

/**
 * Codex and Cursor are declared but unverified — no spike has been run against
 * them. They are here to prove the shape generalizes, and each needs its own
 * spike before being advertised as supported.
 */
const codexCli: HarnessProfile = {
  id: 'codex',
  command: 'codex',
  promptDelivery: 'stdin',
  buildArgs(_request) {
    return ['exec', '--json'];
  },
  parseResult(stdout) {
    return { text: stdout, costUsd: null, turns: null, reportedError: false };
  },
};

export const HARNESS_PROFILES: Readonly<Record<string, HarnessProfile>> = {
  [claudeCode.id]: claudeCode,
  [codexCli.id]: codexCli,
};

export function getProfile(id: string): HarnessProfile {
  const profile = HARNESS_PROFILES[id];
  if (profile === undefined) {
    throw new Error(`unknown harness "${id}". Available: ${Object.keys(HARNESS_PROFILES).join(', ')}`);
  }
  return profile;
}

/**
 * The default tool grant.
 *
 * Read/Edit/Write are what a code fix needs. Bash is withheld deliberately: with
 * it, a fixer could commit, install packages, reach the network, or "fix" the
 * check itself — and every one of those would corrupt the measurement we are
 * about to take.
 */
export const DEFAULT_ALLOW_TOOLS = ['Read', 'Edit', 'Write'] as const;
export const DEFAULT_DENY_TOOLS = ['Bash', 'WebFetch', 'WebSearch'] as const;
