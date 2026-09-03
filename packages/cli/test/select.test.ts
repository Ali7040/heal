import { describe, expect, it } from 'vitest';

import type { Detector } from '@self-heal/core/contracts/detector';

import { ConfigError } from '../src/config.js';
import { selectDetectors } from '../src/select.js';

/** Only `id` matters here; nothing in selection ever calls detect or verify. */
const detector = (id: string): Detector => ({
  id,
  detect: async () => [],
  verify: async () => true,
});

const ids = (detectors: readonly Detector[]): string[] => detectors.map((d) => d.id);

const all = [detector('unit-tests'), detector('contracts'), detector('visual')];

describe('selecting detectors', () => {
  it('runs everything when --only is absent', () => {
    expect(ids(selectDetectors(all, undefined))).toEqual(['unit-tests', 'contracts', 'visual']);
    expect(ids(selectDetectors(all, []))).toEqual(['unit-tests', 'contracts', 'visual']);
  });

  it('accepts repeated flags and comma-separated names as the same thing', () => {
    expect(ids(selectDetectors(all, ['visual', 'unit-tests']))).toEqual(['unit-tests', 'visual']);
    expect(ids(selectDetectors(all, ['visual,unit-tests']))).toEqual(['unit-tests', 'visual']);
    expect(ids(selectDetectors(all, [' visual , unit-tests ']))).toEqual(['unit-tests', 'visual']);
  });

  it('keeps config order, not the order the names were typed', () => {
    // Otherwise the report reshuffles depending on how someone spelled the flag.
    expect(ids(selectDetectors(all, ['visual', 'contracts']))).toEqual(['contracts', 'visual']);
  });

  // The one that matters: a typo must never produce a green run that measured
  // nothing. A false clean bill of health is the worst output this can give.
  it('refuses a name that matches nothing, rather than running nothing', () => {
    expect(() => selectDetectors(all, ['visul'])).toThrow(ConfigError);
    expect(() => selectDetectors(all, ['visul'])).toThrow(/no such detector: visul/);
  });

  it('lists what was available, so the typo is obvious', () => {
    expect(() => selectDetectors(all, ['nope'])).toThrow(/available: contracts, unit-tests, visual/);
  });

  it('reports every unknown name at once, not just the first', () => {
    expect(() => selectDetectors(all, ['nope', 'visual', 'also-nope'])).toThrow(/no such detector: nope, also-nope/);
  });

  it('refuses a flag given without a name', () => {
    // `--only ""` asked for something and named nothing; treating that as
    // "run everything" is the same silent surprise in reverse.
    expect(() => selectDetectors(all, [''])).toThrow(/without a detector name/);
    expect(() => selectDetectors(all, [','])).toThrow(/without a detector name/);
  });

  it('says so plainly when the config defines no detectors at all', () => {
    expect(() => selectDetectors([], ['anything'])).toThrow(/defines no detectors at all/);
  });
});
