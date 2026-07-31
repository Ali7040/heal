/**
 * Configuration loading and validation.
 *
 * Validation happens here, once, at the edge — before a single detector runs.
 * A config typo that surfaces halfway through a run, after a checkpoint commit
 * has been made, is far more expensive than one that stops the process at
 * startup with a readable message.
 *
 * The allowlist has no default on purpose. There is no safe guess for "which
 * files may an autonomous agent rewrite", and a permissive default would be the
 * kind of decision users discover only after it has cost them something.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

export interface CheckConfig {
  readonly id: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly editable: readonly string[];
  readonly timeoutMs?: number;
}

export interface SelfHealConfig {
  readonly repoRoot: string;
  readonly checks: readonly CheckConfig[];
  /** Globs a patch may touch, repo-relative. */
  readonly allowlist: readonly string[];
  readonly harness: string;
  readonly attemptCap: number;
  readonly failureThreshold: number;
  readonly evidenceDir: string;
}

const DEFAULTS = {
  harness: 'claude-code',
  attemptCap: 2,
  failureThreshold: 3,
  evidenceDir: '.self-heal/evidence',
} as const;

export async function loadConfig(path: string, cwd: string): Promise<SelfHealConfig> {
  const absolute = isAbsolute(path) ? path : resolve(cwd, path);

  let raw: string;
  try {
    raw = await readFile(absolute, 'utf8');
  } catch {
    throw new ConfigError(`config not found: ${absolute}\nRun \`self-heal init\` to create one.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`config is not valid JSON: ${absolute}\n${(error as Error).message}`);
  }

  return validate(parsed, cwd, absolute);
}

export class ConfigError extends Error {}

function validate(input: unknown, cwd: string, source: string): SelfHealConfig {
  if (typeof input !== 'object' || input === null) {
    throw new ConfigError(`config must be a JSON object: ${source}`);
  }
  const record = input as Record<string, unknown>;

  const checks = record['checks'];
  if (!Array.isArray(checks) || checks.length === 0) {
    throw new ConfigError('config.checks must be a non-empty array — there is nothing to detect otherwise');
  }

  const allowlist = record['allowlist'];
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    throw new ConfigError(
      'config.allowlist must be a non-empty array of globs.\n' +
        'There is no default: it decides which files an autonomous agent may rewrite.',
    );
  }

  return {
    repoRoot: typeof record['repoRoot'] === 'string' ? resolve(cwd, record['repoRoot']) : cwd,
    checks: checks.map((check, index) => validateCheck(check, index)),
    allowlist: allowlist.map(String),
    harness: typeof record['harness'] === 'string' ? record['harness'] : DEFAULTS.harness,
    attemptCap: typeof record['attemptCap'] === 'number' ? record['attemptCap'] : DEFAULTS.attemptCap,
    failureThreshold:
      typeof record['failureThreshold'] === 'number' ? record['failureThreshold'] : DEFAULTS.failureThreshold,
    evidenceDir: typeof record['evidenceDir'] === 'string' ? record['evidenceDir'] : DEFAULTS.evidenceDir,
  };
}

function validateCheck(input: unknown, index: number): CheckConfig {
  if (typeof input !== 'object' || input === null) {
    throw new ConfigError(`config.checks[${index}] must be an object`);
  }
  const record = input as Record<string, unknown>;

  const command = record['command'];
  if (typeof command !== 'string' || command === '') {
    throw new ConfigError(`config.checks[${index}].command is required`);
  }

  const editable = Array.isArray(record['editable']) ? record['editable'].map(String) : [];
  if (editable.length === 0) {
    throw new ConfigError(
      `config.checks[${index}].editable is required — a fixer needs to know which files this check is about`,
    );
  }

  return {
    id: typeof record['id'] === 'string' ? record['id'] : `check-${index}`,
    command,
    args: Array.isArray(record['args']) ? record['args'].map(String) : [],
    editable,
    ...(typeof record['timeoutMs'] === 'number' ? { timeoutMs: record['timeoutMs'] } : {}),
  };
}

/** Written by `self-heal init`. Deliberately small enough to read in one screen. */
export const EXAMPLE_CONFIG = `{
  "allowlist": ["src/**/*.ts", "src/**/*.js"],
  "checks": [
    {
      "id": "unit-tests",
      "command": "npm",
      "args": ["test"],
      "editable": ["src/**/*.ts"]
    }
  ],
  "harness": "claude-code",
  "attemptCap": 2
}
`;
