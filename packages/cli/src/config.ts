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
import { isAbsolute, relative, resolve, sep } from 'node:path';

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
  readonly server?: ServerConfigInput;
  readonly contractsDir?: string;
  readonly strict?: boolean;
  readonly record?: 'missing' | 'never';
}

/** One view under visual regression. */
export interface ViewConfigInput {
  readonly name: string;
  readonly url: string;
  readonly editable: readonly string[];
}

/** The pixel half of the config. Shares `server` for the same reason contracts do. */
export interface VisualConfig {
  readonly id: string;
  readonly views: readonly ViewConfigInput[];
  readonly server?: ServerConfigInput;
  readonly baselineDir?: string;
  readonly tolerance?: number;
  readonly maxRatio?: number;
  readonly record?: 'missing' | 'never';
}

export interface ServerConfigInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly readyUrl: string;
  readonly readyTimeoutMs?: number;
}

export interface SelfHealConfig {
  readonly repoRoot: string;
  readonly checks: readonly CheckConfig[];
  readonly contracts?: ContractsConfig;
  readonly visual?: VisualConfig;
  /** Globs a patch may touch, repo-relative. */
  readonly allowlist: readonly string[];
  /**
   * Globs no patch may touch, whatever `allowlist` says. Defaults to common test
   * layouts; the config file itself is always added (D-021).
   */
  readonly protected: readonly string[];
  readonly harness: string;
  readonly attemptCap: number;
  readonly failureThreshold: number;
  /** Re-run every detector after a fix and revert it if it broke another check. Default true (D-025). */
  readonly collateral: boolean;
  /** Re-runs a failure must also fail before anything is spent on it. Default 1, 0 disables (D-030). */
  readonly confirmFailures: number;
  readonly evidenceDir: string;
  /** Outcome journal, relative to the repo root. Gitignored by `self-heal init`. */
  readonly journalPath: string;
  /**
   * Globs a model never sees and no patch may write, even when tracked. Always
   * includes `DEFAULT_SANDBOX_EXCLUDE`; a config can add to it, not remove (D-031).
   */
  readonly sandboxExclude: readonly string[];
  /** Run a harness profile no spike has verified honours the tool grant. Default false. */
  readonly allowUnverifiedHarness: boolean;
}

/**
 * Files that hold secrets far more often than code, kept away from a model even
 * when someone committed them. Deliberately narrow — every entry here is a file a
 * bug fix should never need to read — and deliberately not removable: a security
 * default you can switch off by typo is not a default.
 */
export const DEFAULT_SANDBOX_EXCLUDE: readonly string[] = [
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/id_rsa*',
  '**/id_ed25519*',
  '**/id_ecdsa*',
  '**/.npmrc',
  '**/.pypirc',
  '**/.netrc',
];

/**
 * Tests are the measurement for most command checks. A patch that edits the test
 * makes the check pass without fixing anything, so they are off limits unless a
 * config says otherwise — `"protected": []` opts out entirely.
 */
export const DEFAULT_PROTECTED: readonly string[] = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/*_test.*',
  '**/test_*.py',
  '**/__tests__/**',
  '**/test/**',
  '**/tests/**',
];

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
  const visual = validateVisual(record['visual']);
  // Any one kind of detector is enough on its own; none is not.
  if (checks.length === 0 && contracts === undefined && visual === undefined) {
    throw new ConfigError(
      'config needs at least one detector: a non-empty `checks` array, `contracts.endpoints`, `visual.views`, or any combination.',
    );
  }

  const allowlist = record['allowlist'];
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    throw new ConfigError(
      'config.allowlist must be a non-empty array of globs.\n' +
        'There is no default: it decides which files an autonomous agent may rewrite.',
    );
  }

  const protectedInput = record['protected'];
  if (protectedInput !== undefined && !Array.isArray(protectedInput)) {
    throw new ConfigError(
      "config.protected must be an array of globs. Use [] to protect nothing beyond the loop's own state and this config.",
    );
  }

  const repoRoot = typeof record['repoRoot'] === 'string' ? resolve(cwd, record['repoRoot']) : cwd;
  // A patch that rewrote the config could widen its own allowlist or delete a
  // check for every later run. It is protected whatever `protected` says.
  const configInRepo = relative(repoRoot, source).split(sep).join('/');
  const protectedPaths = [
    ...(Array.isArray(protectedInput) ? protectedInput.map(String) : DEFAULT_PROTECTED),
    ...(configInRepo.startsWith('..') || isAbsolute(configInRepo) ? [] : [configInRepo]),
  ];

  return {
    repoRoot,
    checks: checks.map((check, index) => validateCheck(check, index)),
    ...(contracts !== undefined ? { contracts } : {}),
    ...(visual !== undefined ? { visual } : {}),
    allowlist: allowlist.map(String),
    protected: protectedPaths,
    harness: typeof record['harness'] === 'string' ? record['harness'] : DEFAULTS.harness,
    attemptCap: typeof record['attemptCap'] === 'number' ? record['attemptCap'] : DEFAULTS.attemptCap,
    failureThreshold:
      typeof record['failureThreshold'] === 'number' ? record['failureThreshold'] : DEFAULTS.failureThreshold,
    collateral: record['collateral'] !== false,
    confirmFailures: validateConfirmFailures(record['confirmFailures']),
    evidenceDir: typeof record['evidenceDir'] === 'string' ? record['evidenceDir'] : DEFAULTS.evidenceDir,
    journalPath: typeof record['journalPath'] === 'string' ? record['journalPath'] : DEFAULTS.journalPath,
    sandboxExclude: validateSandboxExclude(record['sandboxExclude']),
    allowUnverifiedHarness: record['allowUnverifiedHarness'] === true,
  };
}

