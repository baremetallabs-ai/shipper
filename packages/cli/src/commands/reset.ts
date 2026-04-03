import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { confirm, promptChoice } from '../lib/confirm.js';
import {
  logger,
  BLOCKED_LABEL,
  FAILED_LABEL,
  IMPLEMENTED_LABEL,
  LOCKED_LABEL,
  STAGE_LABEL_NAMES,
  executeReset,
  getCurrentStage,
  getRepoNwo,
  getRepoRoot,
  getStageIndex,
  getStageLabel,
  getValidTargets,
  gh,
  isPlainObject,
  isClean,
  isLockStale,
  parseStage,
  scanArtifacts,
  toErrorMessage,
  type ResetResult,
  type WorkflowStage,
} from '@dnsquared/shipper-core';

const IMPLEMENTED_STAGE_INDEX = STAGE_LABEL_NAMES.indexOf(IMPLEMENTED_LABEL);
const RESETTABLE_STAGE_LABELS = STAGE_LABEL_NAMES.slice(0, IMPLEMENTED_STAGE_INDEX + 1);
const POST_IMPLEMENTATION_STAGE_LABELS = STAGE_LABEL_NAMES.slice(IMPLEMENTED_STAGE_INDEX + 1);
const RESETTABLE_STAGE_NAMES = RESETTABLE_STAGE_LABELS.map((label) =>
  label.replace(/^shipper:/, '')
);
const NON_RESETTABLE_STAGE_NAMES = new Set(
  [BLOCKED_LABEL, LOCKED_LABEL, ...POST_IMPLEMENTATION_STAGE_LABELS].map((label) =>
    label.replace(/^shipper:/, '')
  )
);

interface IssueViewData {
  number: number;
  state: string;
  labels: { name: string }[];
}

function parseIssueViewData(json: string): IssueViewData {
  const parsed: unknown = JSON.parse(json);
  if (
    !isPlainObject(parsed) ||
    typeof parsed.number !== 'number' ||
    typeof parsed.state !== 'string' ||
    !Array.isArray(parsed.labels)
  ) {
    throw new Error('GitHub CLI returned an invalid issue payload.');
  }

  return {
    number: parsed.number,
    state: parsed.state,
    labels: parsed.labels.map((label) => {
      if (!isPlainObject(label) || typeof label.name !== 'string') {
        throw new Error('GitHub CLI returned an invalid issue label.');
      }

      return { name: label.name };
    }),
  };
}

function getInvalidStageError(input: string): string {
  const normalized = input.replace(/^shipper:/, '');
  const validStages = RESETTABLE_STAGE_NAMES.join(', ');

  if (NON_RESETTABLE_STAGE_NAMES.has(normalized)) {
    return `Error: ${input} is not a valid workflow stage. Valid stages: ${validStages}.`;
  }

  return `Error: ${input} is not a valid stage name. Valid stages: ${validStages}.`;
}

function getWorktreeRepoName(repoRoot: string): string {
  try {
    const gitCommonDirOutput = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: repoRoot,
      encoding: 'utf-8',
    }).trim();

    if (gitCommonDirOutput) {
      const gitCommonDir = path.isAbsolute(gitCommonDirOutput)
        ? gitCommonDirOutput
        : path.resolve(repoRoot, gitCommonDirOutput);
      const repoName = path.basename(path.dirname(gitCommonDir));
      if (repoName) {
        return repoName;
      }
    }
  } catch {
    // Fall back to the current repo root basename if git common-dir lookup fails.
  }

  return path.basename(repoRoot);
}

