/**
 * An escalation, written for the person who takes over (D-028).
 *
 * Ordered by what they need first: what was measured, what the loop thinks is
 * worth trying, what the model was shown, then every attempt with its diff and
 * the measured reason it failed. Nothing here is a model's opinion except the
 * attempts' rationales, which are labelled as such.
 *
 * Written under the evidence directory, which `self-heal init` has always
 * gitignored — so the report never dirties the tree the next run must start from.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { EscalationReport } from '@self-heal/core/contracts/escalation';

export async function writeEscalation(report: EscalationReport, evidenceDir: string): Promise<string> {
  const dir = join(evidenceDir, 'escalations');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${report.issue.signature.slice(0, 8)}.md`);
  await writeFile(path, renderEscalation(report), 'utf8');
  return path;
}

export function renderEscalation(report: EscalationReport): string {
  const { issue } = report;
  const lines: string[] = [
    `# Escalated: ${issue.kind} (${issue.signature.slice(0, 8)})`,
    '',
    `> ${report.reason}`,
    '',
    `The loop stopped here and left the tree as it found it. Everything it learned is below.`,
    '',
    '## What was measured',
    '',
    `- **Detector:** \`${issue.detectorId}\` — it alone decides when this is fixed.`,
    `- **Location:** ${location(issue.location)}`,
  ];
  if (issue.related !== undefined && issue.related.length > 0) {
    lines.push(`- **Output pointed at:** ${issue.related.map(location).join(', ')}`);
  }
  for (const evidence of issue.evidence) lines.push(`- **Evidence (${evidence.kind}):** \`${evidence.path}\``);
  lines.push('', '**Expected**', '', fence('json', json(issue.expected)), '', '**Actual**', '', fence('json', json(issue.actual)));

  const hints = whereToStart(report);
  if (hints.length > 0) {
    lines.push('', '## Where to start', '', ...hints.map((hint) => `- ${hint}`));
  }

  if (report.diagnosis !== undefined) {
    lines.push('', '## What the model was shown', '');
    if (report.diagnosis.slices.length === 0) lines.push('_No code — nothing located the problem._');
    for (const slice of report.diagnosis.slices) {
      const symbol = slice.symbol !== undefined ? ` — ${slice.symbol}` : '';
      lines.push(`**\`${slice.path}:${slice.startLine}-${slice.endLine}\`**${symbol}`, '', fence(language(slice.path), slice.source), '');
    }
    lines.push(`Editable: ${report.diagnosis.editableFiles.map((f) => `\`${f}\``).join(', ') || '—'}`);
  }

  lines.push('', '## Attempts', '');
  if (report.attempts.length === 0) lines.push('_None reached the tree._');
  for (const attempt of report.attempts) {
    const label = attempt.replayed ? ' (replayed from the journal)' : '';
    lines.push(
      `### ${attempt.number}${label}`,
      '',
      `- **Failed because:** ${attempt.reason}`,
      `- **Files:** ${attempt.files.map((f) => `\`${f}\``).join(', ') || '—'}`,
      `- **The fixer's own account:** ${attempt.rationale}`,
      '',
      attempt.diff !== undefined ? fence('diff', attempt.diff.trimEnd()) : '_Never applied, so there is no diff._',
      '',
    );
  }

  lines.push(`---`, `Escalated ${report.escalatedAt}. Re-run with \`self-heal run\` once fixed; the same check verifies it.`);
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * Deterministic hints from the measured reasons — patterns in what failed, not
 * guesses about the code. Empty when nothing stands out.
 */
function whereToStart(report: EscalationReport): string[] {
  const reasons = report.attempts.map((attempt) => attempt.reason);
  const all = (test: (reason: string) => boolean) => reasons.length > 0 && reasons.every(test);
  const some = (test: (reason: string) => boolean) => reasons.some(test);
  const hints: string[] = [];

  if (some((r) => r.includes('(protected)'))) {
    hints.push(
      'A proposal tried to edit a protected file — a test, a baseline, or the config. If the fix genuinely needs that, it is a human change; otherwise the cause is elsewhere.',
    );
  }
  if (some((r) => r.includes('(not-allowed)'))) {
    hints.push('A proposal reached outside the allowlist. The fix may live in a file the config does not let the loop edit.');
  }
  if (some((r) => r.includes('broke '))) {
    hints.push('A proposal fixed this check but broke another. The two checks may disagree about the intended behaviour.');
  }
  if (all((r) => r === 'fixer proposed no change')) {
    hints.push(
      'The fixer never proposed a change. Check the harness is installed and signed in, or that the model was shown the right code (below).',
    );
  }
  if (all((r) => r.startsWith('verification failed'))) {
    hints.push('Every proposal applied cleanly and still failed the check. The defect is probably not where the model looked.');
  }
  const files = new Set(report.attempts.flatMap((attempt) => attempt.files));
  if (report.attempts.length > 1 && files.size === 1) {
    hints.push(`Every attempt edited only \`${[...files][0] ?? ''}\`. If that file is not the culprit, look upstream of it.`);
  }
  if (report.diagnosis !== undefined && report.diagnosis.slices.length === 0) {
    hints.push('Nothing pointed at a file, so the model saw no code. A narrower `editable` in the config gives it somewhere to look.');
  }
  return hints;
}

function location(where: EscalationReport['issue']['location']): string {
  if (where.endpoint !== undefined) return `\`${where.endpoint}\``;
  if (where.selector !== undefined) return `\`${where.selector}\``;
  if (where.file !== undefined) return `\`${where.file}${where.line !== undefined ? `:${where.line}` : ''}\``;
  return 'unknown';
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? 'null';
}

/** A fence longer than any backtick run inside, so the content cannot close it. */
function fence(lang: string, body: string): string {
  const longest = Math.max(2, ...[...body.matchAll(/`+/g)].map((match) => match[0].length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}${lang}\n${body}\n${ticks}`;
}

function language(path: string): string {
  const ext = path.split('.').pop() ?? '';
  const known: Record<string, string> = {
    ts: 'ts', tsx: 'tsx', js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx', py: 'python', go: 'go', rs: 'rust',
    json: 'json', css: 'css', html: 'html', md: 'md', sh: 'sh', yml: 'yaml', yaml: 'yaml',
  };
  return known[ext] ?? '';
}
