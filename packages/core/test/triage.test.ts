import { describe, expect, it } from 'vitest';

import type { Issue } from '../src/contracts/issue.js';
import { DEFAULT_PRIORITY, triage } from '../src/runner/runner.js';

function issue(id: string, overrides: Partial<Issue> = {}): Issue {
  return {
    signature: id,
    detectorId: id,
    kind: 'k',
    location: {},
    expected: null,
    actual: null,
    evidence: [],
    severity: 'high',
    detectedAt: '',
    ...overrides,
  };
}

const order = (issues: Issue[]) => triage(issues).map((i) => i.signature);

describe('triage', () => {
  it('handles lower priority first, with no priority meaning the default', () => {
    expect(order([issue('tests'), issue('build', { priority: 10 }), issue('late', { priority: DEFAULT_PRIORITY + 1 })])).toEqual([
      'build',
      'tests',
      'late',
    ]);
  });

  it('breaks a priority tie by severity', () => {
    expect(order([issue('low', { severity: 'low' }), issue('high'), issue('medium', { severity: 'medium' })])).toEqual([
      'high',
      'medium',
      'low',
    ]);
  });

  it('keeps detection order between equals, so runs are reproducible', () => {
    expect(order([issue('a'), issue('b'), issue('c'), issue('d')])).toEqual(['a', 'b', 'c', 'd']);
  });
});
