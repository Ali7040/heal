/**
 * Centralized child-process execution.
 *
 * Every part of this system that touches the outside world — git checkpoints,
 * harness invocation, running a project's own test command — goes through this
 * one function. That matters for three reasons:
 *
 *   1. A timeout is mandatory, not optional. An external process that hangs must
 *      never hang the loop, so the timeout is part of the signature rather than
 *      something each caller remembers to add.
 *   2. Failure is a value, not an exception. A non-zero exit code is data the
 *      state machine acts on (`REVERTED`), not a throw that unwinds the run.
 *   3. It is the only place stdout/stderr buffering, encoding, and Windows shim
 *      handling are dealt with. One place to fix, one place to test.
 *
 * Node builtins only — `core` stays dependency-free.
 */
import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';

export interface RunCommandOptions {
  readonly cwd: string;
  /** Hard ceiling. The process is killed when it elapses. */
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Written to the child's stdin, then closed. */
  readonly stdin?: string;
  readonly signal?: AbortSignal;
}

export interface CommandResult {
  /** `null` when the process was killed rather than exiting on its own. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  /** True when our timeout killed it — distinct from the command failing. */
  readonly timedOut: boolean;
  readonly ok: boolean;
}

export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Find the real executable behind a command name.
 *
 * Resolving up front is what lets us avoid a shell. On Windows, spawning a bare
 * name like `git` forces `shell: true`, and cmd.exe then re-parses the whole
 * command line — so `commit -m "fix: thing"` silently becomes four arguments and
 * git fails with a bewildering pathspec error. Handing spawn an absolute
 * `git.exe` removes the shell, and with it an entire class of bug that shows up
 * as "the tool ignored my input".
 *
 * Only `.cmd` and `.bat` shims still require a shell — Node refuses to execute
 * them directly — and that is the narrow case callers keep payloads out of argv
 * for (see `promptDelivery` in the harness profiles).
 */
export async function resolveExecutable(command: string): Promise<string | null> {
  for (const candidate of await resolveCandidates(command)) {
    try {
      await access(candidate, constants.F_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function requiresShell(resolved: string | null, original: string): boolean {
  if (process.platform !== 'win32') return false;
  // Unresolvable: let spawn fail on its own rather than inventing a shell.
  if (resolved === null) return !isAbsolute(original) && !/\.exe$/i.test(original);
  return /\.(cmd|bat)$/i.test(resolved);
}

/**
 * Is this command installed at all?
 *
 * Worth a PATH walk of its own because the alternative — inferring it from a
 * failed run — is unreliable in exactly the case that matters. Through a shell,
 * a missing binary exits 1 with a message on stderr, indistinguishable from a
 * tool that ran and rejected the work. The loop must tell those apart: one means
 * the environment is broken, the other costs the user a retry attempt.
 */
export async function commandExists(command: string): Promise<boolean> {
  return (await resolveExecutable(command)) !== null;
}

async function resolveCandidates(command: string): Promise<string[]> {
  const extensions =
    process.platform === 'win32'
      ? (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];

  // Order matters on Windows: a tool installed by npm ships both an extensionless
  // POSIX script and a `.cmd` shim in the same directory. The extensionless file
  // is not executable by Windows, so the suffixed candidates must be preferred —
  // picking the wrong one fails instantly and looks like the tool being broken.
  const ordered = (base: string): string[] =>
    process.platform === 'win32'
      ? [...extensions.map((ext) => `${base}${ext}`), base]
      : [base, ...extensions.map((ext) => `${base}${ext}`)];

  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return ordered(command);
  }

  const dirs = (process.env['PATH'] ?? '').split(delimiter).filter(Boolean);
  return dirs.flatMap((dir) => ordered(join(dir, command)));
}

export async function runCommand(
  command: string,
  args: readonly string[],
  options: RunCommandOptions,
): Promise<CommandResult> {
  const resolved = await resolveExecutable(command);
  const shell = requiresShell(resolved, command);

  return new Promise((resolve) => {
    const startedAt = Date.now();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Spawn the resolved path where possible so no shell re-parses the arguments.
    const child = spawn(shell || resolved === null ? command : resolved, [...args], {
      cwd: options.cwd,
      shell,
      env: { ...process.env, ...options.env } as NodeJS.ProcessEnv,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const onAbort = () => child.kill('SIGKILL');
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const settle = (code: number | null) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        code,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
        ok: code === 0 && !timedOut,
      });
    };

    child.on('close', settle);
    // A missing executable is an ordinary failure here, not a crash: the caller
    // gets `ok: false` and decides, exactly as it would for a non-zero exit.
    child.on('error', (error: Error) => {
      stderr += `${error.message}\n`;
      settle(null);
    });

    if (options.stdin !== undefined) {
      child.stdin?.end(options.stdin);
    } else {
      // Close stdin so a child that tries to prompt gets EOF instead of blocking.
      child.stdin?.end();
    }
  });
}
