import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import type { RefObject, SetStateAction } from 'react';

import {
  BLOCKED_LABEL,
  PR_REVIEWED_LABEL,
  toErrorMessage,
  type ListIssueItem,
} from '@baremetallabs-ai/shipper-core';

import {
  getActiveShipIssueNumbers,
  getBackgroundRetryPayload,
  getNextAutoShipFailureState,
  selectInitialAutoUnblockIssue,
  selectNextAutoShipIssue,
  selectNextAutoUnblockIssue,
} from '../lib/app-utils.js';
import { getShipperApi } from '../lib/shipper-api.js';
import { MAX_AUTO_SHIP_CONSECUTIVE_FAILURES } from '../lib/constants.js';
import type {
  ActiveShippingCommand,
  BackgroundCommandKind,
  BackgroundCommandStatus,
  BackgroundCommandState,
  BackgroundLogViewerState,
  BackgroundRetryPayload,
  BackgroundStatusPayload,
  BackgroundToastItem,
  IssueListResult,
  IssuePipelineBridge,
} from '../types.js';

function getLatestOutputLine(output: string): string | null {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.at(-1) ?? null;
}

type DisplayedBackgroundState = BackgroundCommandStatus | 'cancelled';

function getDisplayedBackgroundState(
  status: BackgroundCommandStatus,
  cancelled: boolean
): DisplayedBackgroundState {
  return status === 'failed' && cancelled ? 'cancelled' : status;
}

function isActiveShippingCommand(
  command: BackgroundCommandState,
  activeRepo: string | null
): command is ActiveShippingCommand {
  return (
    command.command === 'ship' &&
    command.repo === activeRepo &&
    command.issueNumber !== undefined &&
    (command.status === 'queued' || command.status === 'running') &&
    !command.cancelled
  );
}

function getBackgroundLogTitle(
  command: BackgroundCommandKind,
  repo: string,
  issueNumber?: number
): string {
  switch (command) {
    case 'new':
      return `New issue logs — ${repo}`;
    case 'ship':
      return issueNumber ? `Ship #${issueNumber} logs` : `Ship logs — ${repo}`;
    case 'init':
      return `Init logs — ${repo}`;
    case 'unblock':
      return issueNumber ? `Unblock #${issueNumber} logs` : `Unblock logs — ${repo}`;
  }
}

function getBackgroundToastSubject(
  command: BackgroundCommandKind,
  repo: string,
  issueNumber?: number
): string {
  switch (command) {
    case 'new':
      return 'New issue';
    case 'ship':
      return issueNumber ? `Ship #${issueNumber}` : 'Ship';
    case 'init':
      return `Init ${repo}`;
    case 'unblock':
      return issueNumber ? `Unblock #${issueNumber}` : 'Unblock';
  }
}

interface UseBackgroundCommandsOptions {
  activeRepo: string;
  autoMergeRepos: Set<string>;
  checkInitState: (repo: string) => Promise<void>;
  pipelineBridgeRef: RefObject<IssuePipelineBridge | null>;
}

export interface UseBackgroundCommandsResult {
  backgroundCommands: BackgroundCommandState[];
  toasts: BackgroundToastItem[];
  logViewer: BackgroundLogViewerState;
  actionQueueOpen: boolean;
  autoShipRepos: Set<string>;
  pausePendingIssues: Set<number>;
  shippingCommands: Map<number, ActiveShippingCommand>;
  activeCommandRepos: Set<string>;
  pushToast: (toast: BackgroundToastItem) => void;
  dismissToast: (toastId: string) => void;
  handleLogViewerOpenChange: (open: boolean) => void;
  handleToggleActionQueue: () => void;
  handleDismissBackground: (sessionId: string) => void;
  handleClearFinishedBackground: () => void;
  handleCancelBackground: (sessionId: string) => Promise<void>;
  handleShowBackgroundLogs: (sessionId: string) => Promise<void>;
  handleRetryToast: (toastId: string) => Promise<void>;
  handlePauseIssue: (issue: ListIssueItem) => Promise<void>;
  handleResumeIssue: (issueNumber: number, repo?: string) => Promise<void>;
  enableAutoShipForRepo: (repo: string) => void;
  clearAutoShipStateForRepo: (repo: string) => void;
}

