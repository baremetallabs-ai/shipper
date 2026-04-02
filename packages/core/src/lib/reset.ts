import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { toErrorMessage } from './errors.js';
import {
  FAILED_LABEL,
  IMPLEMENTED_LABEL,
  PRIORITY_LABEL_NAMES,
  STAGE_LABEL_NAMES,
} from './labels.js';
import { gh } from './gh.js';
import { logger } from './logger.js';
import { removeWorktree } from './worktree.js';

const IMPLEMENTED_STAGE_INDEX = STAGE_LABEL_NAMES.indexOf(IMPLEMENTED_LABEL);
const RESETTABLE_STAGE_LABELS = STAGE_LABEL_NAMES.slice(0, IMPLEMENTED_STAGE_INDEX + 1);
const POST_IMPLEMENTATION_STAGE_LABELS = STAGE_LABEL_NAMES.slice(IMPLEMENTED_STAGE_INDEX + 1);
const RESETTABLE_STAGE_NAMES = RESETTABLE_STAGE_LABELS.map((label) =>
  label.replace(/^shipper:/, '')
);

type ErrnoError = Error & { code?: string };

export type WorkflowStage = 'new' | 'groomed' | 'designed' | 'planned' | 'implemented';

export interface PREntry {
  number: number;
  headRefName: string;
}

export interface ArtifactScan {
  labelsToRemove: string[];
  addTarget: boolean;
  targetStage: WorkflowStage;
  targetLabel: string;
  commentIds: number[];
  prs: PREntry[];
  branchesToDelete: string[];
  localBranches: string[];
  localWorktrees: string[];
}

export interface CurrentStage {
  stage: WorkflowStage;
  hasPrLabels: boolean;
}

export interface ScanArtifactsOptions {
  repoRoot?: string;
  repoName: string;
}

export interface ExecuteResetOptions {
  repoRoot?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePrEntries(json: string): PREntry[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    throw new Error('GitHub CLI returned an invalid PR list payload.');
  }

  return parsed.map((entry) => {
    if (
      !isPlainObject(entry) ||
      typeof entry.number !== 'number' ||
      typeof entry.headRefName !== 'string'
    ) {
      throw new Error('GitHub CLI returned an invalid PR entry.');
    }

    return { number: entry.number, headRefName: entry.headRefName };
  });
}

function parseMatchingRefs(json: string): string[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    throw new Error('GitHub CLI returned an invalid matching refs payload.');
  }

  return parsed.map((entry) => {
    if (!isPlainObject(entry) || typeof entry.ref !== 'string') {
      throw new Error('GitHub CLI returned an invalid matching ref entry.');
    }

    return entry.ref;
  });
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

    if (!output) {
      return null;
    }

    const timestamps = output.split('\n').filter((line) => line.trim());
    if (timestamps.length === 0) {
      return null;
    }

    return timestamps[timestamps.length - 1] ?? null;
  } catch {
    logger.warn(`Failed to fetch stage timestamp for issue #${issueNum}`);
    return null;
  }
}

export function getStageLabel(stage: WorkflowStage): string {
  return `shipper:${stage}`;
}

export function getStageIndex(stage: WorkflowStage): number {
  return RESETTABLE_STAGE_NAMES.indexOf(stage);
}

export function parseStage(input: string): WorkflowStage | null {
  const normalized = input.replace(/^shipper:/, '');
  return RESETTABLE_STAGE_NAMES.includes(normalized as WorkflowStage)
    ? (normalized as WorkflowStage)
    : null;
}

export function getCurrentStage(labels: string[]): CurrentStage {
  const hasPrLabels = labels.some((label) => POST_IMPLEMENTATION_STAGE_LABELS.includes(label));

  if (hasPrLabels) {
    return { stage: 'implemented', hasPrLabels: true };
  }

  for (let index = RESETTABLE_STAGE_NAMES.length - 1; index >= 0; index -= 1) {
    const stage = RESETTABLE_STAGE_NAMES[index] as WorkflowStage | undefined;
    if (!stage) {
      continue;
    }

    if (labels.includes(getStageLabel(stage))) {
      return { stage, hasPrLabels };
    }
  }

  return { stage: 'new', hasPrLabels: false };
}

