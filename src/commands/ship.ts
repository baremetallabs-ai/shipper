import { execFileSync, spawnSync } from 'node:child_process';
import { getRepoNwo, selectIssuesForStage } from '../lib/github.js';
import { withStageHooks } from '../lib/hooks.js';
import { withIssueLock } from '../lib/lock.js';
import { postMerge } from './merge.js';
import type { QueuedPR } from './merge.js';

const MAX_REVIEW_CYCLES = 3;

export const STAGE_NAME: Record<string, string> = {
  'shipper:new': 'groom',
  'shipper:groomed': 'design',
  'shipper:designed': 'plan',
  'shipper:planned': 'implement',
  'shipper:implemented': 'pr open',
  'shipper:pr-open': 'pr review',
  'shipper:pr-reviewed': 'pr remediate',
};

export const AUTO_PRIORITY_LABELS: string[] = [
  'shipper:ready',
  'shipper:pr-reviewed',
  'shipper:pr-open',
  'shipper:implemented',
  'shipper:planned',
  'shipper:designed',
  'shipper:groomed',
  'shipper:new',
];

interface StageResult {
  stage: string;
  status: 'pass' | 'fail';
}

interface AutoResult {
  issue: number;
  title: string;
  outcome: 'pass' | 'fail';
  error?: string;
}

export interface ShipOptions {
  merge: boolean;
  auto: boolean;
}