function validateSandboxExclude(input: unknown): string[] {
  if (input === undefined) return [...DEFAULT_SANDBOX_EXCLUDE];
  if (!Array.isArray(input)) {
    throw new ConfigError('config.sandboxExclude must be an array of globs. It adds to the built-in secret patterns.');
  }
  return [...new Set([...DEFAULT_SANDBOX_EXCLUDE, ...input.map(String)])];
}

function validateConfirmFailures(input: unknown): number {
  if (input === undefined) return 1;
  if (typeof input !== 'number' || !Number.isInteger(input) || input < 0 || input > 10) {
    throw new ConfigError('config.confirmFailures must be a whole number from 0 to 10 (0 trusts the first measurement).');
  }
  return input;
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

function validateVisual(input: unknown): VisualConfig | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== 'object') throw new ConfigError('config.visual must be an object');
  const record = input as Record<string, unknown>;

  const views = record['views'];
  if (!Array.isArray(views) || views.length === 0) {
    throw new ConfigError('config.visual.views must be a non-empty array');
  }

  const record_ = record['record'];
  if (record_ !== undefined && record_ !== 'missing' && record_ !== 'never') {
    throw new ConfigError('config.visual.record must be "missing" or "never"');
  }

  const server = validateServer(record['server'], 'config.visual.server');

  return {
    id: typeof record['id'] === 'string' ? record['id'] : 'visual',
    views: views.map((view, index) => validateView(view, index)),
    ...(server !== undefined ? { server } : {}),
    ...(typeof record['baselineDir'] === 'string' ? { baselineDir: record['baselineDir'] } : {}),
    ...(typeof record['tolerance'] === 'number' ? { tolerance: record['tolerance'] } : {}),
    ...(typeof record['maxRatio'] === 'number' ? { maxRatio: record['maxRatio'] } : {}),
    ...(record_ !== undefined ? { record: record_ } : {}),
  };
}

function validateView(input: unknown, index: number): ViewConfigInput {
  if (typeof input !== 'object' || input === null) {
    throw new ConfigError(`config.visual.views[${index}] must be an object`);
  }
  const record = input as Record<string, unknown>;

  const url = record['url'];
  if (typeof url !== 'string' || url === '') {
    throw new ConfigError(`config.visual.views[${index}].url is required — it is where the image comes from`);
  }

  const editable = Array.isArray(record['editable']) ? record['editable'].map(String) : [];
  if (editable.length === 0) {
    throw new ConfigError(
      `config.visual.views[${index}].editable is required — a fixer needs to know which files render this view`,
    );
  }

  return {
    // The name is the baseline's filename and the issue's identity, so it must
    // survive a change of host. Defaulting to the path keeps a recorded baseline
    // valid whether it was captured against localhost or staging.
    name: typeof record['name'] === 'string' ? record['name'] : pathOf(url),
    url,
    editable,
  };
}

function validateServer(input: unknown, label: string): ServerConfigInput | undefined {
  if (input === undefined || input === null) return undefined;
  const record = input as Record<string, unknown>;
  if (typeof record['command'] !== 'string' || typeof record['readyUrl'] !== 'string') {
    throw new ConfigError(
      `${label} needs \`command\` and \`readyUrl\`.\n` +
        '`readyUrl` is polled until it answers — without it, measuring races the server startup.',
    );
  }
  return {
    command: record['command'],
    args: Array.isArray(record['args']) ? record['args'].map(String) : [],
    readyUrl: record['readyUrl'],
    ...(typeof record['readyTimeoutMs'] === 'number' ? { readyTimeoutMs: record['readyTimeoutMs'] } : {}),
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
