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
import { parseCommentIdCreatedAt, parseMatchingRefs, parsePrSummaryList } from './gh-schemas.js';
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

export type ResetOpStatus = 'succeeded' | 'failed' | 'skipped';

export interface ResetOpResult {
  description: string;
  status: ResetOpStatus;
  reason?: string;
}

export interface ResetResult {
  operations: ResetOpResult[];
  hasFailures: boolean;
}

function hasMessageMatch(error: unknown, patterns: string[]): boolean {
  const message = toErrorMessage(error).toLowerCase();
  return patterns.some((pattern) => message.includes(pattern.toLowerCase()));
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

export function getWorktreeRepoName(repoRoot: string): string {
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
        let raw = '';
        try {
          const { stdout } = await gh([
            'api',
            `repos/${nwo}/issues/${issueNum}/comments`,
            '--paginate',
            '--jq',
            '.[] | {id, created_at}',
          ]);
          raw = stdout;
        } catch (error) {
          logger.warn(
            `Warning: Could not fetch comments for issue #${issueNum}: ${toErrorMessage(error)}`
          );
        }

        const lines = raw
          .trim()
          .split('\n')
          .filter((line) => line !== '');
        for (const line of lines) {
          const comment = parseCommentIdCreatedAt(line);
          if (Date.parse(comment.created_at) > cutoff) {
            commentIds.push(comment.id);
          }
        }
      }
    } else {
      logger.warn(
        `Warning: Could not determine when ${targetLabel} was applied. Skipping comment cleanup.`
      );
    }
  }

  let prs: PREntry[] = [];
  let prJson = '';
  try {
    const { stdout } = await gh([
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
    prJson = stdout;
  } catch (error) {
    logger.warn(`Warning: Could not fetch PRs for issue #${issueNum}: ${toErrorMessage(error)}`);
  }
  const allPrs = parsePrSummaryList(prJson);
  prs = allPrs.filter(
    (pr) =>
      pr.headRefName === `shipper/${issueNum}` ||
      pr.headRefName.startsWith(`shipper/${issueNum}-`) ||
      pr.headRefName === `${issueNum}` ||
      pr.headRefName.startsWith(`${issueNum}-`)
  );

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
      let refsJson = '';
      try {
        const { stdout } = await gh([
          'api',
          `repos/${nwo}/git/matching-refs/heads/shipper/${issueNum}`,
        ]);
        refsJson = stdout;
      } catch (error) {
        logger.warn(
          `Warning: Could not scan remote branches for issue #${issueNum}: ${toErrorMessage(error)}`
        );
      }
      remoteBranches = parseMatchingRefs(refsJson)
        .map((entry) => entry.ref.replace(/^refs\/heads\//, ''))
        .filter(
          (branchName) =>
            branchName === `shipper/${issueNum}` || branchName.startsWith(`shipper/${issueNum}-`)
        );
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
): Promise<ResetResult> {
  const operations: ResetOpResult[] = [];
  const recordOperation = (description: string, status: ResetOpStatus, reason?: string): void => {
    operations.push(reason ? { description, status, reason } : { description, status });
  };

  for (const worktreePath of scan.localWorktrees) {
    const description = `Remove local worktree ${worktreePath}`;

    if (!existsSync(worktreePath)) {
      recordOperation(description, 'skipped', 'already removed');
      continue;
    }

    try {
      if (options.repoRoot) {
        await removeWorktree(options.repoRoot, worktreePath);
      } else {
        await rm(worktreePath, { recursive: true, force: true });
      }
    } catch (error) {
      recordOperation(description, 'failed', toErrorMessage(error));
      continue;
    }

    if (existsSync(worktreePath)) {
      recordOperation(description, 'failed', 'worktree still exists after removal');
      continue;
    }

    recordOperation(description, 'succeeded');
  }

  if (options.repoRoot) {
    // Clear stale worktree registrations whose directories were already removed.
    // Without this, git branch -D refuses to delete branches that still have a
    // worktree entry even though the directory no longer exists.
    try {
      execFileSync('git', ['worktree', 'prune'], {
        cwd: options.repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      logger.warn(`Warning: git worktree prune failed: ${toErrorMessage(error)}`);
    }

    for (const branch of scan.localBranches) {
      const description = `Delete local branch ${branch}`;

      try {
        execFileSync('git', ['branch', '-D', branch], {
          cwd: options.repoRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        recordOperation(description, 'succeeded');
      } catch (error) {
        if (hasMessageMatch(error, ['not found'])) {
          recordOperation(description, 'skipped', 'already deleted');
          continue;
        }

        recordOperation(description, 'failed', toErrorMessage(error));
      }
    }
  }

  const closedPrBranches = new Set<string>();
  const prNumbersByBranch = new Map(scan.prs.map((pr) => [pr.headRefName, pr.number]));
  for (const pr of scan.prs) {
    const description = `Close PR #${pr.number}`;

    try {
      await gh(['pr', 'close', String(pr.number), '-R', nwo]);
      closedPrBranches.add(pr.headRefName);
      recordOperation(description, 'succeeded');
    } catch (error) {
      if (hasMessageMatch(error, ['already closed'])) {
        closedPrBranches.add(pr.headRefName);
        recordOperation(description, 'skipped', 'already closed');
        continue;
      }

      recordOperation(description, 'failed', toErrorMessage(error));
    }
  }

  const prBranches = new Set(scan.prs.map((pr) => pr.headRefName));
  for (const branchName of scan.branchesToDelete) {
    const description = `Delete remote branch ${branchName}`;

    if (closedPrBranches.has(branchName)) {
      // Safe to delete because the matching PR was closed in this run or was already closed.
    } else if (prBranches.has(branchName)) {
      const prNumber = prNumbersByBranch.get(branchName);
      const reason = prNumber
        ? `blocked because PR #${prNumber} could not be closed`
        : 'blocked because the associated PR could not be closed';
      recordOperation(description, 'failed', reason);
      continue;
    } else {
      let prJson = '';
      try {
        const { stdout } = await gh([
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
        prJson = stdout;
      } catch (error) {
        recordOperation(
          description,
          'failed',
          `could not verify open PR state: ${toErrorMessage(error)}`
        );
        continue;
      }

      const branchPrs = parsePrSummaryList(prJson).filter((pr) => pr.headRefName === branchName);
      if (branchPrs.length > 0) {
        recordOperation(
          description,
          'failed',
          `still has an open PR: ${branchPrs.map((pr) => `#${pr.number}`).join(', ')}`
        );
        continue;
      }
    }

    try {
      await gh(['api', '-X', 'DELETE', `repos/${nwo}/git/refs/heads/${branchName}`]);
      recordOperation(description, 'succeeded');
    } catch (error) {
      if (hasMessageMatch(error, ['not found', 'reference does not exist'])) {
        recordOperation(description, 'skipped', 'already deleted');
        continue;
      }

      recordOperation(description, 'failed', toErrorMessage(error));
    }
  }

  for (const commentId of scan.commentIds) {
    const description = `Delete comment ${commentId}`;

    try {
      await gh(['api', '-X', 'DELETE', `repos/${nwo}/issues/comments/${commentId}`]);
      recordOperation(description, 'succeeded');
    } catch (error) {
      if (hasMessageMatch(error, ['not found', '404'])) {
        recordOperation(description, 'skipped', 'already deleted');
        continue;
      }

      recordOperation(description, 'failed', toErrorMessage(error));
    }
  }

  if (scan.labelsToRemove.length > 0 || scan.addTarget) {
    const args = ['issue', 'edit', String(issueNum), '-R', nwo];
    const descriptions: string[] = [];

    if (scan.labelsToRemove.length > 0) {
      args.push('--remove-label', scan.labelsToRemove.join(','));
      descriptions.push(`Remove labels: ${scan.labelsToRemove.join(', ')}`);
    }
    if (scan.addTarget) {
      args.push('--add-label', scan.targetLabel);
      descriptions.push(`Add label: ${scan.targetLabel}`);
    }

    try {
      await gh(args);
      for (const description of descriptions) {
        recordOperation(description, 'succeeded');
      }
    } catch (error) {
      const reason = toErrorMessage(error);
      for (const description of descriptions) {
        recordOperation(description, 'failed', reason);
      }
    }
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
    recordOperation('Post reset notice comment', 'succeeded');
  } catch (error) {
    recordOperation('Post reset notice comment', 'failed', toErrorMessage(error));
  }

  return {
    operations,
    hasFailures: operations.some((operation) => operation.status === 'failed'),
  };
}
