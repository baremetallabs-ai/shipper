import {
  BLOCKED_LABEL,
  DISPLAY_NAME_MAP,
  FAILED_LABEL,
  getPriorityTier,
  LOCKED_LABEL,
  NEW_LABEL,
  STAGE_LABEL_NAMES,
  type ListIssueItem,
} from '@dnsquared/shipper-core';

import { AUTO_SHIP_PRIORITY_LABELS, MAX_AUTO_SHIP_CONSECUTIVE_FAILURES } from './constants.js';
import { getShipperApi } from './shipper-api.js';
import type {
  AutoShipCandidate,
  AutoShipFailureState,
  BackgroundCommandKind,
  BackgroundCommandState,
  BackgroundDetailInput,
  BackgroundRetryPayload,
  ShipperApi,
  SelectNextAutoUnblockIssueResult,
  TimelineLabelEvent,
} from '../types.js';

type FetchIssueTimelinesFn = (
  repo: string,
  issueNumbers: number[]
) => Promise<Map<number, TimelineLabelEvent[]>>;
type CheckLockStaleFn = ShipperApi['checkLockStale'];
type UnlockIssueFn = ShipperApi['unlockIssue'];

const AUTO_UNBLOCK_PRIORITY_LABELS = STAGE_LABEL_NAMES.filter((label) => label !== NEW_LABEL)
  .slice()
  .reverse();

function compareAutoShipCandidateBuckets(
  left: Pick<AutoShipCandidate, 'priorityTier' | 'stageIndex'>,
  right: Pick<AutoShipCandidate, 'priorityTier' | 'stageIndex'>
): number {
  if (left.priorityTier !== right.priorityTier) {
    return left.priorityTier - right.priorityTier;
  }

  return left.stageIndex - right.stageIndex;
}

function compareAutoShipCandidates(left: AutoShipCandidate, right: AutoShipCandidate): number {
  const bucketComparison = compareAutoShipCandidateBuckets(left, right);
  if (bucketComparison !== 0) {
    return bucketComparison;
  }

  return left.issueIndex - right.issueIndex;
}

function sortIssuesByLabelTime<T extends { number: number; title: string }>(
  issues: T[],
  timelinesByIssue: Map<number, TimelineLabelEvent[]>,
  label: string
): T[] {
  const withTimestamps = issues.map((issue) => {
    const events = timelinesByIssue.get(issue.number) ?? [];
    const labelEvents = events.filter(
      (event) => event.event === 'labeled' && event.label?.name === label && event.created_at
    );
    const lastEvent = labelEvents.length > 0 ? labelEvents[labelEvents.length - 1] : undefined;
    return { issue, timestamp: lastEvent?.created_at ?? '' };
  });

  withTimestamps.sort((left, right) => {
    if (!left.timestamp && !right.timestamp) return 0;
    if (!left.timestamp) return 1;
    if (!right.timestamp) return -1;
    return left.timestamp.localeCompare(right.timestamp);
  });

  return withTimestamps.map((entry) => entry.issue);
}

async function isLockStaleForSelection(
  repo: string,
  issueNumber: number,
  checkLockStale: CheckLockStaleFn
): Promise<boolean> {
  try {
    return (await checkLockStale(repo, issueNumber)).stale;
  } catch {
    return false;
  }
}

