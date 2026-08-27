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

/** One endpoint under contract. */
export interface EndpointConfigInput {
  readonly name: string;
  readonly url: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly editable: readonly string[];
}

/**
 * The API-contract half of the config.
 *
 * `server` is shared by every endpoint because booting is expensive and the
 * detector boots once per measurement, not once per endpoint.
 */
export interface ContractsConfig {
  readonly id: string;
  readonly endpoints: readonly EndpointConfigInput[];
  readonly server?: {
    readonly command: string;
    readonly args: readonly string[];
    readonly readyUrl: string;
    readonly readyTimeoutMs?: number;
  };
  readonly contractsDir?: string;
  readonly strict?: boolean;
  readonly record?: 'missing' | 'never';
}

export interface SelfHealConfig {
  readonly repoRoot: string;
  readonly checks: readonly CheckConfig[];
  readonly contracts?: ContractsConfig;
  /** Globs a patch may touch, repo-relative. */
  readonly allowlist: readonly string[];
  readonly harness: string;
  readonly attemptCap: number;
  readonly failureThreshold: number;
  readonly evidenceDir: string;
  /** Outcome journal, relative to the repo root. Gitignored by `self-heal init`. */
  readonly journalPath: string;
}

const DEFAULTS = {
  harness: 'claude-code',
  attemptCap: 2,
  failureThreshold: 3,
  evidenceDir: '.self-heal/evidence',
  journalPath: '.self-heal/journal.sqlite',
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

  const checks = Array.isArray(record['checks']) ? record['checks'] : [];
  const contracts = validateContracts(record['contracts']);
  // Either kind of detector is enough on its own; neither is not.
  if (checks.length === 0 && contracts === undefined) {
    throw new ConfigError(
      'config needs at least one detector: a non-empty `checks` array, `contracts.endpoints`, or both.',
    );
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
    ...(contracts !== undefined ? { contracts } : {}),
    allowlist: allowlist.map(String),
    harness: typeof record['harness'] === 'string' ? record['harness'] : DEFAULTS.harness,
    attemptCap: typeof record['attemptCap'] === 'number' ? record['attemptCap'] : DEFAULTS.attemptCap,
    failureThreshold:
      typeof record['failureThreshold'] === 'number' ? record['failureThreshold'] : DEFAULTS.failureThreshold,
    evidenceDir: typeof record['evidenceDir'] === 'string' ? record['evidenceDir'] : DEFAULTS.evidenceDir,
    journalPath: typeof record['journalPath'] === 'string' ? record['journalPath'] : DEFAULTS.journalPath,
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

function validateContracts(input: unknown): ContractsConfig | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== 'object') throw new ConfigError('config.contracts must be an object');
  const record = input as Record<string, unknown>;

  const endpoints = record['endpoints'];
  if (!Array.isArray(endpoints) || endpoints.length === 0) {
    throw new ConfigError('config.contracts.endpoints must be a non-empty array');
  }

  const server = record['server'];
  let parsedServer: ContractsConfig['server'];
  if (server !== undefined && server !== null) {
    const serverRecord = server as Record<string, unknown>;
    if (typeof serverRecord['command'] !== 'string' || typeof serverRecord['readyUrl'] !== 'string') {
      throw new ConfigError(
        'config.contracts.server needs `command` and `readyUrl`.\n' +
          '`readyUrl` is polled until it answers — without it, probing races the server startup.',
      );
    }
    parsedServer = {
      command: serverRecord['command'],
      args: Array.isArray(serverRecord['args']) ? serverRecord['args'].map(String) : [],
      readyUrl: serverRecord['readyUrl'],
      ...(typeof serverRecord['readyTimeoutMs'] === 'number'
        ? { readyTimeoutMs: serverRecord['readyTimeoutMs'] }
        : {}),
    };
  }

  const record_ = record['record'];
  if (record_ !== undefined && record_ !== 'missing' && record_ !== 'never') {
    throw new ConfigError('config.contracts.record must be "missing" or "never"');
  }

  return {
    id: typeof record['id'] === 'string' ? record['id'] : 'contract',
    endpoints: endpoints.map((endpoint, index) => validateEndpoint(endpoint, index)),
    ...(parsedServer !== undefined ? { server: parsedServer } : {}),
    ...(typeof record['contractsDir'] === 'string' ? { contractsDir: record['contractsDir'] } : {}),
    ...(record['strict'] === true ? { strict: true } : {}),
    ...(record_ !== undefined ? { record: record_ } : {}),
  };
}

function validateEndpoint(input: unknown, index: number): EndpointConfigInput {
  if (typeof input !== 'object' || input === null) {
    throw new ConfigError(`config.contracts.endpoints[${index}] must be an object`);
  }
  const record = input as Record<string, unknown>;

  const url = record['url'];
  if (typeof url !== 'string' || url === '') {
    throw new ConfigError(`config.contracts.endpoints[${index}].url is required`);
  }

  const editable = Array.isArray(record['editable']) ? record['editable'].map(String) : [];
  if (editable.length === 0) {
    throw new ConfigError(
      `config.contracts.endpoints[${index}].editable is required — a fixer needs to know which files serve this endpoint`,
    );
  }

  const method = typeof record['method'] === 'string' ? record['method'].toUpperCase() : 'GET';
  return {
    // The name is the contract's filename and the issue's identity, so it must
    // not change when the host does. Defaulting to `METHOD /path` keeps a
    // recorded contract valid whether it was captured against localhost or a
    // staging URL.
    name: typeof record['name'] === 'string' ? record['name'] : `${method} ${pathOf(url)}`,
    url,
    method,
    ...(isStringRecord(record['headers']) ? { headers: record['headers'] } : {}),
    editable,
  };
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value as Record<string, unknown>).every((entry) => typeof entry === 'string')
  );
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
