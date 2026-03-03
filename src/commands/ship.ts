import { execFileSync, spawnSync } from 'node:child_process';
import { getRepoNwo } from '../lib/github.js';
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

interface StageResult {
  stage: string;
  status: 'pass' | 'fail';
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
    .filter((name) => name.startsWith('shipper:') && name !== 'shipper:blocked');

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

interface ShipOptions {
  merge: boolean;
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

export function shipCommand(issue: string, options: ShipOptions = { merge: false }): void {
  const issueStr = issue.replace(/^#/, '');

  let label = getCurrentLabel(issueStr);

  if (!label) {
    console.error(
      `Issue #${issueStr} has no shipper label. Run \`shipper next\` or add a label first.`
    );
    process.exit(1);
  }

  if (label === 'shipper:ready') {
    if (!options.merge) {
      console.log(`Issue #${issueStr} is already at shipper:ready.`);
      process.exit(0);
    }
    // Fall through to merge logic below the loop
  }

  if (label !== 'shipper:ready' && !(label in STAGE_NAME)) {
    console.error(`Unrecognized shipper label "${label}" on issue #${issueStr}.`);
    process.exit(1);
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
        process.exit(1);
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
        process.exit(1);
      }

      if (label === previousLabel) {
        console.error(
          `Label did not advance after stage "${stageName}" (still "${label}"). Aborting to avoid infinite loop.`
        );
        printSummary(results);
        process.exit(1);
      }

      if (label === 'shipper:pr-reviewed') {
        if (seenPrReviewed) {
          reviewCycles++;
          if (reviewCycles >= MAX_REVIEW_CYCLES) {
            console.error(
              `Review loop cap reached after ${MAX_REVIEW_CYCLES} cycles. Issue is at shipper:pr-reviewed. Continue manually.`
            );
            results.push({ stage: 'pr remediate', status: 'fail' });
            printSummary(results);
            process.exit(1);
          }
        }
        seenPrReviewed = true;
      }
    }
  }

  if (options.merge) {
    console.log('Running stage: merge');
    const issueNumber = Number(issueStr);
    const nwo = getRepoNwo();

    let pr: QueuedPR;
    try {
      pr = resolvePrForIssue(issueNumber, nwo);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      results.push({ stage: 'merge', status: 'fail' });
      printSummary(results);
      process.exit(1);
    }

    const merged = mergePr(pr, issueNumber, nwo);

    if (merged) {
      results.push({ stage: 'merge', status: 'pass' });
    } else {
      results.push({ stage: 'merge', status: 'fail' });
      printSummary(results);
      process.exit(1);
    }
  }

  printSummary(results);
  process.exit(0);
}
