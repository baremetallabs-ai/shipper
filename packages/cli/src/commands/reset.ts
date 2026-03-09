import { execFileSync } from 'node:child_process';
import { confirm, promptChoice } from '../lib/confirm.js';
import { gh } from '@dnsquared/shipper-core';
import { isLockStale } from '@dnsquared/shipper-core';
import { getRepoNwo } from '@dnsquared/shipper-core';

const WORKFLOW_STAGES = ['new', 'groomed', 'designed', 'planned', 'implemented'] as const;
const PR_STAGE_LABELS = ['shipper:pr-open', 'shipper:pr-reviewed', 'shipper:ready'] as const;
const NON_WORKFLOW_STAGE_NAMES = new Set(['blocked', 'locked', 'pr-open', 'pr-reviewed', 'ready']);

type WorkflowStage = (typeof WORKFLOW_STAGES)[number];

interface IssueViewData {
  number: number;
  state: string;
  labels: { name: string }[];
}

interface PREntry {
  number: number;
  headRefName: string;
}

interface ArtifactScan {
  labelsToRemove: string[];
  addTarget: boolean;
  targetStage: WorkflowStage;
  targetLabel: string;
  commentIds: number[];
  prs: PREntry[];
  branchesToDelete: string[];
}

interface CurrentStage {
  stage: WorkflowStage;
  hasPrLabels: boolean;
}

function getStageLabel(stage: WorkflowStage): string {
  return `shipper:${stage}`;
}

function getStageIndex(stage: WorkflowStage): number {
  return WORKFLOW_STAGES.indexOf(stage);
}

function parseStage(input: string): WorkflowStage | null {
  const normalized = input.replace(/^shipper:/, '');
  return WORKFLOW_STAGES.includes(normalized as WorkflowStage)
    ? (normalized as WorkflowStage)
    : null;
}

function getCurrentStage(labels: string[]): CurrentStage {
  const hasPrLabels = labels.some((label) =>
    PR_STAGE_LABELS.includes(label as (typeof PR_STAGE_LABELS)[number])
  );

  if (hasPrLabels) {
    return { stage: 'implemented', hasPrLabels: true };
  }

  for (let i = WORKFLOW_STAGES.length - 1; i >= 0; i -= 1) {
    const stage = WORKFLOW_STAGES[i];
    if (!stage) continue;
    if (labels.includes(getStageLabel(stage))) {
      return { stage, hasPrLabels };
    }
  }

  return { stage: 'new', hasPrLabels: false };
}

async function getStageTimestamp(
  issueNum: number,
  nwo: string,
  stage: WorkflowStage
): Promise<string | null> {
  try {
    const { stdout } = await gh([
      'api',
      `repos/${nwo}/issues/${issueNum}/timeline`,
      '--paginate',
      '--jq',
      `.[] | select(.event == "labeled" and .label.name? == "${getStageLabel(stage)}") | .created_at`,
    ]);
    const output = stdout.trim();

    if (!output) return null;

    const timestamps = output.split('\n').filter((line) => line.trim());
    if (timestamps.length === 0) return null;

    return timestamps[timestamps.length - 1] ?? null;
  } catch {
    return null;
  }
}

function getInvalidStageError(input: string): string {
  const normalized = input.replace(/^shipper:/, '');
  const validStages = WORKFLOW_STAGES.join(', ');

  if (NON_WORKFLOW_STAGE_NAMES.has(normalized)) {
    return `Error: ${input} is not a valid workflow stage. Valid stages: ${validStages}.`;
  }

  return `Error: ${input} is not a valid stage name. Valid stages: ${validStages}.`;
}

function getValidTargets(currentStage: CurrentStage): WorkflowStage[] {
  const currentIndex = getStageIndex(currentStage.stage);
  const targets = WORKFLOW_STAGES.slice(0, currentIndex);

  if (currentStage.hasPrLabels) {
    targets.push('implemented');
  }

  return targets;
}

