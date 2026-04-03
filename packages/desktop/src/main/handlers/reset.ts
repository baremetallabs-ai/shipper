import { ipcMain } from 'electron';
import {
  acquireIssueLock,
  executeReset,
  getCurrentStage,
  getStageIndex,
  getStageLabel,
  getValidTargets,
  isLockStale,
  LOCKED_LABEL,
  parseStage,
  releaseIssueLock,
  scanArtifacts,
  toErrorMessage,
  type WorkflowStage,
} from '@dnsquared/shipper-core';

import { isPositiveInteger, loadResetIssue, parseRepo, type RawResetIssueData } from './shared.js';

interface ResetIssuePayload {
  repo: string;
  issueNumber: number;
  targetStage: WorkflowStage;
}

interface ArtifactScanSummary {
  targetStage: WorkflowStage;
  targetLabel: string;
  labelsToRemove: string[];
  addTarget: boolean;
  prs: Array<{ number: number; headRefName: string }>;
  branchesToDelete: string[];
  localBranches: string[];
  localWorktrees: string[];
  commentCount: number;
}

function parseResetIssuePayload(value: unknown): ResetIssuePayload | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('repo' in value) ||
    !('issueNumber' in value) ||
    !('targetStage' in value)
  ) {
    return null;
  }

  const repo = parseRepo(value.repo);
  const targetStage = typeof value.targetStage === 'string' ? parseStage(value.targetStage) : null;
  if (repo === null || !isPositiveInteger(value.issueNumber) || targetStage === null) {
    return null;
  }

  return {
    repo,
    issueNumber: value.issueNumber,
    targetStage,
  };
}

function getRepoName(repo: string): string {
  const repoName = repo.split('/')[1];
  if (!repoName) {
    throw new Error(`Invalid repository name: ${repo}`);
  }

  return repoName;
}

async function getResetValidationError(
  repo: string,
  issue: RawResetIssueData,
  targetStage: WorkflowStage
): Promise<string | null> {
  const labels = issue.labels.map((label) => label.name);

  if (labels.includes(LOCKED_LABEL) && !(await isLockStale(repo, String(issue.number)))) {
    return `Issue #${issue.number} is locked by another shipper instance. Reset is unavailable until that run finishes.`;
  }

  const currentStage = getCurrentStage(labels);
  const validTargets = getValidTargets(currentStage);
  if (validTargets.includes(targetStage)) {
    return null;
  }

  const currentIndex = getStageIndex(currentStage.stage);
  const targetIndex = getStageIndex(targetStage);
  const sameImplementedStage = currentStage.hasPrLabels && targetStage === 'implemented';

  if (targetIndex === currentIndex && !sameImplementedStage) {
    return `Issue #${issue.number} is already at ${getStageLabel(targetStage)}. Reset only works backward.`;
  }

  if (targetIndex > currentIndex) {
    return `${getStageLabel(targetStage)} is ahead of the current stage ${getStageLabel(currentStage.stage)}. Reset only works backward.`;
  }

  return `Issue #${issue.number} cannot be reset to ${getStageLabel(targetStage)}.`;
}

function toArtifactScanSummary(
  scan: Awaited<ReturnType<typeof scanArtifacts>>
): ArtifactScanSummary {
  return {
    targetStage: scan.targetStage,
    targetLabel: scan.targetLabel,
    labelsToRemove: scan.labelsToRemove,
    addTarget: scan.addTarget,
    prs: scan.prs.map((pr) => ({
      number: pr.number,
      headRefName: pr.headRefName,
    })),
    branchesToDelete: scan.branchesToDelete,
    localBranches: scan.localBranches,
    localWorktrees: scan.localWorktrees,
    commentCount: scan.commentIds.length,
  };
}

export function registerResetHandlers(): void {
  ipcMain.handle('scan-reset', async (_event, payload: unknown) => {
    const parsedPayload = parseResetIssuePayload(payload);
    if (parsedPayload === null) {
      return {
        ok: false,
        error:
          'Enter a repository in owner/repo format, a positive issue number, and a valid reset stage.',
      };
    }

    try {
      const issue = await loadResetIssue(parsedPayload.repo, parsedPayload.issueNumber);
      if (issue.state !== 'OPEN') {
        return {
          ok: false,
          error: `Issue #${parsedPayload.issueNumber} is closed. Reset only works on open issues.`,
        };
      }

      const validationError = await getResetValidationError(
        parsedPayload.repo,
        issue,
        parsedPayload.targetStage
      );
      if (validationError !== null) {
        return { ok: false, error: validationError };
      }

      const scan = await scanArtifacts(
        parsedPayload.issueNumber,
        parsedPayload.repo,
        parsedPayload.targetStage,
        issue.labels.map((label) => label.name),
        { repoName: getRepoName(parsedPayload.repo) }
      );

      return {
        ok: true,
        scan: toArtifactScanSummary(scan),
      };
    } catch (error) {
      const message = toErrorMessage(error);
      return { ok: false, error: message };
    }
  });

  ipcMain.handle('execute-reset', async (_event, payload: unknown) => {
    const parsedPayload = parseResetIssuePayload(payload);
    if (parsedPayload === null) {
      return {
        ok: false,
        error:
          'Enter a repository in owner/repo format, a positive issue number, and a valid reset stage.',
      };
    }

    try {
      const issue = await loadResetIssue(parsedPayload.repo, parsedPayload.issueNumber);
      if (issue.state !== 'OPEN') {
        return {
          ok: false,
          error: `Issue #${parsedPayload.issueNumber} is closed. Reset only works on open issues.`,
        };
      }

      const validationError = await getResetValidationError(
        parsedPayload.repo,
        issue,
        parsedPayload.targetStage
      );
      if (validationError !== null) {
        return { ok: false, error: validationError };
      }

      const issueNumber = String(parsedPayload.issueNumber);
      await acquireIssueLock(parsedPayload.repo, issueNumber);

      try {
        const scan = await scanArtifacts(
          parsedPayload.issueNumber,
          parsedPayload.repo,
          parsedPayload.targetStage,
          issue.labels.map((label) => label.name),
          { repoName: getRepoName(parsedPayload.repo) }
        );

        await executeReset(parsedPayload.issueNumber, scan, parsedPayload.repo);
        return { ok: true };
      } finally {
        await releaseIssueLock(parsedPayload.repo, issueNumber);
      }
    } catch (error) {
      const message = toErrorMessage(error);
      return { ok: false, error: message };
    }
  });
}