function printDryRun(issueNum: number, scan: Awaited<ReturnType<typeof scanArtifacts>>): void {
  logger.log(`\nReset summary for issue #${issueNum}:`);
  logger.log(`  Target: ${scan.targetLabel}`);
  if (scan.labelsToRemove.length > 0) {
    logger.log(`  Labels to remove: ${scan.labelsToRemove.join(', ')}`);
  }
  if (scan.addTarget) {
    logger.log(`  Labels to add: ${scan.targetLabel}`);
  }
  if (scan.commentIds.length > 0) {
    logger.log(`  Comments to delete: ${scan.commentIds.length}`);
  }
  if (scan.prs.length > 0) {
    logger.log(`  PRs to close: ${scan.prs.map((pr) => `#${pr.number}`).join(', ')}`);
  }
  if (scan.branchesToDelete.length > 0) {
    logger.log(`  Remote branches to delete: ${scan.branchesToDelete.join(', ')}`);
  }
  if (scan.localWorktrees.length > 0) {
    logger.log(`  Local worktrees to remove: ${scan.localWorktrees.join(', ')}`);
  }
  if (scan.localBranches.length > 0) {
    logger.log(`  Local branches to delete: ${scan.localBranches.join(', ')}`);
  }
  logger.log('');
}

function printResetResult(issueNum: number, result: ResetResult): void {
  logger.log(`\nReset complete for issue #${issueNum}:`);
  for (const operation of result.operations) {
    if (operation.status === 'succeeded') {
      logger.log(`  ✓ ${operation.description}`);
      continue;
    }

    const reason = operation.reason ?? 'unknown reason';

    if (operation.status === 'failed') {
      logger.log(`  ✗ ${operation.description}: ${reason}`);
      continue;
    }

    logger.log(`  — ${operation.description} (${reason})`);
  }
}

export async function resetCommand(
  issue: string,
  opts: { force: boolean; to?: string }
): Promise<void> {
  const cleaned = issue.replace(/^#/, '');
  if (!/^\d+$/.test(cleaned)) {
    logger.error('Usage: shipper reset <issue> [--to <stage>]');
    throw new Error('Error: Please provide a valid issue number.');
  }
  const issueNum = Number(cleaned);

  const nwo = await getRepoNwo();
  const repoRoot = await getRepoRoot();
  const repoName = getWorktreeRepoName(repoRoot);

  let issueJson: string;
  try {
    const result = await gh([
      'issue',
      'view',
      String(issueNum),
      '-R',
      nwo,
      '--json',
      'number,state,labels',
    ]);
    issueJson = result.stdout;
  } catch (error) {
    throw new Error(`Error: Failed to fetch issue #${issueNum}: ${toErrorMessage(error)}`);
  }

  const issueData = parseIssueViewData(issueJson);

  if (issueData.state !== 'OPEN') {
    throw new Error(`Issue #${issueNum} is closed. Reset only works on open issues.`);
  }

  const labels = issueData.labels.map((label) => label.name);

  if (!opts.force && labels.includes(LOCKED_LABEL)) {
    if (!(await isLockStale(nwo, String(issueNum)))) {
      throw new Error(
        `Issue #${issueNum} is locked by another shipper instance. Use --force to override.`
      );
    }
  }

  const currentStage = getCurrentStage(labels);
  const currentIndex = getStageIndex(currentStage.stage);
  const isFailedOnly =
    labels.includes(FAILED_LABEL) && !labels.some((l) => STAGE_LABEL_NAMES.includes(l));

  let targetStage: WorkflowStage;
  if (opts.to) {
    const parsedStage = parseStage(opts.to);
    if (!parsedStage) {
      throw new Error(getInvalidStageError(opts.to));
    }

    if (!isFailedOnly) {
      const targetIndex = getStageIndex(parsedStage);
      const sameImplementedStage = currentStage.hasPrLabels && parsedStage === 'implemented';
      if (targetIndex === currentIndex && !sameImplementedStage) {
        throw new Error(
          `Error: Issue #${issueNum} is already at ${getStageLabel(parsedStage)}. Reset only works backward.`
        );
      }
      if (targetIndex > currentIndex) {
        throw new Error(
          `Error: ${getStageLabel(parsedStage)} is ahead of the current stage ${getStageLabel(currentStage.stage)}. Reset only works backward.`
        );
      }
    }

    targetStage = parsedStage;
  } else {
    const validTargets = isFailedOnly
      ? ([...RESETTABLE_STAGE_NAMES] as WorkflowStage[])
      : getValidTargets(currentStage);
    if (validTargets.length === 0) {
      throw new Error(
        `Error: Issue #${issueNum} is already at ${getStageLabel(currentStage.stage)}. Reset only works backward.`
      );
    }

    logger.log('\nReset targets:');
    for (const [index, stage] of validTargets.entries()) {
      logger.log(`  ${index + 1}) ${stage}`);
    }

    const choiceNumbers = validTargets.map((_, index) => String(index + 1));
    const selection = await promptChoice(`Select [1-${validTargets.length}]: `, choiceNumbers);
    const selectedStage = validTargets[Number(selection) - 1];
    if (!selectedStage) {
      throw new Error('Error: Invalid reset target selected.');
    }
    targetStage = selectedStage;
  }

  const scan = await scanArtifacts(issueNum, nwo, targetStage, labels, {
    repoRoot,
    repoName,
  });

  if (isClean(scan)) {
    logger.log(
      `Issue #${issueNum} is already clean for target ${scan.targetLabel}. Nothing to reset.`
    );
    return;
  }

  printDryRun(issueNum, scan);

  if (!opts.force) {
    const proceed = await confirm('Proceed? (y/N): ');
    if (!proceed) {
      logger.log('Reset cancelled.');
      return;
    }
  }

  const result = await executeReset(issueNum, scan, nwo, { repoRoot });
  printResetResult(issueNum, result);

  if (result.hasFailures) {
    logger.log('\nSome operations failed. Re-run the command to retry failed operations.');
    process.exitCode = 1;
  }
}