export function useBackgroundCommands({
  activeRepo,
  autoMergeRepos,
  checkInitState,
  pipelineBridgeRef,
}: UseBackgroundCommandsOptions): UseBackgroundCommandsResult {
  const [backgroundCommands, setBackgroundCommands] = useState<BackgroundCommandState[]>([]);
  const [toasts, setToasts] = useState<BackgroundToastItem[]>([]);
  const [autoShipRepos, setAutoShipRepos] = useState<Set<string>>(new Set());
  const [pausePendingIssuesByRepo, setPausePendingIssuesByRepo] = useState<
    Map<string, Set<number>>
  >(new Map());
  const [logViewer, setLogViewer] = useState<BackgroundLogViewerState>({
    open: false,
    sessionId: null,
    title: '',
    content: '',
  });
  const [actionQueueOpen, setActionQueueOpen] = useState(false);
  const backgroundCommandsRef = useRef<BackgroundCommandState[]>([]);
  const autoShipFailuresRef = useRef<Map<string, number>>(new Map());
  const autoShipSkippedRef = useRef<Map<string, Set<number>>>(new Map());
  const autoUnblockQueueRef = useRef<Map<string, number[]>>(new Map());
  const autoUnblockIssuesRef = useRef<Map<string, Set<number>>>(new Map());
  const pausedIssuesByRepoRef = useRef<Map<string, Set<number>>>(new Map());

  const viewedBackgroundCommand =
    logViewer.sessionId === null
      ? null
      : (backgroundCommands.find((command) => command.id === logViewer.sessionId) ?? null);
  const viewedBackgroundCommandType = viewedBackgroundCommand?.command ?? null;
  const viewedBackgroundCommandStatus = viewedBackgroundCommand?.status ?? null;

  const shippingCommands = useMemo(() => {
    const nextShippingCommands = new Map<number, ActiveShippingCommand>();

    for (const command of backgroundCommands) {
      if (isActiveShippingCommand(command, activeRepo)) {
        nextShippingCommands.set(command.issueNumber, command);
      }
    }

    return nextShippingCommands;
  }, [activeRepo, backgroundCommands]);

  const activeCommandRepos = useMemo(() => {
    const repos = new Set<string>();

    for (const command of backgroundCommands) {
      if ((command.status === 'queued' || command.status === 'running') && !command.cancelled) {
        repos.add(command.repo);
      }
    }

    return repos;
  }, [backgroundCommands]);

  const pausePendingIssues = useMemo(
    () => new Set(pausePendingIssuesByRepo.get(activeRepo) ?? []),
    [activeRepo, pausePendingIssuesByRepo]
  );

  useEffect(() => {
    backgroundCommandsRef.current = backgroundCommands;
  }, [backgroundCommands]);

  const commitBackgroundCommands = useCallback(
    (updater: SetStateAction<BackgroundCommandState[]>) => {
      const nextCommands =
        typeof updater === 'function' ? updater(backgroundCommandsRef.current) : updater;
      backgroundCommandsRef.current = nextCommands;
      setBackgroundCommands(nextCommands);
    },
    []
  );

  const dismissToast = useCallback((toastId: string) => {
    setToasts((currentToasts) => currentToasts.filter((toast) => toast.id !== toastId));
  }, []);

  const pushToast = useCallback((toast: BackgroundToastItem) => {
    setToasts((currentToasts) => {
      const nextToasts = currentToasts.filter((item) => item.id !== toast.id);
      return [...nextToasts, toast];
    });
  }, []);

  const clearAutoShipStateForRepo = useCallback((repo: string) => {
    setAutoShipRepos((currentRepos) => {
      if (!currentRepos.has(repo)) {
        return currentRepos;
      }

      const nextRepos = new Set(currentRepos);
      nextRepos.delete(repo);
      return nextRepos;
    });
    autoShipFailuresRef.current.delete(repo);
    autoShipSkippedRef.current.delete(repo);
    autoUnblockQueueRef.current.delete(repo);
    autoUnblockIssuesRef.current.delete(repo);
  }, []);

  const setPausePendingIssue = useCallback(
    (repo: string, issueNumber: number, pending: boolean) => {
      setPausePendingIssuesByRepo((current) => {
        const currentIssues = current.get(repo);
        const nextIssues = new Set(currentIssues ?? []);
        if (pending) {
          nextIssues.add(issueNumber);
        } else {
          nextIssues.delete(issueNumber);
        }

        if (
          currentIssues?.size === nextIssues.size &&
          [...currentIssues].every((issue) => nextIssues.has(issue))
        ) {
          return current;
        }

        const next = new Map(current);
        if (nextIssues.size === 0) {
          next.delete(repo);
        } else {
          next.set(repo, nextIssues);
        }
        return next;
      });
    },
    []
  );

  const trackPausedIssueForRepo = useCallback(
    (repo: string, issueNumber: number) => {
      const currentIssues = pausedIssuesByRepoRef.current.get(repo) ?? new Set<number>();
      const nextIssues = new Set(currentIssues);
      nextIssues.add(issueNumber);
      pausedIssuesByRepoRef.current.set(repo, nextIssues);
      if (repo === activeRepo) {
        pipelineBridgeRef.current?.trackPausedIssue(issueNumber);
      }
    },
    [activeRepo, pipelineBridgeRef]
  );

  const clearPausedIssueForRepo = useCallback(
    (repo: string, issueNumber: number) => {
      const currentIssues = pausedIssuesByRepoRef.current.get(repo);
      if (currentIssues) {
        const nextIssues = new Set(currentIssues);
        nextIssues.delete(issueNumber);
        if (nextIssues.size === 0) {
          pausedIssuesByRepoRef.current.delete(repo);
        } else {
          pausedIssuesByRepoRef.current.set(repo, nextIssues);
        }
      }

      if (repo === activeRepo) {
        pipelineBridgeRef.current?.clearPausedIssue(issueNumber);
      }
    },
    [activeRepo, pipelineBridgeRef]
  );

  const getPausedIssueNumbersForRepo = useCallback(async (repo: string) => {
    const cachedIssues = pausedIssuesByRepoRef.current.get(repo);
    if (cachedIssues) {
      return new Set(cachedIssues);
    }

    const issueNumbers = await getShipperApi().listPausedIssues(repo);
    const nextIssues = new Set(issueNumbers);
    pausedIssuesByRepoRef.current.set(repo, nextIssues);
    return new Set(nextIssues);
  }, []);

  const enableAutoShipForRepo = useCallback((repo: string) => {
    setAutoShipRepos((currentRepos) => {
      if (currentRepos.has(repo)) {
        return currentRepos;
      }

      return new Set(currentRepos).add(repo);
    });
    autoShipFailuresRef.current.set(repo, 0);
    autoShipSkippedRef.current.set(repo, new Set());
  }, []);

  const refreshRepoAfterBackground = useCallback(
    async (
      repo: string,
      command: BackgroundCommandKind,
      status: BackgroundCommandState['status']
    ): Promise<IssueListResult | null> => {
      if (repo !== activeRepo) {
        return null;
      }

      const isTerminalStatus = status === 'complete' || status === 'failed';
      const shouldRefresh =
        (command === 'ship' && (isTerminalStatus || status === 'paused')) ||
        ((command === 'unblock' || command === 'new' || command === 'init') && isTerminalStatus);

      if (command === 'init' && status === 'complete') {
        void checkInitState(repo);
      }

      if (shouldRefresh) {
        return pipelineBridgeRef.current?.loadIssues(repo) ?? null;
      }

      return null;
    },
    [activeRepo, checkInitState, pipelineBridgeRef]
  );

  const handleRetryBackgroundCommand = useCallback(
    async (payload: BackgroundRetryPayload) => {
      switch (payload.command) {
        case 'new':
          await getShipperApi().spawnBackgroundNew(payload.request, payload.repo);
          return;
        case 'ship':
          await getShipperApi().spawnBackgroundShip(
            payload.issueNumber,
            payload.repo,
            payload.merge,
            payload.origin,
            payload.issueTitle
          );
          return;
        case 'init':
          await getShipperApi().spawnBackgroundInit(payload.repo);
          return;
        case 'unblock':
          pipelineBridgeRef.current?.trackUnblockIssue(payload.issueNumber);
          try {
            await getShipperApi().spawnBackgroundUnblock(
              payload.issueNumber,
              payload.repo,
              payload.issueTitle
            );
          } catch (error) {
            pipelineBridgeRef.current?.clearUnblockIssue(payload.issueNumber);
            throw error;
          }
          return;
      }
    },
    [pipelineBridgeRef]
  );

  function isAutoUnblockIssue(repo: string, issueNumber: number): boolean {
    return autoUnblockIssuesRef.current.get(repo)?.has(issueNumber) ?? false;
  }

  function trackAutoUnblockIssue(repo: string, issueNumber: number): void {
    const currentIssues = autoUnblockIssuesRef.current.get(repo) ?? new Set<number>();
    currentIssues.add(issueNumber);
    autoUnblockIssuesRef.current.set(repo, currentIssues);
    pipelineBridgeRef.current?.trackUnblockIssue(issueNumber);
  }

  function clearAutoUnblockIssue(repo: string, issueNumber: number): void {
    const currentIssues = autoUnblockIssuesRef.current.get(repo);
    if (!currentIssues) {
      return;
    }

    currentIssues.delete(issueNumber);
    if (currentIssues.size === 0) {
      autoUnblockIssuesRef.current.delete(repo);
      return;
    }

    autoUnblockIssuesRef.current.set(repo, currentIssues);
  }

  const handleResumeIssue = useCallback(
    async (issueNumber: number, repo = activeRepo) => {
      if (!repo) {
        return;
      }

      try {
        await getShipperApi().resumeIssue(repo, issueNumber);
        clearPausedIssueForRepo(repo, issueNumber);
      } catch (error) {
        pushToast({
          id: `resume-${repo}-${issueNumber}-failed`,
          sessionId: `resume-${repo}-${issueNumber}`,
          variant: 'error',
          title: `Could not resume #${issueNumber}`,
          description: toErrorMessage(error),
        });
      }
    },
    [activeRepo, clearPausedIssueForRepo, pushToast]
  );

  const handlePauseIssue = useCallback(
    async (issue: ListIssueItem) => {
      if (!activeRepo) {
        return;
      }

      const repo = activeRepo;
      const shippingCommand = shippingCommands.get(issue.number);
      const lastKnownIssue = pipelineBridgeRef.current?.getIssueByNumber(issue.number) ?? issue;

      if (shippingCommand?.status === 'running') {
        if (lastKnownIssue.labels.includes(PR_REVIEWED_LABEL)) {
          pushToast({
            id: `pause-final-stage-${issue.number}`,
            sessionId: shippingCommand.id,
            variant: 'cancelled',
            title: `#${issue.number} is at the final stage`,
            description: 'Use Stop to halt abruptly.',
          });
          return;
        }

        try {
          await getShipperApi().requestPauseActive(shippingCommand.id);
          setPausePendingIssue(repo, issue.number, true);
        } catch (error) {
          pushToast({
            id: `pause-${repo}-${issue.number}-request-failed`,
            sessionId: shippingCommand.id,
            variant: 'error',
            title: `Could not pause #${issue.number}`,
            description: toErrorMessage(error),
          });
        }
        return;
      }

      if (shippingCommand?.status === 'queued') {
        try {
          const result = await getShipperApi().removeQueuedSession(shippingCommand.id);
          if (result === 'pause-requested') {
            setPausePendingIssue(repo, issue.number, true);
            return;
          }

          if (result !== 'paused') {
            throw new Error('The issue is no longer queued or running.');
          }

          await getShipperApi().pauseIssue(repo, issue.number);
          trackPausedIssueForRepo(repo, issue.number);
        } catch (error) {
          pushToast({
            id: `pause-${repo}-${issue.number}-queued-failed`,
            sessionId: shippingCommand.id,
            variant: 'error',
            title: `Could not pause #${issue.number}`,
            description: toErrorMessage(error),
          });
        }
        return;
      }

      try {
        await getShipperApi().pauseIssue(repo, issue.number);
        trackPausedIssueForRepo(repo, issue.number);
      } catch (error) {
        pushToast({
          id: `pause-${repo}-${issue.number}-failed`,
          sessionId: `pause-${repo}-${issue.number}`,
          variant: 'error',
          title: `Could not pause #${issue.number}`,
          description: toErrorMessage(error),
        });
      }
    },
    [activeRepo, pushToast, setPausePendingIssue, shippingCommands, trackPausedIssueForRepo]
  );

  const handleBackgroundStatus = useEffectEvent(async (event: BackgroundStatusPayload) => {
    const previousCommand = backgroundCommandsRef.current.find(
      (command) => command.id === event.sessionId
    );
    const output = previousCommand?.output ?? '';
    const latestOutput = getLatestOutputLine(output);
    const request = event.meta?.request ?? previousCommand?.request;
    const issueNumber = event.meta?.issueNumber ?? previousCommand?.issueNumber;
    const issueTitle = event.meta?.issueTitle ?? previousCommand?.issueTitle;
    const merge = event.meta?.merge ?? previousCommand?.merge ?? false;
    const prMerged = event.meta?.prMerged ?? previousCommand?.prMerged;
    const issueUrl = event.meta?.issueUrl ?? previousCommand?.issueUrl;
    const logFile = event.meta?.logFile ?? previousCommand?.logFile;
    const cancelled = event.meta?.cancelled ?? previousCommand?.cancelled ?? false;
    const origin = event.meta?.origin ?? previousCommand?.origin;
    const autoShipHalted = event.meta?.autoShipHalted ?? previousCommand?.autoShipHalted ?? false;
    const retriable = event.meta?.retriable ?? previousCommand?.retriable ?? false;
    const previousDisplayedState = previousCommand
      ? getDisplayedBackgroundState(previousCommand.status, previousCommand.cancelled)
      : null;
    const nextDisplayedState = getDisplayedBackgroundState(event.status, cancelled);
    const stateChangedAt =
      previousCommand && previousDisplayedState === nextDisplayedState
        ? previousCommand.stateChangedAt
        : Date.now();
    const autoShipEnabled = autoShipRepos.has(event.repo);
    const pausePending =
      event.command === 'ship' && event.status === 'running'
        ? (event.meta?.pausePending ?? previousCommand?.pausePending ?? false)
        : false;
    const isAutoUnblock =
      issueNumber !== undefined && event.command === 'unblock'
        ? isAutoUnblockIssue(event.repo, issueNumber)
        : false;
    const nextCommand: BackgroundCommandState = {
      id: event.sessionId,
      command: event.command,
      repo: event.repo,
      status: event.status,
      stateChangedAt,
      output,
      request,
      issueNumber,
      issueTitle,
      merge,
      prMerged,
      issueUrl,
      logFile,
      exitCode: event.exitCode,
      cancelled,
      pausePending,
      origin,
      autoShipHalted,
      retriable,
    };
    const currentCommands = backgroundCommandsRef.current;
    const existingIndex = currentCommands.findIndex((command) => command.id === event.sessionId);
    const nextCommands =
      existingIndex >= 0
        ? currentCommands.map((command, index) => (index === existingIndex ? nextCommand : command))
        : [...currentCommands, nextCommand];

    if (existingIndex < 0) {
      setActionQueueOpen(true);
    }

    const postEventCommands = nextCommands;

    commitBackgroundCommands(postEventCommands);

    if (event.command === 'unblock' && (event.status === 'complete' || event.status === 'failed')) {
      if (issueNumber !== undefined) {
        pipelineBridgeRef.current?.clearUnblockIssue(issueNumber);
        clearAutoUnblockIssue(event.repo, issueNumber);
      }
    }

    if (event.command === 'ship' && issueNumber !== undefined) {
      setPausePendingIssue(event.repo, issueNumber, pausePending);
    }

    if (event.status === 'paused' && event.command === 'ship' && issueNumber !== undefined) {
      try {
        await getShipperApi().pauseIssue(event.repo, issueNumber);
        trackPausedIssueForRepo(event.repo, issueNumber);
        pushToast({
          id: `paused-${event.repo}-${issueNumber}`,
          sessionId: event.sessionId,
          variant: 'cancelled',
          title: `#${issueNumber} paused`,
          description: 'The current stage finished and no further stage was started.',
        });
        await refreshRepoAfterBackground(event.repo, event.command, event.status);
      } catch (error) {
        pushToast({
          id: `paused-${event.repo}-${issueNumber}-failed`,
          sessionId: event.sessionId,
          variant: 'error',
          title: `Failed to pause #${issueNumber}`,
          description: toErrorMessage(error),
        });
      }
    }

    if (event.status === 'complete' && event.command !== 'unblock') {
      if (!autoShipHalted) {
        const successToast: BackgroundToastItem =
          event.command === 'new'
            ? {
                id: event.sessionId,
                sessionId: event.sessionId,
                variant: 'success',
                title: issueNumber ? `Issue #${issueNumber} created` : 'Issue created',
                description:
                  issueNumber && issueUrl
                    ? 'The new issue is ready in GitHub.'
                    : 'The new issue command succeeded.',
                issueUrl,
                issueLabel: issueNumber ? `Open issue #${issueNumber}` : undefined,
              }
            : {
                id: event.sessionId,
                sessionId: event.sessionId,
                variant: 'success',
                title:
                  event.command === 'init'
                    ? `Initialized ${event.repo}`
                    : issueNumber
                      ? `Ship #${issueNumber} succeeded${prMerged === true ? ' · merged' : ''}`
                      : 'Ship succeeded',
                description:
                  event.command === 'init'
                    ? 'Repository labels and settings were updated.'
                    : prMerged === true
                      ? 'The background ship command succeeded and merged.'
                      : 'The background ship command succeeded.',
              };
        pushToast(successToast);
      }
      await refreshRepoAfterBackground(event.repo, event.command, event.status);
    }

    if (event.status === 'complete' && event.command === 'unblock') {
      const refreshedIssues = await refreshRepoAfterBackground(
        event.repo,
        event.command,
        event.status
      );

      if (issueNumber !== undefined) {
        try {
          const issueResult = refreshedIssues ?? (await getShipperApi().listIssues(event.repo));
          if (!issueResult.ok) {
            throw new Error(issueResult.error);
          }

          const stillBlocked = issueResult.issues.some(
            (issue) => issue.number === issueNumber && issue.labels.includes(BLOCKED_LABEL)
          );
          const shouldHandleAutoUnblock = isAutoUnblock && autoShipRepos.has(event.repo);

          if (!shouldHandleAutoUnblock) {
            pushToast({
              id: event.sessionId,
              sessionId: event.sessionId,
              variant: stillBlocked ? 'cancelled' : 'success',
              title: stillBlocked ? `#${issueNumber} remains blocked` : `Unblocked #${issueNumber}`,
              description: stillBlocked
                ? 'The blocking dependencies have not been resolved.'
                : 'The issue is now eligible for shipping.',
            });
            return;
          }

          if (stillBlocked) {
            pushToast({
              id: `auto-unblock-still-blocked-${event.repo}-${issueNumber}-${Date.now()}`,
              sessionId: event.sessionId,
              variant: 'cancelled',
              title: `Auto-ship: #${issueNumber} remains blocked`,
              description: 'The blocking condition has not been resolved.',
            });
          } else {
            pushToast({
              id: `auto-unblock-success-${event.repo}-${issueNumber}-${Date.now()}`,
              sessionId: event.sessionId,
              variant: 'success',
              title: `Auto-ship: unblocked #${issueNumber}`,
              description: 'The issue is now eligible for shipping.',
            });
          }

          const skippedIssueNumbers =
            autoShipSkippedRef.current.get(event.repo) ?? new Set<number>();
          const activeIssueNumbers = getActiveShipIssueNumbers(postEventCommands, event.repo);
          const pausedIssueNumbers = await getPausedIssueNumbersForRepo(event.repo);
          const candidate = await selectNextAutoShipIssue(
            event.repo,
            issueResult.issues,
            activeIssueNumbers,
            skippedIssueNumbers,
            pausedIssueNumbers
          );

          if (candidate) {
            autoUnblockQueueRef.current.delete(event.repo);
            await getShipperApi().spawnBackgroundShip(
              candidate.number,
              event.repo,
              autoMergeRepos.has(event.repo),
              'auto',
              candidate.title
            );
            pushToast({
              id: `auto-ship-${event.repo}-${candidate.number}-${Date.now()}`,
              sessionId: event.sessionId,
              variant: 'success',
              title: `Auto-ship: starting #${candidate.number}`,
              description: candidate.title,
            });
            return;
          }

          const queue = autoUnblockQueueRef.current.get(event.repo) ?? [];
          const nextQueuedIssue = await selectNextAutoUnblockIssue(
            event.repo,
            issueResult.issues,
            queue
          );
          if (!nextQueuedIssue.issue) {
            autoUnblockQueueRef.current.delete(event.repo);
            return;
          }

          trackAutoUnblockIssue(event.repo, nextQueuedIssue.issue.number);
          try {
            await getShipperApi().spawnBackgroundUnblock(
              nextQueuedIssue.issue.number,
              event.repo,
              nextQueuedIssue.issue.title
            );
          } catch {
            console.warn(
              `[shipper] Failed to spawn background unblock for #${nextQueuedIssue.issue.number}`
            );
            pipelineBridgeRef.current?.clearUnblockIssue(nextQueuedIssue.issue.number);
            clearAutoUnblockIssue(event.repo, nextQueuedIssue.issue.number);
            autoUnblockQueueRef.current.delete(event.repo);
            return;
          }

          autoUnblockQueueRef.current.set(event.repo, nextQueuedIssue.remainingIssueNumbers);
          pushToast({
            id: `auto-unblock-${event.repo}-${nextQueuedIssue.issue.number}-${Date.now()}`,
            sessionId: event.sessionId,
            variant: 'success',
            title: `Auto-ship: attempting unblock of #${nextQueuedIssue.issue.number}`,
            description: nextQueuedIssue.issue.title,
          });
        } catch {
          console.warn(`[shipper] Failed to confirm unblock result for #${issueNumber}`);
          if (!isAutoUnblock || !autoShipRepos.has(event.repo)) {
            pushToast({
              id: event.sessionId,
              sessionId: event.sessionId,
              variant: 'cancelled',
              title: `Unblock #${issueNumber} succeeded`,
              description:
                'The unblock agent succeeded, but the latest issue state could not be confirmed.',
            });
            return;
          }

          autoUnblockQueueRef.current.delete(event.repo);
        }
      }
    }

    if (event.status === 'failed') {
      const toastSubject = getBackgroundToastSubject(event.command, event.repo, issueNumber);
      if (cancelled) {
        pushToast({
          id: event.sessionId,
          sessionId: event.sessionId,
          variant: 'cancelled',
          title: `${toastSubject} cancelled`,
          description: 'The background command was stopped before it finished.',
        });
      } else {
        const retryPayload = getBackgroundRetryPayload(
          event.command,
          event.repo,
          request,
          issueNumber,
          merge,
          origin,
          issueTitle
        );

        if (event.command === 'ship' && origin === 'auto' && autoShipEnabled && retriable) {
          pushToast({
            id: event.sessionId,
            sessionId: event.sessionId,
            variant: 'info',
            title: issueNumber
              ? `Auto-ship: #${issueNumber} will retry later`
              : 'Auto-ship will retry later',
            description:
              'A transient merge conflict occurred. The issue remains eligible in this session.',
          });
        } else {
          pushToast({
            id: event.sessionId,
            sessionId: event.sessionId,
            variant: 'error',
            title: `${toastSubject} failed`,
            description:
              latestOutput ??
              (event.exitCode === null || event.exitCode === undefined
                ? 'The background command exited unsuccessfully.'
                : `The command exited with code ${event.exitCode}.`),
            retryable: retryPayload !== undefined,
            retryPayload,
          });
        }
      }

      await refreshRepoAfterBackground(event.repo, event.command, event.status);
    }

    if (
      event.command === 'ship' &&
      (event.status === 'complete' || event.status === 'failed' || event.status === 'paused') &&
      !cancelled &&
      autoShipEnabled
    ) {
      if (event.status !== 'paused') {
        const currentFailures = autoShipFailuresRef.current.get(event.repo) ?? 0;
        const currentSkipped = autoShipSkippedRef.current.get(event.repo) ?? new Set<number>();
        const nextFailureState = getNextAutoShipFailureState(
          event.status,
          issueNumber,
          retriable,
          currentFailures,
          currentSkipped
        );
        autoShipFailuresRef.current.set(event.repo, nextFailureState.consecutiveFailures);
        autoShipSkippedRef.current.set(event.repo, nextFailureState.skippedIssueNumbers);

        if (nextFailureState.pauseAutoShip) {
          clearAutoShipStateForRepo(event.repo);
          pushToast({
            id: `auto-ship-paused-${event.repo}-${Date.now()}`,
            sessionId: event.sessionId,
            variant: 'error',
            title: 'Auto-ship paused',
            description: `${MAX_AUTO_SHIP_CONSECUTIVE_FAILURES} consecutive failures disabled auto-ship for this repository.`,
          });
          return;
        }
      }

      const activeIssueNumbers = getActiveShipIssueNumbers(postEventCommands, event.repo);
      if (activeIssueNumbers.size > 0) {
        return;
      }

      try {
        const issueResult = await getShipperApi().listIssues(event.repo);
        if (!issueResult.ok || !autoShipRepos.has(event.repo)) {
          return;
        }

        const skippedIssueNumbers = autoShipSkippedRef.current.get(event.repo) ?? new Set<number>();
        const pausedIssueNumbers = await getPausedIssueNumbersForRepo(event.repo);
        const nextIssue = await selectNextAutoShipIssue(
          event.repo,
          issueResult.issues,
          activeIssueNumbers,
          skippedIssueNumbers,
          pausedIssueNumbers
        );

        if (!nextIssue) {
          const initialAutoUnblockIssue = await selectInitialAutoUnblockIssue(
            event.repo,
            issueResult.issues
          );
          if (!initialAutoUnblockIssue.issue) {
            autoUnblockQueueRef.current.delete(event.repo);
            return;
          }

          trackAutoUnblockIssue(event.repo, initialAutoUnblockIssue.issue.number);
          try {
            await getShipperApi().spawnBackgroundUnblock(
              initialAutoUnblockIssue.issue.number,
              event.repo,
              initialAutoUnblockIssue.issue.title
            );
          } catch {
            console.warn(
              `[shipper] Failed to spawn background unblock for #${initialAutoUnblockIssue.issue.number}`
            );
            pipelineBridgeRef.current?.clearUnblockIssue(initialAutoUnblockIssue.issue.number);
            clearAutoUnblockIssue(event.repo, initialAutoUnblockIssue.issue.number);
            autoUnblockQueueRef.current.delete(event.repo);
            return;
          }

          autoUnblockQueueRef.current.set(
            event.repo,
            initialAutoUnblockIssue.remainingIssueNumbers
          );
          pushToast({
            id: `auto-unblock-${event.repo}-${initialAutoUnblockIssue.issue.number}-${Date.now()}`,
            sessionId: event.sessionId,
            variant: 'success',
            title: `Auto-ship: attempting unblock of #${initialAutoUnblockIssue.issue.number}`,
            description: initialAutoUnblockIssue.issue.title,
          });
          return;
        }

        autoUnblockQueueRef.current.delete(event.repo);
        await getShipperApi().spawnBackgroundShip(
          nextIssue.number,
          event.repo,
          autoMergeRepos.has(event.repo),
          'auto',
          nextIssue.title
        );
        pushToast({
          id: `auto-ship-${event.repo}-${nextIssue.number}-${Date.now()}`,
          sessionId: event.sessionId,
          variant: 'success',
          title: `Auto-ship: starting #${nextIssue.number}`,
          description: nextIssue.title,
        });
      } catch {
        // Auto-ship enqueue is best-effort; the user can still ship manually.
      }
    }

    if (
      event.command !== 'unblock' ||
      event.status !== 'failed' ||
      cancelled ||
      !isAutoUnblock ||
      !autoShipRepos.has(event.repo)
    ) {
      return;
    }

    try {
      const issueResult = await getShipperApi().listIssues(event.repo);
      if (!issueResult.ok || !autoShipRepos.has(event.repo)) {
        return;
      }

      const skippedIssueNumbers = autoShipSkippedRef.current.get(event.repo) ?? new Set<number>();
      const activeIssueNumbers = getActiveShipIssueNumbers(postEventCommands, event.repo);
      const pausedIssueNumbers = await getPausedIssueNumbersForRepo(event.repo);
      const candidate = await selectNextAutoShipIssue(
        event.repo,
        issueResult.issues,
        activeIssueNumbers,
        skippedIssueNumbers,
        pausedIssueNumbers
      );

      if (candidate) {
        autoUnblockQueueRef.current.delete(event.repo);
        await getShipperApi().spawnBackgroundShip(
          candidate.number,
          event.repo,
          autoMergeRepos.has(event.repo),
          'auto',
          candidate.title
        );
        pushToast({
          id: `auto-ship-${event.repo}-${candidate.number}-${Date.now()}`,
          sessionId: event.sessionId,
          variant: 'success',
          title: `Auto-ship: starting #${candidate.number}`,
          description: candidate.title,
        });
        return;
      }

      const queue = autoUnblockQueueRef.current.get(event.repo) ?? [];
      const nextQueuedIssue = await selectNextAutoUnblockIssue(
        event.repo,
        issueResult.issues,
        queue
      );
      if (!nextQueuedIssue.issue) {
        autoUnblockQueueRef.current.delete(event.repo);
        return;
      }

      trackAutoUnblockIssue(event.repo, nextQueuedIssue.issue.number);
      try {
        await getShipperApi().spawnBackgroundUnblock(
          nextQueuedIssue.issue.number,
          event.repo,
          nextQueuedIssue.issue.title
        );
      } catch {
        console.warn(
          `[shipper] Failed to spawn background unblock for #${nextQueuedIssue.issue.number}`
        );
        pipelineBridgeRef.current?.clearUnblockIssue(nextQueuedIssue.issue.number);
        clearAutoUnblockIssue(event.repo, nextQueuedIssue.issue.number);
        autoUnblockQueueRef.current.delete(event.repo);
        return;
      }

      autoUnblockQueueRef.current.set(event.repo, nextQueuedIssue.remainingIssueNumbers);
      pushToast({
        id: `auto-unblock-${event.repo}-${nextQueuedIssue.issue.number}-${Date.now()}`,
        sessionId: event.sessionId,
        variant: 'success',
        title: `Auto-ship: attempting unblock of #${nextQueuedIssue.issue.number}`,
        description: nextQueuedIssue.issue.title,
      });
    } catch {
      console.warn(`[shipper] Failed to process auto-unblock retry for ${event.repo}`);
      autoUnblockQueueRef.current.delete(event.repo);
    }
  });

  useEffect(() => {
    const unsubscribe = getShipperApi().onBackgroundStatus((event) => {
      void handleBackgroundStatus(event);
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = getShipperApi().onBackgroundOutput((event) => {
      commitBackgroundCommands((currentCommands) =>
        currentCommands.map((command) => {
          if (command.id !== event.sessionId) {
            return command;
          }

          const output = `${command.output}${event.data}`;
          return {
            ...command,
            output,
          };
        })
      );

      setLogViewer((currentViewer) => {
        if (!currentViewer.open || currentViewer.sessionId !== event.sessionId) {
          return currentViewer;
        }

        const activeCommand = backgroundCommandsRef.current.find(
          (command) => command.id === event.sessionId
        );
        if (activeCommand?.command === 'new') {
          return currentViewer;
        }

        return {
          ...currentViewer,
          content: `${currentViewer.content}${event.data}`,
        };
      });
    });

    return unsubscribe;
  }, [commitBackgroundCommands]);

  useEffect(() => {
    if (!logViewer.open || logViewer.sessionId === null || viewedBackgroundCommandType === null) {
      return;
    }

    let cancelled = false;
    const sessionId = logViewer.sessionId;

    const loadOutput = async (): Promise<void> => {
      try {
        const output = await getShipperApi().getBackgroundOutput(sessionId);
        if (cancelled) {
          return;
        }

        setLogViewer((currentViewer) =>
          currentViewer.sessionId === sessionId
            ? { ...currentViewer, content: output }
            : currentViewer
        );
      } catch (error) {
        if (!cancelled) {
          const message = toErrorMessage(error);
          pipelineBridgeRef.current?.setFetchError(`Failed to load background logs: ${message}`);
        }
      }
    };

    void loadOutput();

    if (viewedBackgroundCommandType !== 'new' || viewedBackgroundCommandStatus !== 'running') {
      return () => {
        cancelled = true;
      };
    }

    const intervalId = globalThis.setInterval(() => {
      void loadOutput();
    }, 1_000);

    return () => {
      cancelled = true;
      globalThis.clearInterval(intervalId);
    };
  }, [
    logViewer.open,
    logViewer.sessionId,
    pipelineBridgeRef,
    viewedBackgroundCommandStatus,
    viewedBackgroundCommandType,
  ]);

  const handleDismissBackground = useCallback(
    (sessionId: string) => {
      commitBackgroundCommands((currentCommands) =>
        currentCommands.filter((command) => command.id !== sessionId)
      );
    },
    [commitBackgroundCommands]
  );

  const handleClearFinishedBackground = useCallback(() => {
    commitBackgroundCommands((currentCommands) =>
      currentCommands.filter(
        (command) => command.status === 'queued' || command.status === 'running'
      )
    );
  }, [commitBackgroundCommands]);

  const handleCancelBackground = useCallback(
    async (sessionId: string) => {
      try {
        await getShipperApi().killBackground(sessionId);
      } catch (error) {
        const message = toErrorMessage(error);
        pipelineBridgeRef.current?.setFetchError(`Failed to cancel background command: ${message}`);
      }
    },
    [pipelineBridgeRef]
  );

  const handleShowBackgroundLogs = useCallback(
    async (sessionId: string) => {
      const command = backgroundCommandsRef.current.find((item) => item.id === sessionId);
      if (!command) {
        return;
      }

      setLogViewer({
        open: true,
        sessionId,
        title: getBackgroundLogTitle(command.command, command.repo, command.issueNumber),
        content: command.command === 'new' ? '' : command.output,
      });

      try {
        const output = await getShipperApi().getBackgroundOutput(sessionId);
        setLogViewer((currentViewer) =>
          currentViewer.sessionId === sessionId
            ? { ...currentViewer, content: output }
            : currentViewer
        );
      } catch (error) {
        const message = toErrorMessage(error);
        pipelineBridgeRef.current?.setFetchError(`Failed to open background logs: ${message}`);
      }
    },
    [pipelineBridgeRef]
  );

  const handleRetryToast = useCallback(
    async (toastId: string) => {
      const toast = toasts.find((item) => item.id === toastId);
      if (!toast?.retryPayload) {
        return;
      }

      try {
        await handleRetryBackgroundCommand(toast.retryPayload);
        dismissToast(toastId);
        commitBackgroundCommands((currentCommands) =>
          currentCommands.filter((command) => command.id !== toast.sessionId)
        );
      } catch (error) {
        const message = toErrorMessage(error);
        pipelineBridgeRef.current?.setFetchError(`Failed to retry background command: ${message}`);
        throw error;
      }
    },
    [
      commitBackgroundCommands,
      dismissToast,
      handleRetryBackgroundCommand,
      pipelineBridgeRef,
      toasts,
    ]
  );

  const handleLogViewerOpenChange = useCallback((open: boolean) => {
    setLogViewer((currentViewer) => ({
      ...currentViewer,
      open,
      content: open ? currentViewer.content : '',
      sessionId: open ? currentViewer.sessionId : null,
    }));
  }, []);

  const handleToggleActionQueue = useCallback(() => {
    setActionQueueOpen((current) => !current);
  }, []);

  return {
    backgroundCommands,
    toasts,
    logViewer,
    actionQueueOpen,
    autoShipRepos,
    pausePendingIssues,
    shippingCommands,
    activeCommandRepos,
    pushToast,
    dismissToast,
    handleLogViewerOpenChange,
    handleToggleActionQueue,
    handleDismissBackground,
    handleClearFinishedBackground,
    handleCancelBackground,
    handleShowBackgroundLogs,
    handleRetryToast,
    handlePauseIssue,
    handleResumeIssue,
    enableAutoShipForRepo,
    clearAutoShipStateForRepo,
  };
}