async function scanArtifacts(
  issueNum: number,
  nwo: string,
  targetStage: WorkflowStage,
  labels: string[]
): Promise<ArtifactScan> {
  const targetIndex = getStageIndex(targetStage);
  const targetLabel = getStageLabel(targetStage);
  const labelsToRemove = labels.filter((label) => {
    if (targetStage === 'new') {
      return label.startsWith('shipper:') && label !== 'shipper:new';
    }

    if (PR_STAGE_LABELS.includes(label as (typeof PR_STAGE_LABELS)[number])) {
      return true;
    }

    if (!label.startsWith('shipper:')) {
      return false;
    }

    const labelStage = parseStage(label);
    return labelStage !== null && getStageIndex(labelStage) > targetIndex;
  });
  const addTarget = !labels.includes(targetLabel);

  let commentIds: number[] = [];
  if (targetStage === 'new') {
    try {
      const { stdout: raw } = await gh([
        'api',
        `repos/${nwo}/issues/${issueNum}/comments`,
        '--paginate',
        '--jq',
        '.[].id',
      ]);
      commentIds = raw
        .trim()
        .split('\n')
        .filter((line) => line !== '')
        .map(Number);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Warning: Could not fetch comments for issue #${issueNum}: ${msg}`);
    }
  } else {
    const stageTimestamp = await getStageTimestamp(issueNum, nwo, targetStage);
    if (stageTimestamp) {
      const cutoffDate = new Date(stageTimestamp);
      if (Number.isNaN(cutoffDate.getTime())) {
        console.warn(
          `Warning: Could not determine when ${targetLabel} was applied. Skipping comment cleanup.`
        );
      } else {
        const cutoff = cutoffDate.getTime() + 60_000;
        try {
          const { stdout: raw } = await gh([
            'api',
            `repos/${nwo}/issues/${issueNum}/comments`,
            '--paginate',
            '--jq',
            '.[] | {id, created_at}',
          ]);
          const lines = raw
            .trim()
            .split('\n')
            .filter((line) => line !== '');
          for (const line of lines) {
            const comment = JSON.parse(line) as { id: number; created_at: string };
            if (Date.parse(comment.created_at) > cutoff) {
              commentIds.push(comment.id);
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`Warning: Could not fetch comments for issue #${issueNum}: ${msg}`);
        }
      }
    } else {
      console.warn(
        `Warning: Could not determine when ${targetLabel} was applied. Skipping comment cleanup.`
      );
    }
  }

  let prs: PREntry[] = [];
  try {
    const { stdout: prJson } = await gh([
      'pr',
      'list',
      '--search',
      String(issueNum),
      '--state',
      'open',
      '--json',
      'number,headRefName',
    ]);
    const allPrs: PREntry[] = JSON.parse(prJson);
    prs = allPrs.filter(
      (pr) =>
        pr.headRefName === `shipper/${issueNum}` ||
        pr.headRefName.startsWith(`shipper/${issueNum}-`) ||
        pr.headRefName === `${issueNum}` ||
        pr.headRefName.startsWith(`${issueNum}-`)
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Warning: Could not fetch PRs for issue #${issueNum}: ${msg}`);
  }

  const branchesToDelete = prs
    .map((pr) => pr.headRefName)
    .filter((branchName) => branchName.startsWith('shipper/'));

  return {
    labelsToRemove,
    addTarget,
    targetStage,
    targetLabel,
    commentIds,
    prs,
    branchesToDelete,
  };
}

function isClean(scan: ArtifactScan): boolean {
  return (
    scan.labelsToRemove.length === 0 &&
    !scan.addTarget &&
    scan.commentIds.length === 0 &&
    scan.prs.length === 0 &&
    scan.branchesToDelete.length === 0
  );
}

function printDryRun(issueNum: number, scan: ArtifactScan): void {
  console.log(`\nReset summary for issue #${issueNum}:`);
  console.log(`  Target: ${scan.targetLabel}`);
  if (scan.labelsToRemove.length > 0) {
    console.log(`  Labels to remove: ${scan.labelsToRemove.join(', ')}`);
  }
  if (scan.addTarget) {
    console.log(`  Labels to add: ${scan.targetLabel}`);
  }
  if (scan.commentIds.length > 0) {
    console.log(`  Comments to delete: ${scan.commentIds.length}`);
  }
  if (scan.prs.length > 0) {
    console.log(`  PRs to close: ${scan.prs.map((pr) => `#${pr.number}`).join(', ')}`);
  }
  if (scan.branchesToDelete.length > 0) {
    console.log(`  Branches to delete: ${scan.branchesToDelete.join(', ')}`);
  }
  console.log('');
}

async function executeReset(issueNum: number, scan: ArtifactScan, nwo: string): Promise<void> {
  const actions: string[] = [];

  const closedPrBranches = new Set<string>();
  for (const pr of scan.prs) {
    try {
      await gh(['pr', 'close', String(pr.number)]);
      closedPrBranches.add(pr.headRefName);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  Warning: Failed to close PR #${pr.number}: ${msg}`);
    }
  }
  if (scan.prs.length > 0) {
    actions.push(`Closed PRs: ${scan.prs.map((pr) => `#${pr.number}`).join(', ')}`);
  }

  const deletableBranches = scan.branchesToDelete.filter((branchName) =>
    closedPrBranches.has(branchName)
  );
  for (const branch of deletableBranches) {
    try {
      execFileSync('git', ['push', 'origin', '--delete', branch], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  Warning: Failed to delete branch ${branch}: ${msg}`);
    }
  }
  if (deletableBranches.length > 0) {
    actions.push(`Deleted branches: ${deletableBranches.join(', ')}`);
  }

  for (const id of scan.commentIds) {
    try {
      await gh(['api', '-X', 'DELETE', `repos/${nwo}/issues/comments/${id}`]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  Warning: Failed to delete comment ${id}: ${msg}`);
    }
  }
  if (scan.commentIds.length > 0) {
    actions.push(`Deleted ${scan.commentIds.length} comment(s)`);
  }

  if (scan.labelsToRemove.length > 0 || scan.addTarget) {
    const args = ['issue', 'edit', String(issueNum)];
    if (scan.labelsToRemove.length > 0) {
      args.push('--remove-label', scan.labelsToRemove.join(','));
    }
    if (scan.addTarget) {
      args.push('--add-label', scan.targetLabel);
    }
    try {
      await gh(args);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  Warning: Failed to update labels: ${msg}`);
    }
  }
  if (scan.labelsToRemove.length > 0) {
    actions.push(`Removed labels: ${scan.labelsToRemove.join(', ')}`);
  }
  if (scan.addTarget) {
    actions.push(`Added label: ${scan.targetLabel}`);
  }

  let resetBody =
    `**This issue has been reset to \`${scan.targetLabel}\`.** ` +
    'Artifacts after this stage have been cleaned up.';
  if (scan.targetStage === 'new') {
    resetBody +=
      '\n\nAny remaining content in the issue body is from a previous workflow run ' +
      'and should be treated as a suggestion for the next grooming attempt, not as groomed or approved content.';
  }

  try {
    await gh(['issue', 'comment', String(issueNum), '--body', resetBody]);
    actions.push('Posted reset notice comment');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  Warning: Failed to post reset comment: ${msg}`);
  }

  console.log(`\nReset complete for issue #${issueNum}:`);
  for (const action of actions) {
    console.log(`  ✓ ${action}`);
  }
}

export async function resetCommand(
  issue: string,
  opts: { force: boolean; to?: string }
): Promise<void> {
  const cleaned = issue.replace(/^#/, '');
  if (!/^\d+$/.test(cleaned)) {
    console.error('Error: Please provide a valid issue number.');
    console.error('Usage: shipper reset <issue> [--to <stage>]');
    process.exit(1);
  }
  const issueNum = Number(cleaned);

  const nwo = await getRepoNwo();

  let issueJson: string;
  try {
    const result = await gh(['issue', 'view', String(issueNum), '--json', 'number,state,labels']);
    issueJson = result.stdout;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: Failed to fetch issue #${issueNum}: ${msg}`);
    process.exit(1);
  }

  const issueData: IssueViewData = JSON.parse(issueJson);

  if (issueData.state !== 'OPEN') {
    console.error(`Issue #${issueNum} is closed. Reset only works on open issues.`);
    process.exit(1);
  }

  const labels = issueData.labels.map((label) => label.name);

  if (!opts.force && labels.includes('shipper:locked')) {
    if (!(await isLockStale(String(issueNum)))) {
      console.error(
        `Issue #${issueNum} is locked by another shipper instance. Use --force to override.`
      );
      process.exit(1);
    }
  }

  const currentStage = getCurrentStage(labels);
  const currentIndex = getStageIndex(currentStage.stage);

  let targetStage: WorkflowStage;
  if (opts.to) {
    const parsedStage = parseStage(opts.to);
    if (!parsedStage) {
      console.error(getInvalidStageError(opts.to));
      process.exit(1);
    }

    const targetIndex = getStageIndex(parsedStage);
    const sameImplementedStage = currentStage.hasPrLabels && parsedStage === 'implemented';
    if (targetIndex === currentIndex && !sameImplementedStage) {
      console.error(
        `Error: Issue #${issueNum} is already at ${getStageLabel(parsedStage)}. Reset only works backward.`
      );
      process.exit(1);
    }
    if (targetIndex > currentIndex) {
      console.error(
        `Error: ${getStageLabel(parsedStage)} is ahead of the current stage ${getStageLabel(currentStage.stage)}. Reset only works backward.`
      );
      process.exit(1);
    }

    targetStage = parsedStage;
  } else {
    const validTargets = getValidTargets(currentStage);
    if (validTargets.length === 0) {
      console.error(
        `Error: Issue #${issueNum} is already at ${getStageLabel(currentStage.stage)}. Reset only works backward.`
      );
      process.exit(1);
    }

    console.log('\nReset targets:');
    for (const [index, stage] of validTargets.entries()) {
      console.log(`  ${index + 1}) ${stage}`);
    }

    const choiceNumbers = validTargets.map((_, index) => String(index + 1));
    const selection = await promptChoice(`Select [1-${validTargets.length}]: `, choiceNumbers);
    const selectedStage = validTargets[Number(selection) - 1];
    if (!selectedStage) {
      console.error('Error: Invalid reset target selected.');
      process.exit(1);
    }
    targetStage = selectedStage;
  }

  const scan = await scanArtifacts(issueNum, nwo, targetStage, labels);

  if (isClean(scan)) {
    console.log(
      `Issue #${issueNum} is already clean for target ${scan.targetLabel}. Nothing to reset.`
    );
    return;
  }

  printDryRun(issueNum, scan);

  if (!opts.force) {
    const proceed = await confirm('Proceed? (y/N): ');
    if (!proceed) {
      console.log('Reset cancelled.');
      return;
    }
  }

  await executeReset(issueNum, scan, nwo);
}
