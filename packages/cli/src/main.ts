#!/usr/bin/env node
import { parseArgs } from 'node:util';

/**
 * Thin by contract: parse, load config, hand off. Any logic that grows in here
 * belongs in `core` — the CLI must stay a shell around the runner (ARCHITECTURE.md §1).
 */
const USAGE = `self-heal — detect, propose, verify, record

Usage:
  self-heal run [--dry-run] [--config <path>]

Options:
  --dry-run      Run everything up to CHECKPOINTING, print the proposed patch, stop.
                 A real code path, not a flag checked at the last moment.
  --config       Path to config (default: ./self-heal.config.json)
  --help
`;

export function main(argv: readonly string[]): number {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      'dry-run': { type: 'boolean', default: false },
      config: { type: 'string', default: './self-heal.config.json' },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 1;
  }

  if (positionals[0] !== 'run') {
    process.stderr.write(`unknown command: ${positionals[0]}\n\n${USAGE}`);
    return 1;
  }

  process.stderr.write('self-heal: the runner is not implemented yet (phase 1)\n');
  return 1;
}

process.exitCode = main(process.argv.slice(2));
