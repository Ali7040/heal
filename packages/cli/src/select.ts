import type { Detector } from '@self-heal/core/contracts/detector';

import { ConfigError } from './config.js';

/**
 * Narrow a run to named detectors, for iterating on one of them.
 *
 * A repository with a test check, a contract, and a visual baseline runs all
 * three every time, and the visual one boots a server. When the thing being
 * worked on is the contract, the other two are a tax paid on every loop.
 *
 * The rule that makes this safe: **an unmatched name is an error, never an
 * empty run.** A typo that silently selects nothing would produce a green
 * report saying zero issues, from a run that measured nothing at all — a false
 * clean bill of health, which is the one output this project must never
 * produce. So the failure is loud and lists what was actually available.
 */
export function selectDetectors(detectors: readonly Detector[], only: readonly string[] | undefined): Detector[] {
  const wanted = parseIds(only);
  if (wanted === undefined) return [...detectors];

  const known = new Set(detectors.map((detector) => detector.id));
  const unknown = [...wanted].filter((id) => !known.has(id));
  if (unknown.length > 0) {
    const available = [...known].sort().join(', ');
    throw new ConfigError(
      `--only names no such detector: ${unknown.join(', ')}\n` +
        (available === '' ? 'this config defines no detectors at all.' : `available: ${available}`),
    );
  }

  // Config order is preserved rather than the order the flags were typed: the
  // run report should not reshuffle depending on how someone spelled the flag.
  return detectors.filter((detector) => wanted.has(detector.id));
}

/**
 * `--only a --only b` and `--only a,b` mean the same thing.
 *
 * Both spellings turn up in the wild and neither is worth being pedantic
 * about, so both are accepted rather than one being an error.
 */
function parseIds(only: readonly string[] | undefined): Set<string> | undefined {
  if (only === undefined || only.length === 0) return undefined;

  const ids = only
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => value !== '');

  // `--only ""` or `--only ,` asked for something and named nothing. Treating
  // that as "run everything" would be the same silent surprise in reverse.
  if (ids.length === 0) throw new ConfigError('--only was given without a detector name');
  return new Set(ids);
}