export function getValidTargets(currentStage: CurrentStage): WorkflowStage[] {
  const currentIndex = getStageIndex(currentStage.stage);
  const targets = RESETTABLE_STAGE_NAMES.slice(0, currentIndex) as WorkflowStage[];

  if (currentStage.hasPrLabels) {
    targets.push('implemented');
  }

  return targets;
}

export async function scanArtifacts(
  issueNum: number,
  nwo: string,
  targetStage: WorkflowStage,
  labels: string[],
  options: ScanArtifactsOptions
): Promise<ArtifactScan> {
  const targetIndex = getStageIndex(targetStage);
  const targetLabel = getStageLabel(targetStage);
  const labelsToRemove = labels.filter((label) => {
    if (PRIORITY_LABEL_NAMES.includes(label)) {
      return false;
    }

    if (targetStage === 'new') {
      return label.startsWith('shipper:') && label !== targetLabel;
    }

    if (POST_IMPLEMENTATION_STAGE_LABELS.includes(label)) {
      return true;
    }

    if (!label.startsWith('shipper:')) {
      return false;
    }

    const labelStage = parseStage(label);
    return labelStage !== null && getStageIndex(labelStage) > targetIndex;
  });

  if (labels.includes(FAILED_LABEL) && !labelsToRemove.includes(FAILED_LABEL)) {
    labelsToRemove.push(FAILED_LABEL);
  }

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
    } catch (error) {
      logger.warn(
        `Warning: Could not fetch comments for issue #${issueNum}: ${toErrorMessage(error)}`
      );
    }
  } else {
    const stageTimestamp = await getStageTimestamp(issueNum, nwo, targetStage);
    if (stageTimestamp) {
      const cutoffDate = new Date(stageTimestamp);
      if (Number.isNaN(cutoffDate.getTime())) {
        logger.warn(
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
        } catch (error) {
          logger.warn(
            `Warning: Could not fetch comments for issue #${issueNum}: ${toErrorMessage(error)}`
          );
        }
      }
    } else {
      logger.warn(
        `Warning: Could not determine when ${targetLabel} was applied. Skipping comment cleanup.`
      );
    }
  }

  let prs: PREntry[] = [];
  try {
    const { stdout: prJson } = await gh([
      'pr',
      'list',
      '-R',
      nwo,
      '--search',
      String(issueNum),
      '--state',
      'open',
      '--json',
      'number,headRefName',
    ]);
    const allPrs = parsePrEntries(prJson);
    prs = allPrs.filter(
      (pr) =>
        pr.headRefName === `shipper/${issueNum}` ||
        pr.headRefName.startsWith(`shipper/${issueNum}-`) ||
        pr.headRefName === `${issueNum}` ||
        pr.headRefName.startsWith(`${issueNum}-`)
    );
  } catch (error) {
    logger.warn(`Warning: Could not fetch PRs for issue #${issueNum}: ${toErrorMessage(error)}`);
  }

  let remoteBranches: string[] = [];
  if (targetStage !== 'implemented') {
    if (options.repoRoot) {
      try {
        execFileSync('git', ['fetch', 'origin', '--prune'], {
          cwd: options.repoRoot,
          stdio: ['ignore', 'ignore', 'ignore'],
        });
      } catch (error) {
        logger.warn(
          `Warning: Could not fetch remote branches for issue #${issueNum}: ${toErrorMessage(error)}`
        );
      }

      try {
        const raw = execFileSync(
          'git',
          ['branch', '-r', '--list', `origin/shipper/${issueNum}`, `origin/shipper/${issueNum}-*`],
          {
            cwd: options.repoRoot,
            encoding: 'utf-8',
          }
        );
        remoteBranches = raw
          .split('\n')
          .map((line) => line.trim())
          .filter((branchName) => branchName !== '')
          .map((branchName) => branchName.replace(/^origin\//, ''));
      } catch (error) {
        logger.warn(
          `Warning: Could not scan remote branches for issue #${issueNum}: ${toErrorMessage(error)}`
        );
      }
    } else {
      try {
        const { stdout: refsJson } = await gh([
          'api',
          `repos/${nwo}/git/matching-refs/heads/shipper/${issueNum}`,
        ]);
        remoteBranches = parseMatchingRefs(refsJson)
          .map((ref) => ref.replace(/^refs\/heads\//, ''))
          .filter(
            (branchName) =>
              branchName === `shipper/${issueNum}` || branchName.startsWith(`shipper/${issueNum}-`)
          );
      } catch (error) {
        logger.warn(
          `Warning: Could not scan remote branches for issue #${issueNum}: ${toErrorMessage(error)}`
        );
      }
    }
  }

  const prBranches = prs
    .map((pr) => pr.headRefName)
    .filter((branchName) => branchName.startsWith('shipper/'));
  const branchesToDelete =
    targetStage === 'implemented' ? [] : [...new Set([...prBranches, ...remoteBranches])];

  const worktreesRoot = path.join(homedir(), '.shipper', 'worktrees');
  let localWorktrees: string[] = [];
  try {
    const entries = readdirSync(worktreesRoot, { withFileTypes: true });
    localWorktrees = entries
      .filter((entry) => {
        if (!entry.isDirectory()) {
          return false;
        }

        return (
          entry.name === `${options.repoName}--wt--shipper-${issueNum}` ||
          entry.name.startsWith(`${options.repoName}--wt--shipper-${issueNum}-`)
        );
      })
      .map((entry) => path.join(worktreesRoot, entry.name));
  } catch (error) {
    const errnoError = error as ErrnoError;
    if (errnoError.code !== 'ENOENT') {
      logger.warn(
        `Warning: Could not scan local worktrees for issue #${issueNum}: ${toErrorMessage(error)}`
      );
    }
  }

  let localBranches: string[] = [];
  if (targetStage !== 'implemented' && options.repoRoot) {
    try {
      const raw = execFileSync(
        'git',
        ['branch', '--list', `shipper/${issueNum}`, `shipper/${issueNum}-*`],
        {
          cwd: options.repoRoot,
          encoding: 'utf-8',
        }
      );
      localBranches = raw
        .split('\n')
        .map((line) =>
          line
            .trim()
            .replace(/^[*+]\s*/, '')
            .trim()
        )
        .filter((branchName) => branchName !== '');
    } catch (error) {
      logger.warn(
        `Warning: Could not scan local branches for issue #${issueNum}: ${toErrorMessage(error)}`
      );
    }

    if (localBranches.length > 0) {
      try {
        const currentBranch = execFileSync('git', ['branch', '--show-current'], {
          cwd: options.repoRoot,
          encoding: 'utf-8',
        }).trim();

        if (currentBranch && localBranches.includes(currentBranch)) {
          logger.warn(
            `Warning: Skipping local branch ${currentBranch} because it is currently checked out.`
          );
          localBranches = localBranches.filter((branchName) => branchName !== currentBranch);
        }
      } catch (error) {
        logger.warn(
          `Warning: Could not determine the current branch for issue #${issueNum}: ${toErrorMessage(error)}`
        );
        logger.warn(
          'Warning: Skipping local branch deletion because the checked-out branch is unknown.'
        );
        localBranches = [];
      }
    }
  }

  return {
    labelsToRemove,
    addTarget,
    targetStage,
    targetLabel,
    commentIds,
    prs,
    branchesToDelete,
    localBranches,
    localWorktrees,
  };
}

export function isClean(scan: ArtifactScan): boolean {
  return (
    scan.labelsToRemove.length === 0 &&
    !scan.addTarget &&
    scan.commentIds.length === 0 &&
    scan.prs.length === 0 &&
    scan.branchesToDelete.length === 0 &&
    scan.localBranches.length === 0 &&
    scan.localWorktrees.length === 0
  );
}

export async function executeReset(
  issueNum: number,
  scan: ArtifactScan,
  nwo: string,
  options: ExecuteResetOptions = {}
): Promise<void> {
  const actions: string[] = [];

  const removedWorktrees: string[] = [];
  for (const worktreePath of scan.localWorktrees) {
    try {
      if (options.repoRoot) {
        await removeWorktree(options.repoRoot, worktreePath);
      } else {
        await rm(worktreePath, { recursive: true, force: true });
      }

      if (existsSync(worktreePath)) {
        logger.warn(`  Warning: Failed to remove local worktree ${worktreePath}.`);
        continue;
      }

      removedWorktrees.push(worktreePath);
    } catch (error) {
      logger.warn(
        `  Warning: Failed to remove local worktree ${worktreePath}: ${toErrorMessage(error)}`
      );
    }
  }
  if (removedWorktrees.length > 0) {
    actions.push(`Removed local worktrees: ${removedWorktrees.join(', ')}`);
  }

  const deletedLocalBranches: string[] = [];
  if (options.repoRoot) {
    for (const branch of scan.localBranches) {
      try {
        execFileSync('git', ['branch', '-D', branch], {
          cwd: options.repoRoot,
          stdio: ['ignore', 'ignore', 'ignore'],
        });
        deletedLocalBranches.push(branch);
      } catch (error) {
        logger.warn(`  Warning: Failed to delete local branch ${branch}: ${toErrorMessage(error)}`);
      }
    }
  }
  if (deletedLocalBranches.length > 0) {
    actions.push(`Deleted local branches: ${deletedLocalBranches.join(', ')}`);
  }

  const closedPrBranches = new Set<string>();
  for (const pr of scan.prs) {
    try {
      await gh(['pr', 'close', String(pr.number), '-R', nwo]);
      closedPrBranches.add(pr.headRefName);
    } catch (error) {
      logger.warn(`  Warning: Failed to close PR #${pr.number}: ${toErrorMessage(error)}`);
    }
  }
  if (scan.prs.length > 0) {
    actions.push(`Closed PRs: ${scan.prs.map((pr) => `#${pr.number}`).join(', ')}`);
  }

  const prBranches = new Set(scan.prs.map((pr) => pr.headRefName));
  const deletableBranches: string[] = [];
  for (const branchName of scan.branchesToDelete) {
    if (closedPrBranches.has(branchName)) {
      deletableBranches.push(branchName);
      continue;
    }

    if (prBranches.has(branchName)) {
      continue;
    }

    try {
      const { stdout: prJson } = await gh([
        'pr',
        'list',
        '-R',
        nwo,
        '--head',
        branchName,
        '--state',
        'open',
        '--json',
        'number,headRefName',
      ]);
      const branchPrs = parsePrEntries(prJson).filter((pr) => pr.headRefName === branchName);
      if (branchPrs.length === 0) {
        deletableBranches.push(branchName);
        continue;
      }

      logger.warn(
        `  Warning: Skipping branch ${branchName} because it still has an open PR: ${branchPrs
          .map((pr) => `#${pr.number}`)
          .join(', ')}`
      );
    } catch (error) {
      logger.warn(
        `  Warning: Could not verify open PR state for branch ${branchName}: ${toErrorMessage(error)}`
      );
    }
  }
  for (const branch of deletableBranches) {
    try {
      await gh(['api', '-X', 'DELETE', `repos/${nwo}/git/refs/heads/${branch}`]);
    } catch (error) {
      logger.warn(`  Warning: Failed to delete branch ${branch}: ${toErrorMessage(error)}`);
    }
  }
  if (deletableBranches.length > 0) {
    actions.push(`Deleted remote branches: ${deletableBranches.join(', ')}`);
  }

  for (const commentId of scan.commentIds) {
    try {
      await gh(['api', '-X', 'DELETE', `repos/${nwo}/issues/comments/${commentId}`]);
    } catch (error) {
      logger.warn(`  Warning: Failed to delete comment ${commentId}: ${toErrorMessage(error)}`);
    }
  }
  if (scan.commentIds.length > 0) {
    actions.push(`Deleted ${scan.commentIds.length} comment(s)`);
  }

  if (scan.labelsToRemove.length > 0 || scan.addTarget) {
    const args = ['issue', 'edit', String(issueNum), '-R', nwo];
    if (scan.labelsToRemove.length > 0) {
      args.push('--remove-label', scan.labelsToRemove.join(','));
    }
    if (scan.addTarget) {
      args.push('--add-label', scan.targetLabel);
    }

    try {
      await gh(args);
    } catch (error) {
      logger.warn(`  Warning: Failed to update labels: ${toErrorMessage(error)}`);
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
    await gh(['issue', 'comment', String(issueNum), '-R', nwo, '--body', resetBody]);
    actions.push('Posted reset notice comment');
  } catch (error) {
    logger.warn(`  Warning: Failed to post reset comment: ${toErrorMessage(error)}`);
  }

  logger.log(`\nReset complete for issue #${issueNum}:`);
  for (const action of actions) {
    logger.log(`  ✓ ${action}`);
  }
}
