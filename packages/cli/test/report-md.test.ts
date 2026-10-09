import { describe, expect, it } from 'vitest';

import type { Issue } from '@self-heal/core/contracts/issue';
import type { IssueOutcome, RunReport } from '@self-heal/core/runner/runner';

import { renderRunMarkdown, RUN_MARKDOWN_LIMIT, type RunMarkdownInput } from '../src/report-md.js';

function issue(signature: string): Issue {
  return {
    signature,
    detectorId: 'tests',
    kind: 'check-failed',
    location: {},
    expected: 0,
    actual: 1,
    evidence: [],
    severity: 'high',
    detectedAt: '',
  };
}

function outcome(signature: string, state: IssueOutcome['state'], reason: string): IssueOutcome {
  return { issue: issue(signature), state, attempts: 1, reason, replayed: false };
}

function input(outcomes: IssueOutcome[], overrides: Partial<RunMarkdownInput> = {}): RunMarkdownInput {
  const report: RunReport = { issues: outcomes.length, outcomes, halted: false, dryRun: false, durationMs: 1 };
  return { report, escalations: new Map(), calls: [], commits: [], ...overrides };
}

describe('renderRunMarkdown', () => {
  it('leads with what was fixed, and tells the reviewer what the checks cannot prove', () => {
    const text = renderRunMarkdown(
      input([outcome('aaaaaaaa11', 'HEALED', 'verified by the originating detector'), outcome('bbbbbbbb22', 'ESCALATED', 'cap')], {
        commits: [{ sha: 'abc1234', subject: 'self-heal: fix check-failed (aaaaaaaa)' }],
        calls: [{ costUsd: 0.01 }, { costUsd: 0.02 }],
      }),
    );

    expect(text).toMatch(/^## self-heal: 1 of 2 issue\(s\) fixed/);
    expect(text).toContain('**Review the diff before merging**');
    expect(text).toContain('| ✅ | `check-failed` `aaaaaaaa` | HEALED | verified by the originating detector |');
    expect(text).toContain('- `abc1234` self-heal: fix check-failed (aaaaaaaa)');
    expect(text).toContain('$0.0300 over 2 model call(s).');
  });

  it('folds each escalation hand-off into the body', () => {
    const text = renderRunMarkdown(
      input([outcome('bbbbbbbb22', 'ESCALATED', 'cap')], {
        escalations: new Map([['bbbbbbbb22', { path: '.self-heal/evidence/escalations/bbbbbbbb.md', markdown: '# Escalated: details' }]]),
      }),
    );
    expect(text).toContain('<details><summary>What was tried, and why it failed</summary>\n\n# Escalated: details\n\n</details>');
  });

  it('stays under the PR body limit by dropping whole escalations, and says which', () => {
    const big = 'x'.repeat(25_000);
    const outcomes = ['a1', 'b2', 'c3', 'd4'].map((s) => outcome(`${s}000000`, 'ESCALATED', 'cap'));
    const escalations = new Map(outcomes.map((o) => [o.issue.signature, { path: `esc/${o.issue.signature}.md`, markdown: big }]));

    const text = renderRunMarkdown(input(outcomes, { escalations }));

    expect(text.length).toBeLessThanOrEqual(RUN_MARKDOWN_LIMIT);
    expect(text).toMatch(/escalation report\(s\) left out for length/);
    // Never cut mid-section: every <details> that opened also closed.
    expect(text.split('<details>').length).toBe(text.split('</details>').length);
  });

  it('keeps a reason with a pipe or newline inside its table cell', () => {
    const text = renderRunMarkdown(input([outcome('aaaaaaaa11', 'REVERTED', 'a | b\nc')]));
    expect(text).toContain('| a \\| b c |');
  });

  it('says when nothing was detected, or the run halted', () => {
    expect(renderRunMarkdown(input([]))).toMatch(/^## self-heal: no issues detected/);
    const halted = input([]);
    expect(
      renderRunMarkdown({ ...halted, report: { ...halted.report, halted: true, haltReason: 'working tree is dirty' } }),
    ).toContain('> **Halted:** working tree is dirty');
  });
});
