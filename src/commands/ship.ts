import { execFileSync, spawnSync } from 'node:child_process';

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

  const shipperLabels = output.split('\n').filter((name) => name.startsWith('shipper:'));

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

export function shipCommand(issue: string): void {
  if (!issue) {
    console.error('Error: Please provide an issue number.');
    console.error('Usage: shipper ship <issue>');
    process.exit(1);
  }

  const issueStr = issue.replace(/^#/, '');

  let label = getCurrentLabel(issueStr);

  if (!label) {
    console.error(
      `Issue #${issueStr} has no shipper label. Run \`shipper next\` or add a label first.`
    );
    process.exit(1);
  }

  if (label === 'shipper:ready') {
    console.log(`Issue #${issueStr} is already at shipper:ready.`);
    process.exit(0);
  }

  if (!(label in STAGE_NAME)) {
    console.error(`Unrecognized shipper label "${label}" on issue #${issueStr}.`);
    process.exit(1);
  }

  const results: StageResult[] = [];
  let reviewCycles = 0;

  for (;;) {
    const stageName = STAGE_NAME[label]!;

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

    if (label === 'shipper:pr-reviewed') {
      reviewCycles++;
      if (reviewCycles >= MAX_REVIEW_CYCLES) {
        console.error(
          `Review loop cap reached after ${MAX_REVIEW_CYCLES} cycles. Issue is at shipper:pr-reviewed. Continue manually.`
        );
        printSummary(results);
        process.exit(1);
      }
    }
  }

  printSummary(results);
  process.exit(0);
}