function getCurrentLabel(issueStr: string): string | undefined {
  let output: string;
  try {
    output = execFileSync(
      'gh',
      ['issue', 'view', issueStr, '--json', 'labels', '--jq', '.labels[].name'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
  } catch {
    return undefined;
  }

  if (!output) return undefined;

  const shipperLabels = output
    .split(/\r?\n/)
    .filter(
      (name) =>
        name.startsWith('shipper:') && name !== 'shipper:blocked' && name !== 'shipper:locked'
    );

  if (shipperLabels.length !== 1) return undefined;

  return shipperLabels[0];
}

function printSummary(results: StageResult[]): void {
  console.log('\nStage summary:');
  for (const r of results) {
    const icon = r.status === 'pass' ? '✓' : '✗';
    const suffix = r.status === 'fail' ? ' — failed' : '';
    console.log(`  ${icon} ${r.stage}${suffix}`);
  }
}

function printAutoSummary(results: AutoResult[]): void {
  if (results.length === 0) {
    console.log('\nAuto run complete. No eligible issues found.');
    return;
  }
  console.log('\nAuto run complete.\n');
  console.log('  #    Issue                                          Outcome');
  for (const r of results) {
    const num = String(r.issue).padEnd(5);
    const titleChars = Array.from(r.title);
    const title =
      titleChars.length > 45 ? titleChars.slice(0, 42).join('') + '...' : r.title.padEnd(45);
    const outcome = r.outcome === 'pass' ? '✓ pass' : `✗ fail — ${r.error ?? 'unknown error'}`;
    console.log(`  ${num}${title} ${outcome}`);
  }
}

function resolvePrForIssue(issueNumber: number, nwo: string): QueuedPR {
  let output: string;
  try {
    output = execFileSync(
      'gh',
      [
        'pr',
        'list',
        '-R',
        nwo,
        '--state',
        'open',
        '--json',
        'number,title,headRefName,baseRefName',
      ],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch {
    throw new Error(`Failed to look up PRs for issue #${issueNumber}.`);
  }

  let allPrs: QueuedPR[];
  try {
    allPrs = JSON.parse(output) as QueuedPR[];
  } catch {
    throw new Error(
      `Failed to parse GitHub CLI output while looking up PR for issue #${issueNumber}.`
    );
  }

  const prs = (allPrs ?? []).filter(
    (pr) =>
      pr.headRefName === `shipper/${issueNumber}` ||
      pr.headRefName.startsWith(`shipper/${issueNumber}-`)
  );

  if (prs.length === 0) {
    throw new Error(`No open PR found for issue #${issueNumber}.`);
  }

  if (prs.length > 1) {
    const prNumbers = prs.map((pr) => `#${pr.number}`).join(', ');
    throw new Error(
      `Multiple open PRs found for issue #${issueNumber}: ${prNumbers}. Please ensure only one is open.`
    );
  }

  return { ...prs[0]!, labeledAt: '' };
}

function mergePr(pr: QueuedPR, issueNumber: number, nwo: string): boolean {
  try {
    execFileSync(
      'gh',
      ['pr', 'merge', String(pr.number), '-R', nwo, '--rebase', '--delete-branch'],
      { stdio: 'inherit' }
    );
    console.log(`PR #${pr.number} merged successfully.`);
    postMerge(pr, issueNumber, nwo, false);
    return true;
  } catch {
    console.error(`\nMerge failed for PR #${pr.number}. See command output above for details.`);
    return false;
  }
}

function shipOneIssue(issue: string, merge: boolean): { success: boolean; error?: string } {
  const issueStr = issue.replace(/^#/, '');

  return withIssueLock(issueStr, () => {
    let label = getCurrentLabel(issueStr);

    if (!label) {
      const msg = `Issue #${issueStr} has no shipper label. Run \`shipper next\` or add a label first.`;
      console.error(msg);
      return { success: false, error: msg };
    }

    if (label === 'shipper:ready') {
      if (!merge) {
        console.log(`Issue #${issueStr} is already at shipper:ready.`);
        return { success: true };
      }
      // Fall through to merge logic below the loop
    }

    if (label !== 'shipper:ready' && !(label in STAGE_NAME)) {
      const msg = `Unrecognized shipper label "${label}" on issue #${issueStr}.`;
      console.error(msg);
      return { success: false, error: msg };
    }

    const results: StageResult[] = [];

    if (label !== 'shipper:ready') {
      let reviewCycles = 0;
      let seenPrReviewed = false;

      for (;;) {
        const stageName = STAGE_NAME[label]!;
        const previousLabel: string | undefined = label;

        console.log(`Running stage: ${stageName}`);

        const result = spawnSync(process.execPath, [process.argv[1]!, 'next', issueStr], {
          stdio: 'inherit',
          env: process.env,
        });

        if (result.status !== 0) {
          results.push({ stage: stageName, status: 'fail' });
          printSummary(results);
          return { success: false, error: `stage "${stageName}" failed` };
        }

        results.push({ stage: stageName, status: 'pass' });

        label = getCurrentLabel(issueStr);

        if (label === 'shipper:ready') {
          break;
        }

        if (!label || !(label in STAGE_NAME)) {
          if (!label) {
            console.error(`Issue #${issueStr} has no shipper label after stage "${stageName}".`);
          } else {
            console.error(
              `Unrecognized shipper label "${label}" on issue #${issueStr} after stage "${stageName}".`
            );
          }
          printSummary(results);
          return { success: false, error: `unexpected label after stage "${stageName}"` };
        }

        if (label === previousLabel) {
          const msg = `Label did not advance after stage "${stageName}" (still "${label}"). Aborting to avoid infinite loop.`;
          console.error(msg);
          printSummary(results);
          return { success: false, error: msg };
        }

        if (label === 'shipper:pr-reviewed') {
          if (seenPrReviewed) {
            reviewCycles++;
            if (reviewCycles >= MAX_REVIEW_CYCLES) {
              const msg = `Review loop cap reached after ${MAX_REVIEW_CYCLES} cycles. Issue is at shipper:pr-reviewed. Continue manually.`;
              console.error(msg);
              results.push({ stage: 'pr remediate', status: 'fail' });
              printSummary(results);
              return { success: false, error: msg };
            }
          }
          seenPrReviewed = true;
        }
      }
    }

    if (merge) {
      console.log('Running stage: merge');
      const issueNumber = Number(issueStr);
      const nwo = getRepoNwo();

      let pr: QueuedPR;
      try {
        pr = resolvePrForIssue(issueNumber, nwo);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(msg);
        results.push({ stage: 'merge', status: 'fail' });
        printSummary(results);
        return { success: false, error: msg };
      }

      const merged = withStageHooks(
        'merge',
        { issueNumber: issueStr, branchName: pr.headRefName },
        () => mergePr(pr, issueNumber, nwo)
      );

      if (merged) {
        results.push({ stage: 'merge', status: 'pass' });
      } else {
        results.push({ stage: 'merge', status: 'fail' });
        printSummary(results);
        return { success: false, error: 'merge failed' };
      }
    }

    printSummary(results);
    return { success: true };
  });
}

export function selectNextCandidate(
  skippedIssues: Set<number>
): { number: number; title: string } | null {
  for (const label of AUTO_PRIORITY_LABELS) {
    const issues = selectIssuesForStage(label);
    const candidate = issues.find((i) => !skippedIssues.has(i.number));
    if (candidate) return candidate;
  }
  return null;
}

export function shipCommand(
  issue: string | undefined,
  options: ShipOptions = { merge: false, auto: false }
): void {
  if (options.auto) {
    const skippedIssues = new Set<number>();
    const results: AutoResult[] = [];

    for (;;) {
      const candidate = selectNextCandidate(skippedIssues);
      if (!candidate) break;

      console.log(`\nAuto: advancing issue #${candidate.number} — ${candidate.title}`);
      const result = shipOneIssue(String(candidate.number), true);

      if (result.success) {
        results.push({ issue: candidate.number, title: candidate.title, outcome: 'pass' });
      } else {
        skippedIssues.add(candidate.number);
        results.push({
          issue: candidate.number,
          title: candidate.title,
          outcome: 'fail',
          error: result.error,
        });
      }
    }

    printAutoSummary(results);
    process.exit(0);
  }

  // Non-auto path: issue is required (validated in index.ts)
  const result = shipOneIssue(issue!, options.merge);
  process.exit(result.success ? 0 : 1);
}
