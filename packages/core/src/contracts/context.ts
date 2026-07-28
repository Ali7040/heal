/** Everything a detector is allowed to know about the run it is part of. */
export interface RunContext {
  /** Absolute path to the repository under repair. */
  readonly repoRoot: string;
  /** Absolute path to the directory where evidence artifacts are written. */
  readonly evidenceDir: string;
  /** Nothing is mutated on disk when true. */
  readonly dryRun: boolean;
  /** Cooperative cancellation — detectors should honour it. */
  readonly signal?: AbortSignal;
  /** Detector-scoped configuration, validated by the detector itself. */
  readonly config: Readonly<Record<string, unknown>>;
  readonly log: Logger;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}
