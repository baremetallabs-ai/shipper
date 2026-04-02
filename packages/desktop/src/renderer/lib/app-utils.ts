import type { ListIssueItem } from '@dnsquared/shipper-core';
import {
  BLOCKED_LABEL,
  DISPLAY_NAME_MAP,
  FAILED_LABEL,
  getPriorityTier,
  LOCKED_LABEL,
  STAGE_LABEL_NAMES,
} from '../../../../core/src/lib/labels.js';

import { AUTO_SHIP_PRIORITY_LABELS, MAX_AUTO_SHIP_CONSECUTIVE_FAILURES } from './constants.js';
import type {
  AutoShipCandidate,
  AutoShipFailureState,
  BackgroundCommandKind,
  BackgroundCommandState,
  BackgroundDetailInput,
  BackgroundRetryPayload,
  SelectNextAutoUnblockIssueResult,
} from '../types.js';

export function getBackgroundTitle(
  command: BackgroundCommandKind,
  repo: string,
  issueNumber?: number,
  merge?: boolean
): string {
  switch (command) {
    case 'new':
      return 'New issue';
    case 'ship':
      return issueNumber ? `Ship #${issueNumber}${merge ? ' · merge' : ''}` : 'Ship';
    case 'init':
      return `Init ${repo}`;
    case 'unblock':
      return issueNumber ? `Unblock #${issueNumber}` : 'Unblock';
  }
}

export function getBackgroundDetail({
  command,
  status,
  repo,
  issueNumber,
  merge,
  latestOutput,
  cancelled,
}: BackgroundDetailInput): string {
  if (cancelled) {
    return 'Cancelled';
  }

  if (status === 'queued' && command === 'ship' && issueNumber) {
    return `Ship #${issueNumber} queued`;
  }

  if (status === 'failed') {
    return latestOutput ?? 'Command failed';
  }

  if (status === 'complete') {
    switch (command) {
      case 'new':
        return 'Issue created';
      case 'ship':
        return merge ? 'Ship completed · merged' : 'Ship completed';
      case 'init':
        return 'Initialization complete';
      case 'unblock':
        return 'Unblock completed';
    }
  }

  if (command === 'new') {
    return 'Creating issue...';
  }

  if (command === 'ship') {
    return latestOutput ?? (issueNumber ? `Shipping #${issueNumber}...` : 'Shipping...');
  }

  if (command === 'unblock') {
    return latestOutput ?? (issueNumber ? `Unblocking #${issueNumber}...` : 'Unblocking...');
  }

  return latestOutput ?? `Initializing ${repo}...`;
}

export function getBackgroundRetryPayload(
  command: BackgroundCommandKind,
  repo: string,
  request?: string,
  issueNumber?: number,
  merge?: boolean
): BackgroundRetryPayload | undefined {
  switch (command) {
    case 'new':
      return request ? { command, repo, request } : undefined;
    case 'ship':
      return issueNumber ? { command, repo, issueNumber, merge: merge ?? false } : undefined;
    case 'init':
      return { command, repo };
    case 'unblock':
      return issueNumber ? { command, repo, issueNumber } : undefined;
  }
}

export function getActiveShipIssueNumbers(
  commands: BackgroundCommandState[],
  repo: string
): Set<number> {
  const activeIssueNumbers = new Set<number>();

  for (const command of commands) {
    if (
      command.command === 'ship' &&
      command.repo === repo &&
      command.issueNumber !== undefined &&
      (command.status === 'queued' || command.status === 'running') &&
      !command.cancelled
    ) {
      activeIssueNumbers.add(command.issueNumber);
    }
  }

  return activeIssueNumbers;
}

export function getWorkflowStageDisplayName(labels: string[]): string | undefined {
  for (let index = STAGE_LABEL_NAMES.length - 1; index >= 0; index -= 1) {
    const label = STAGE_LABEL_NAMES[index];
    if (label && labels.includes(label)) {
      return DISPLAY_NAME_MAP[label];
    }
  }

  return undefined;
}

export function selectNextAutoShipIssue(
  issues: ListIssueItem[],
  activeIssueNumbers: Set<number>,
  skippedIssueNumbers: Set<number>
): ListIssueItem | null {
  const candidates: AutoShipCandidate[] = [];

  issues.forEach((issue, issueIndex) => {
    if (
      activeIssueNumbers.has(issue.number) ||
      skippedIssueNumbers.has(issue.number) ||
      issue.labels.includes(BLOCKED_LABEL) ||
      issue.labels.includes(FAILED_LABEL) ||
      issue.labels.includes(LOCKED_LABEL)
    ) {
      return;
    }

    const stageIndex = AUTO_SHIP_PRIORITY_LABELS.findIndex((label) => issue.labels.includes(label));
    if (stageIndex < 0) {
      return;
    }

    candidates.push({
      issue,
      priorityTier: getPriorityTier(issue.labels),
      stageIndex,
      issueIndex,
    });
  });

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((left, right) => {
    if (left.priorityTier !== right.priorityTier) {
      return left.priorityTier - right.priorityTier;
    }

    if (left.stageIndex !== right.stageIndex) {
      return left.stageIndex - right.stageIndex;
    }

    return left.issueIndex - right.issueIndex;
  });

  return candidates[0]?.issue ?? null;
}

export function selectNextAutoUnblockIssue(
  issues: ListIssueItem[],
  queuedIssueNumbers: number[]
): SelectNextAutoUnblockIssueResult {
  const remainingIssueNumbers = [...queuedIssueNumbers];

  while (remainingIssueNumbers.length > 0) {
    const nextIssueNumber = remainingIssueNumbers.shift();
    if (nextIssueNumber === undefined) {
      continue;
    }

    const issue = issues.find((currentIssue) => currentIssue.number === nextIssueNumber);
    if (!issue || !issue.labels.includes(BLOCKED_LABEL) || issue.labels.includes(LOCKED_LABEL)) {
      continue;
    }

    return {
      issue,
      remainingIssueNumbers,
    };
  }

  return {
    issue: null,
    remainingIssueNumbers: [],
  };
}

export function getNextAutoShipFailureState(
  status: 'complete' | 'failed',
  issueNumber: number | undefined,
  currentFailures: number,
  currentSkipped: Set<number>
): AutoShipFailureState {
  if (status === 'complete') {
    return {
      consecutiveFailures: 0,
      skippedIssueNumbers: new Set(currentSkipped),
      pauseAutoShip: false,
    };
  }

  const skippedIssueNumbers = new Set(currentSkipped);
  if (issueNumber !== undefined) {
    skippedIssueNumbers.add(issueNumber);
  }

  const consecutiveFailures = currentFailures + 1;
  return {
    consecutiveFailures,
    skippedIssueNumbers,
    pauseAutoShip: consecutiveFailures >= MAX_AUTO_SHIP_CONSECUTIVE_FAILURES,
  };
}
