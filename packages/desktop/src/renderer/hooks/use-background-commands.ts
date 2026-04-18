import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import type { RefObject, SetStateAction } from 'react';

import { BLOCKED_LABEL, LOCKED_LABEL, toErrorMessage } from '@dnsquared/shipper-core';

import {
  getActiveShipIssueNumbers,
  getBackgroundDetail,
  getBackgroundRetryPayload,
  getBackgroundTitle,
  getNextAutoShipFailureState,
  selectNextAutoShipIssue,
  selectNextAutoUnblockIssue,
} from '../lib/app-utils.js';
import { getShipperApi } from '../lib/shipper-api.js';
import { MAX_AUTO_SHIP_CONSECUTIVE_FAILURES } from '../lib/constants.js';
import type {
  ActiveShippingCommand,
  BackgroundCommandKind,
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
  shippingCommands: Map<number, ActiveShippingCommand>;
  activeCommandRepos: Set<string>;
  hasRunningShipCommand: boolean;
  pushToast: (toast: BackgroundToastItem) => void;
  dismissToast: (toastId: string) => void;
  handleLogViewerOpenChange: (open: boolean) => void;
  handleToggleActionQueue: () => void;
  handleDismissBackground: (sessionId: string) => void;
  handleClearFinishedBackground: () => void;
  handleCancelBackground: (sessionId: string) => Promise<void>;
  handleShowBackgroundLogs: (sessionId: string) => Promise<void>;
  handleRetryToast: (toastId: string) => Promise<void>;
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

  const hasRunningShipCommand = useMemo(
    () =>
      backgroundCommands.some(
        (command) =>
          command.command === 'ship' &&
          command.repo === activeRepo &&
          command.status === 'running' &&
          !command.cancelled
      ),
    [activeRepo, backgroundCommands]
  );

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

      if (command === 'new' && status === 'complete') {
        return pipelineBridgeRef.current?.loadIssues(repo) ?? null;
      }

      if (command === 'init' && status === 'complete') {
        void checkInitState(repo);
        return pipelineBridgeRef.current?.loadIssues(repo) ?? null;
      }

      if (command === 'unblock' && (status === 'complete' || status === 'failed')) {
        return pipelineBridgeRef.current?.loadIssues(repo) ?? null;
      }

      if (command === 'ship' && (status === 'complete' || status === 'failed')) {
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
            payload.merge
          );
          return;
        case 'init':
          await getShipperApi().spawnBackgroundInit(payload.repo);
          return;
        case 'unblock':
          pipelineBridgeRef.current?.trackUnblockIssue(payload.issueNumber);
          try {
            await getShipperApi().spawnBackgroundUnblock(payload.issueNumber, payload.repo);
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

  const handleBackgroundStatus = useEffectEvent(async (event: BackgroundStatusPayload) => {
    const previousCommand = backgroundCommandsRef.current.find(
      (command) => command.id === event.sessionId
    );
    const output = previousCommand?.output ?? '';
    const latestOutput = getLatestOutputLine(output);
    const request = event.meta?.request ?? previousCommand?.request;
    const issueNumber = event.meta?.issueNumber ?? previousCommand?.issueNumber;
    const merge = event.meta?.merge ?? previousCommand?.merge ?? false;
    const issueUrl = event.meta?.issueUrl ?? previousCommand?.issueUrl;
    const logFile = event.meta?.logFile ?? previousCommand?.logFile;
    const cancelled = event.meta?.cancelled ?? previousCommand?.cancelled ?? false;
    const isAutoUnblock =
      issueNumber !== undefined && event.command === 'unblock'
        ? isAutoUnblockIssue(event.repo, issueNumber)
        : false;
    const nextCommand: BackgroundCommandState = {
      id: event.sessionId,
      command: event.command,
      repo: event.repo,
      status: event.status,
      title: getBackgroundTitle(event.command, event.repo, issueNumber, merge),
      detail: getBackgroundDetail({
        command: event.command,
        status: event.status,
        repo: event.repo,
        issueNumber,
        merge,
        latestOutput,
        cancelled,
      }),
      output,
      request,
      issueNumber,
      merge,
      issueUrl,
      logFile,
      exitCode: event.exitCode,
      cancelled,
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

    if (event.status === 'complete' && event.command !== 'unblock') {
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
                  : 'The new issue command completed successfully.',
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
                    ? `Ship #${issueNumber} ${merge ? 'merged' : 'finished'}`
                    : 'Ship finished',
              description:
                event.command === 'init'
                  ? 'Repository labels and settings were updated.'
                  : merge
                    ? 'The background ship command completed and merged successfully.'
                    : 'The background ship command completed successfully.',
            };
      pushToast(successToast);
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
          const candidate = selectNextAutoShipIssue(
            issueResult.issues,
            activeIssueNumbers,
            skippedIssueNumbers
          );

          if (candidate) {
            autoUnblockQueueRef.current.delete(event.repo);
            await getShipperApi().spawnBackgroundShip(
              candidate.number,
              event.repo,
              autoMergeRepos.has(event.repo)
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
          const nextQueuedIssue = selectNextAutoUnblockIssue(issueResult.issues, queue);
          if (!nextQueuedIssue.issue) {
            autoUnblockQueueRef.current.delete(event.repo);
            return;
          }

          trackAutoUnblockIssue(event.repo, nextQueuedIssue.issue.number);
          try {
            await getShipperApi().spawnBackgroundUnblock(nextQueuedIssue.issue.number, event.repo);
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
              title: `Unblock #${issueNumber} completed`,
              description:
                'The unblock agent finished, but the latest issue state could not be confirmed.',
            });
            return;
          }

          autoUnblockQueueRef.current.delete(event.repo);
        }
      }
    }

    if (event.status === 'failed') {
      if (cancelled) {
        pushToast({
          id: event.sessionId,
          sessionId: event.sessionId,
          variant: 'cancelled',
          title: `${nextCommand.title} cancelled`,
          description: 'The background command was stopped before it finished.',
        });
      } else {
        const retryPayload = getBackgroundRetryPayload(
          event.command,
          event.repo,
          request,
          issueNumber,
          merge
        );

        pushToast({
          id: event.sessionId,
          sessionId: event.sessionId,
          variant: 'error',
          title: `${nextCommand.title} failed`,
          description:
            latestOutput ??
            (event.exitCode === null || event.exitCode === undefined
              ? 'The background command exited unsuccessfully.'
              : `The command exited with code ${event.exitCode}.`),
          retryable: retryPayload !== undefined,
          retryPayload,
        });
      }

      await refreshRepoAfterBackground(event.repo, event.command, event.status);
    }

    if (
      event.command === 'ship' &&
      (event.status === 'complete' || event.status === 'failed') &&
      !cancelled &&
      autoShipRepos.has(event.repo)
    ) {
      const currentFailures = autoShipFailuresRef.current.get(event.repo) ?? 0;
      const currentSkipped = autoShipSkippedRef.current.get(event.repo) ?? new Set<number>();
      const nextFailureState = getNextAutoShipFailureState(
        event.status,
        issueNumber,
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
        const nextIssue = selectNextAutoShipIssue(
          issueResult.issues,
          activeIssueNumbers,
          skippedIssueNumbers
        );

        if (!nextIssue) {
          const blockedIssues = issueResult.issues.filter(
            (issue) => issue.labels.includes(BLOCKED_LABEL) && !issue.labels.includes(LOCKED_LABEL)
          );

          if (blockedIssues.length === 0) {
            autoUnblockQueueRef.current.delete(event.repo);
            return;
          }

          const firstBlocked = blockedIssues[0];
          if (!firstBlocked) {
            autoUnblockQueueRef.current.delete(event.repo);
            return;
          }

          const remainingIssueNumbers = blockedIssues.slice(1).map((issue) => issue.number);
          trackAutoUnblockIssue(event.repo, firstBlocked.number);
          try {
            await getShipperApi().spawnBackgroundUnblock(firstBlocked.number, event.repo);
          } catch {
            console.warn(
              `[shipper] Failed to spawn background unblock for #${firstBlocked.number}`
            );
            pipelineBridgeRef.current?.clearUnblockIssue(firstBlocked.number);
            clearAutoUnblockIssue(event.repo, firstBlocked.number);
            autoUnblockQueueRef.current.delete(event.repo);
            return;
          }

          autoUnblockQueueRef.current.set(event.repo, remainingIssueNumbers);
          pushToast({
            id: `auto-unblock-${event.repo}-${firstBlocked.number}-${Date.now()}`,
            sessionId: event.sessionId,
            variant: 'success',
            title: `Auto-ship: attempting unblock of #${firstBlocked.number}`,
            description: firstBlocked.title,
          });
          return;
        }

        autoUnblockQueueRef.current.delete(event.repo);
        await getShipperApi().spawnBackgroundShip(
          nextIssue.number,
          event.repo,
          autoMergeRepos.has(event.repo)
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
      const candidate = selectNextAutoShipIssue(
        issueResult.issues,
        activeIssueNumbers,
        skippedIssueNumbers
      );

      if (candidate) {
        autoUnblockQueueRef.current.delete(event.repo);
        await getShipperApi().spawnBackgroundShip(
          candidate.number,
          event.repo,
          autoMergeRepos.has(event.repo)
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
      const nextQueuedIssue = selectNextAutoUnblockIssue(issueResult.issues, queue);
      if (!nextQueuedIssue.issue) {
        autoUnblockQueueRef.current.delete(event.repo);
        return;
      }

      trackAutoUnblockIssue(event.repo, nextQueuedIssue.issue.number);
      try {
        await getShipperApi().spawnBackgroundUnblock(nextQueuedIssue.issue.number, event.repo);
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
            detail: getBackgroundDetail({
              command: command.command,
              status: command.status,
              repo: command.repo,
              issueNumber: command.issueNumber,
              merge: command.merge,
              latestOutput: getLatestOutputLine(output),
              cancelled: command.cancelled,
            }),
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
    shippingCommands,
    activeCommandRepos,
    hasRunningShipCommand,
    pushToast,
    dismissToast,
    handleLogViewerOpenChange,
    handleToggleActionQueue,
    handleDismissBackground,
    handleClearFinishedBackground,
    handleCancelBackground,
    handleShowBackgroundLogs,
    handleRetryToast,
    enableAutoShipForRepo,
    clearAutoShipStateForRepo,
  };
}