async function unlockIssueBestEffort(
  repo: string,
  issueNumber: number,
  unlockIssue: UnlockIssueFn
): Promise<void> {
  try {
    const result = await unlockIssue(repo, issueNumber);
    if (!result.ok) {
      console.warn(`[shipper] Failed to clear stale lock for #${issueNumber}: ${result.error}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[shipper] Failed to clear stale lock for #${issueNumber}: ${message}`);
  }
}

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
  pausePending,
  retriable,
  origin,
}: BackgroundDetailInput): string {
  if (cancelled) {
    return 'Cancelled';
  }

  if (pausePending) {
    return 'Pausing...';
  }

  if (status === 'queued' && command === 'ship' && issueNumber) {
    return `Ship #${issueNumber} queued`;
  }

  if (status === 'paused') {
    return command === 'ship' ? 'Paused at stage boundary' : 'Paused';
  }

  if (status === 'failed') {
    if (command === 'ship' && retriable && origin === 'auto') {
      return 'Will retry later in this session';
    }
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
  merge?: boolean,
  origin?: 'auto' | 'manual'
): BackgroundRetryPayload | undefined {
  switch (command) {
    case 'new':
      return request ? { command, repo, request } : undefined;
    case 'ship':
      return issueNumber
        ? { command, repo, issueNumber, merge: merge ?? false, origin }
        : undefined;
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

export function getWorkflowStageCacheKey(repo: string, issueNumber: number): string {
  return `${repo}:${issueNumber}`;
}

export function syncWorkflowStageCacheForRepo(
  current: ReadonlyMap<string, string>,
  repo: string,
  issues: ListIssueItem[]
): Map<string, string> {
  const next = new Map(current);
  const repoPrefix = `${repo}:`;

  for (const key of next.keys()) {
    if (key.startsWith(repoPrefix)) {
      next.delete(key);
    }
  }

  for (const issue of issues) {
    const stage = getWorkflowStageDisplayName(issue.labels);
    if (!stage) {
      continue;
    }

    next.set(getWorkflowStageCacheKey(repo, issue.number), stage);
  }

  return next;
}

export async function selectNextAutoShipIssue(
  repo: string,
  issues: ListIssueItem[],
  activeIssueNumbers: Set<number>,
  skippedIssueNumbers: Set<number>,
  pausedIssueNumbers: Set<number>,
  fetchIssueTimelines: FetchIssueTimelinesFn = (currentRepo, issueNumbers) =>
    getShipperApi().fetchIssueTimelines(currentRepo, issueNumbers),
  checkLockStale: CheckLockStaleFn = (currentRepo, issueNumber) =>
    getShipperApi().checkLockStale(currentRepo, issueNumber),
  unlockIssue: UnlockIssueFn = (currentRepo, issueNumber) =>
    getShipperApi().unlockIssue(currentRepo, issueNumber)
): Promise<ListIssueItem | null> {
  const candidates: AutoShipCandidate[] = [];
  const lockedCandidates: AutoShipCandidate[] = [];
  const staleLockedIssueNumbers = new Set<number>();
  let bestUnlockedCandidate: AutoShipCandidate | undefined;

  issues.forEach((issue, issueIndex) => {
    if (
      activeIssueNumbers.has(issue.number) ||
      skippedIssueNumbers.has(issue.number) ||
      pausedIssueNumbers.has(issue.number) ||
      issue.labels.includes(BLOCKED_LABEL) ||
      issue.labels.includes(FAILED_LABEL)
    ) {
      return;
    }

    const stageIndex = AUTO_SHIP_PRIORITY_LABELS.findIndex((label) => issue.labels.includes(label));
    if (stageIndex < 0) {
      return;
    }

    if (issue.labels.includes(LOCKED_LABEL)) {
      lockedCandidates.push({
        issue,
        priorityTier: getPriorityTier(issue.labels),
        stageIndex,
        issueIndex,
      });
      return;
    }

    const candidate = {
      issue,
      priorityTier: getPriorityTier(issue.labels),
      stageIndex,
      issueIndex,
    };
    candidates.push(candidate);
    if (!bestUnlockedCandidate || compareAutoShipCandidates(candidate, bestUnlockedCandidate) < 0) {
      bestUnlockedCandidate = candidate;
    }
  });

  lockedCandidates.sort(compareAutoShipCandidates);
  let bestStaleLockedCandidate: AutoShipCandidate | undefined;

  for (const lockedCandidate of lockedCandidates) {
    if (
      bestStaleLockedCandidate &&
      compareAutoShipCandidateBuckets(lockedCandidate, bestStaleLockedCandidate) > 0
    ) {
      break;
    }

    if (
      bestUnlockedCandidate &&
      compareAutoShipCandidateBuckets(lockedCandidate, bestUnlockedCandidate) > 0
    ) {
      break;
    }

    const { issue } = lockedCandidate;
    const isStale = await isLockStaleForSelection(repo, issue.number, checkLockStale);
    if (!isStale) {
      continue;
    }

    candidates.push(lockedCandidate);
    staleLockedIssueNumbers.add(issue.number);
    bestStaleLockedCandidate ??= lockedCandidate;
  }

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort(compareAutoShipCandidates);

  const winningCandidate = candidates[0];
  if (!winningCandidate) {
    return null;
  }

  const bucketCandidates = candidates.filter(
    (candidate) =>
      candidate.priorityTier === winningCandidate.priorityTier &&
      candidate.stageIndex === winningCandidate.stageIndex
  );

  async function returnWinningIssue(issue: ListIssueItem): Promise<ListIssueItem> {
    if (staleLockedIssueNumbers.has(issue.number)) {
      await unlockIssueBestEffort(repo, issue.number, unlockIssue);
    }

    return issue;
  }

  if (bucketCandidates.length < 2) {
    return returnWinningIssue(winningCandidate.issue);
  }

  const currentStageLabel = AUTO_SHIP_PRIORITY_LABELS[winningCandidate.stageIndex];
  if (!currentStageLabel) {
    return returnWinningIssue(winningCandidate.issue);
  }

  const bucketIssues = bucketCandidates.map((candidate) => candidate.issue);
  const bucketIssueNumbers = bucketIssues.map((issue) => issue.number);
  const timelinesByIssue = await fetchIssueTimelines(repo, bucketIssueNumbers).catch(
    () =>
      new Map<number, TimelineLabelEvent[]>(
        bucketIssueNumbers.map((issueNumber) => [issueNumber, [] as TimelineLabelEvent[]])
      )
  );

  const selectedIssue = sortIssuesByLabelTime(bucketIssues, timelinesByIssue, currentStageLabel)[0];
  if (!selectedIssue) {
    return null;
  }

  return returnWinningIssue(selectedIssue);
}

export function sortBlockedIssuesByStagePriority(issues: ListIssueItem[]): ListIssueItem[] {
  return issues
    .map((issue, issueIndex) => ({
      issue,
      issueIndex,
      stageIndex: AUTO_UNBLOCK_PRIORITY_LABELS.findIndex((label) => issue.labels.includes(label)),
    }))
    .sort((left, right) => {
      const leftStageIndex = left.stageIndex >= 0 ? left.stageIndex : Number.MAX_SAFE_INTEGER;
      const rightStageIndex = right.stageIndex >= 0 ? right.stageIndex : Number.MAX_SAFE_INTEGER;

      if (leftStageIndex !== rightStageIndex) {
        return leftStageIndex - rightStageIndex;
      }

      return left.issueIndex - right.issueIndex;
    })
    .map(({ issue }) => issue);
}

export async function selectInitialAutoUnblockIssue(
  repo: string,
  issues: ListIssueItem[],
  checkLockStale: CheckLockStaleFn = (currentRepo, issueNumber) =>
    getShipperApi().checkLockStale(currentRepo, issueNumber),
  unlockIssue: UnlockIssueFn = (currentRepo, issueNumber) =>
    getShipperApi().unlockIssue(currentRepo, issueNumber)
): Promise<SelectNextAutoUnblockIssueResult> {
  const blockedIssues = sortBlockedIssuesByStagePriority(
    issues.filter((issue) => issue.labels.includes(BLOCKED_LABEL))
  );
  const skippedLockedIssueNumbers: number[] = [];
  const buildSelectionResult = (
    issue: ListIssueItem,
    index: number
  ): SelectNextAutoUnblockIssueResult => ({
    issue,
    remainingIssueNumbers: [
      ...skippedLockedIssueNumbers,
      ...blockedIssues.slice(index + 1).map((candidate) => candidate.number),
    ],
  });

  for (let index = 0; index < blockedIssues.length; index += 1) {
    const issue = blockedIssues[index];
    if (!issue) {
      continue;
    }

    if (!issue.labels.includes(LOCKED_LABEL)) {
      return buildSelectionResult(issue, index);
    }

    const isStale = await isLockStaleForSelection(repo, issue.number, checkLockStale);
    if (!isStale) {
      skippedLockedIssueNumbers.push(issue.number);
      continue;
    }

    await unlockIssueBestEffort(repo, issue.number, unlockIssue);
    return buildSelectionResult(issue, index);
  }

  return {
    issue: null,
    remainingIssueNumbers: [],
  };
}

export async function selectNextAutoUnblockIssue(
  repo: string,
  issues: ListIssueItem[],
  queuedIssueNumbers: number[],
  checkLockStale: CheckLockStaleFn = (currentRepo, issueNumber) =>
    getShipperApi().checkLockStale(currentRepo, issueNumber),
  unlockIssue: UnlockIssueFn = (currentRepo, issueNumber) =>
    getShipperApi().unlockIssue(currentRepo, issueNumber)
): Promise<SelectNextAutoUnblockIssueResult> {
  const remainingIssueNumbers = [...queuedIssueNumbers];

  while (remainingIssueNumbers.length > 0) {
    const nextIssueNumber = remainingIssueNumbers.shift();
    if (nextIssueNumber === undefined) {
      continue;
    }

    const issue = issues.find((currentIssue) => currentIssue.number === nextIssueNumber);
    if (!issue || !issue.labels.includes(BLOCKED_LABEL)) {
      continue;
    }

    if (issue.labels.includes(LOCKED_LABEL)) {
      const isStale = await isLockStaleForSelection(repo, issue.number, checkLockStale);
      if (!isStale) {
        continue;
      }

      await unlockIssueBestEffort(repo, issue.number, unlockIssue);
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
  retriable: boolean,
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

  if (retriable) {
    return {
      consecutiveFailures: currentFailures,
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
