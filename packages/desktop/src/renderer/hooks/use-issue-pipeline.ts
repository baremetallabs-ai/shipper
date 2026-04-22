import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import {
  FAILED_LABEL,
  NEW_LABEL,
  toErrorMessage,
  type ListIssueItem,
} from '@dnsquared/shipper-core';

import { syncWorkflowStageCacheForRepo } from '../lib/app-utils.js';
import { getShipperApi } from '../lib/shipper-api.js';
import { PIPELINE_COLUMNS } from '../lib/constants.js';
import type {
  BackgroundToastItem,
  IssueListResult,
  PipelineIssue,
  PipelineColumnLabel,
  ResetSelection,
} from '../types.js';

interface UseIssuePipelineOptions {
  activeRepo: string;
  canFetch: boolean;
  hasActiveRepo: boolean;
  hasRunningShipCommand: boolean;
  pushToast: (toast: BackgroundToastItem) => void;
}

export interface UseIssuePipelineResult {
  issues: PipelineIssue[];
  stageCache: Map<string, string>;
  isLoading: boolean;
  fetchError: string | null;
  lastUpdated: Date | null;
  pausedIssues: Set<number>;
  resettingIssues: Set<number>;
  unlockingIssues: Set<number>;
  unblockingIssues: Set<number>;
  settingPriorityIssues: Set<number>;
  resetSelection: ResetSelection | null;
  closeNotPlannedIssue: ListIssueItem | null;
  unlockConfirmIssue: ListIssueItem | null;
  isNewIssueOpen: boolean;
  isAdoptOpen: boolean;
  attentionIssues: {
    failed: PipelineIssue[];
    new: PipelineIssue[];
  };
  columnMap: Map<PipelineColumnLabel, PipelineIssue[]>;
  setFetchError: Dispatch<SetStateAction<string | null>>;
  setResetSelection: Dispatch<SetStateAction<ResetSelection | null>>;
  setCloseNotPlannedIssue: Dispatch<SetStateAction<ListIssueItem | null>>;
  setUnlockConfirmIssue: Dispatch<SetStateAction<ListIssueItem | null>>;
  setIsNewIssueOpen: Dispatch<SetStateAction<boolean>>;
  setIsAdoptOpen: Dispatch<SetStateAction<boolean>>;
  loadIssues: (repo: string) => Promise<IssueListResult | null>;
  refreshIssuesForActiveRepo: (repo: string) => Promise<void>;
  clearIssueState: () => void;
  clearStageCacheForRepo: (repo: string) => void;
  getIssueByNumber: (issueNumber: number) => ListIssueItem | undefined;
  handleRefresh: () => Promise<void>;
  trackPausedIssue: (issueNumber: number) => void;
  clearPausedIssue: (issueNumber: number) => void;
  trackResetIssue: (issueNumber: number) => void;
  clearResetIssue: (issueNumber: number) => void;
  trackUnlockIssue: (issueNumber: number) => void;
  clearUnlockIssue: (issueNumber: number) => void;
  trackUnblockIssue: (issueNumber: number) => void;
  clearUnblockIssue: (issueNumber: number) => void;
  trackSettingPriorityIssue: (issueNumber: number) => void;
  clearSettingPriorityIssue: (issueNumber: number) => void;
  handleResetSuccess: (issueNumber: number) => void;
  handleCloseNotPlannedSuccess: (issueNumber: number) => void;
  handleCloseNotPlannedError: (issueNumber: number, error: string) => void;
  handleUnlockClick: (issue: ListIssueItem) => Promise<void>;
  handleUnlockDialogConfirm: () => Promise<void>;
  handleUnblockClick: (issue: ListIssueItem) => Promise<void>;
  handleSetPriority: (issue: ListIssueItem, level: 'high' | 'normal' | 'low') => Promise<void>;
  handleOpenNewIssue: () => void;
  handleOpenAdopt: () => void;
}

export function useIssuePipeline({
  activeRepo,
  canFetch,
  hasActiveRepo,
  hasRunningShipCommand,
  pushToast,
}: UseIssuePipelineOptions): UseIssuePipelineResult {
  const [issues, setIssues] = useState<PipelineIssue[]>([]);
  const [stageCache, setStageCache] = useState<Map<string, string>>(new Map());
  const [isLoading, setIsLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [resetSelection, setResetSelection] = useState<ResetSelection | null>(null);
  const [closeNotPlannedIssue, setCloseNotPlannedIssue] = useState<ListIssueItem | null>(null);
  const [unlockConfirmIssue, setUnlockConfirmIssue] = useState<ListIssueItem | null>(null);
  const [resettingIssues, setResettingIssues] = useState<Set<number>>(new Set());
  const [unlockingIssues, setUnlockingIssues] = useState<Set<number>>(new Set());
  const [unblockingIssues, setUnblockingIssues] = useState<Set<number>>(new Set());
  const [settingPriorityIssues, setSettingPriorityIssues] = useState<Set<number>>(new Set());
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [pausedIssues, setPausedIssues] = useState<Set<number>>(new Set());
  const [isNewIssueOpen, setIsNewIssueOpen] = useState(false);
  const [isAdoptOpen, setIsAdoptOpen] = useState(false);
  const requestVersionRef = useRef(0);

  const { attentionIssues, columnMap } = useMemo(() => {
    const nextColumnMap = new Map<PipelineColumnLabel, PipelineIssue[]>(
      PIPELINE_COLUMNS.map((label) => [label, []])
    );
    const nextAttentionIssues = {
      failed: [] as PipelineIssue[],
      new: [] as PipelineIssue[],
    };

    for (const issue of issues) {
      if (issue.labels.includes(FAILED_LABEL)) {
        nextAttentionIssues.failed.push(issue);
        continue;
      }

      if (issue.labels.includes(NEW_LABEL)) {
        nextAttentionIssues.new.push(issue);
        continue;
      }

      let stageLabel: PipelineColumnLabel | null = null;
      for (let index = PIPELINE_COLUMNS.length - 1; index >= 0; index -= 1) {
        const label = PIPELINE_COLUMNS[index];
        if (label && issue.labels.includes(label)) {
          stageLabel = label;
          break;
        }
      }

      if (!stageLabel) {
        continue;
      }

      const columnIssues = nextColumnMap.get(stageLabel);
      if (!columnIssues) {
        throw new Error(`Invariant failed: missing issue bucket for ${stageLabel}`);
      }

      columnIssues.push(issue);
    }

    return {
      attentionIssues: nextAttentionIssues,
      columnMap: nextColumnMap,
    };
  }, [issues]);

  const clearIssueState = useCallback(() => {
    requestVersionRef.current += 1;
    setIssues([]);
    setLastUpdated(null);
    setFetchError(null);
    setIsLoading(false);
    setPausedIssues(new Set());
    setResetSelection(null);
    setCloseNotPlannedIssue(null);
    setUnlockConfirmIssue(null);
    setResettingIssues(new Set());
    setUnlockingIssues(new Set());
    setUnblockingIssues(new Set());
    setSettingPriorityIssues(new Set());
  }, []);

  const clearStageCacheForRepo = useCallback((repo: string) => {
    setStageCache((current) => syncWorkflowStageCacheForRepo(current, repo, []));
  }, []);

  const getIssueByNumber = useCallback(
    (issueNumber: number) => issues.find((issue) => issue.number === issueNumber),
    [issues]
  );

  const loadIssues = useCallback(async (repo: string) => {
    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    setIsLoading(true);
    setFetchError(null);

    try {
      const result = await getShipperApi().listIssues(repo);
      if (requestVersion !== requestVersionRef.current) {
        return null;
      }

      if (!result.ok) {
        setFetchError(result.error);
        return result;
      }

      setIssues(result.issues);
      setStageCache((current) => syncWorkflowStageCacheForRepo(current, repo, result.issues));
      setLastUpdated(new Date());
      return result;
    } catch (error) {
      if (requestVersion !== requestVersionRef.current) {
        return null;
      }

      setFetchError(toErrorMessage(error));
      return null;
    } finally {
      if (requestVersion === requestVersionRef.current) {
        setIsLoading(false);
      }
    }
  }, []);

  const refreshIssuesForActiveRepo = useCallback(
    async (repo: string) => {
      if (repo !== activeRepo) {
        return;
      }

      await loadIssues(repo);
    },
    [activeRepo, loadIssues]
  );

  useEffect(() => {
    return () => {
      requestVersionRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!canFetch || !hasActiveRepo) {
      setPausedIssues(new Set());
      return;
    }

    let cancelled = false;
    void getShipperApi()
      .listPausedIssues(activeRepo)
      .then((issueNumbers) => {
        if (!cancelled) {
          setPausedIssues(new Set(issueNumbers));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPausedIssues(new Set());
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeRepo, canFetch, hasActiveRepo]);

  useEffect(() => {
    if (!canFetch || !hasActiveRepo) {
      return;
    }

    const intervalMs = hasRunningShipCommand ? 10_000 : 60_000;
    const intervalId = globalThis.setInterval(() => {
      void loadIssues(activeRepo);
    }, intervalMs);

    return () => {
      globalThis.clearInterval(intervalId);
    };
  }, [activeRepo, canFetch, hasActiveRepo, hasRunningShipCommand, loadIssues]);

  const handleRefresh = useCallback(async () => {
    if (!canFetch || !hasActiveRepo || isLoading) {
      return;
    }

    await loadIssues(activeRepo);
  }, [activeRepo, canFetch, hasActiveRepo, isLoading, loadIssues]);

  const trackResetIssue = useCallback((issueNumber: number) => {
    setResettingIssues((current) => new Set(current).add(issueNumber));
  }, []);

  const trackPausedIssue = useCallback((issueNumber: number) => {
    setPausedIssues((current) => new Set(current).add(issueNumber));
  }, []);

  const clearPausedIssue = useCallback((issueNumber: number) => {
    setPausedIssues((current) => {
      const next = new Set(current);
      next.delete(issueNumber);
      return next;
    });
  }, []);

  const clearResetIssue = useCallback((issueNumber: number) => {
    setResettingIssues((current) => {
      const next = new Set(current);
      next.delete(issueNumber);
      return next;
    });
  }, []);

  const trackUnlockIssue = useCallback((issueNumber: number) => {
    setUnlockingIssues((current) => new Set(current).add(issueNumber));
  }, []);

  const clearUnlockIssue = useCallback((issueNumber: number) => {
    setUnlockingIssues((current) => {
      const next = new Set(current);
      next.delete(issueNumber);
      return next;
    });
  }, []);

  const trackUnblockIssue = useCallback((issueNumber: number) => {
    setUnblockingIssues((current) => new Set(current).add(issueNumber));
  }, []);

  const clearUnblockIssue = useCallback((issueNumber: number) => {
    setUnblockingIssues((current) => {
      const next = new Set(current);
      next.delete(issueNumber);
      return next;
    });
  }, []);

  const trackSettingPriorityIssue = useCallback((issueNumber: number) => {
    setSettingPriorityIssues((current) => new Set(current).add(issueNumber));
  }, []);

  const clearSettingPriorityIssue = useCallback((issueNumber: number) => {
    setSettingPriorityIssues((current) => {
      const next = new Set(current);
      next.delete(issueNumber);
      return next;
    });
  }, []);

  const handleResetSuccess = useCallback(
    (issueNumber: number) => {
      clearResetIssue(issueNumber);
      if (activeRepo) {
        void loadIssues(activeRepo);
      }
    },
    [activeRepo, clearResetIssue, loadIssues]
  );

  const handleCloseNotPlannedSuccess = useCallback(
    (issueNumber: number) => {
      setCloseNotPlannedIssue(null);
      pushToast({
        id: `close-not-planned-${issueNumber}`,
        sessionId: '',
        variant: 'success',
        title: 'Issue closed',
        description: `#${issueNumber} closed as not planned.`,
      });
      if (activeRepo) {
        void loadIssues(activeRepo);
      }
    },
    [activeRepo, loadIssues, pushToast]
  );

  const handleCloseNotPlannedError = useCallback(
    (issueNumber: number, error: string) => {
      setCloseNotPlannedIssue(null);
      pushToast({
        id: `close-not-planned-error-${issueNumber}`,
        sessionId: '',
        variant: 'error',
        title: 'Failed to close issue',
        description: error,
      });
      if (activeRepo) {
        void loadIssues(activeRepo);
      }
    },
    [activeRepo, loadIssues, pushToast]
  );

  const handleUnlockExecute = useCallback(
    async (issue: ListIssueItem, repo = activeRepo) => {
      if (!repo) {
        return;
      }

      trackUnlockIssue(issue.number);

      try {
        const result = await getShipperApi().unlockIssue(repo, issue.number);
        if (!result.ok) {
          pushToast({
            id: `unlock-issue-error-${issue.number}`,
            sessionId: '',
            variant: 'error',
            title: 'Failed to unlock issue',
            description: result.error,
          });
          return;
        }

        pushToast({
          id: `unlock-issue-${issue.number}`,
          sessionId: '',
          variant: 'success',
          title: 'Issue unlocked',
          description: `#${issue.number} lock removed.`,
        });
        await refreshIssuesForActiveRepo(repo);
      } catch (error) {
        pushToast({
          id: `unlock-issue-error-${issue.number}`,
          sessionId: '',
          variant: 'error',
          title: 'Failed to unlock issue',
          description: toErrorMessage(error),
        });
      } finally {
        setUnlockConfirmIssue(null);
        clearUnlockIssue(issue.number);
      }
    },
    [activeRepo, clearUnlockIssue, pushToast, refreshIssuesForActiveRepo, trackUnlockIssue]
  );

  const handleSetPriority = useCallback(
    async (issue: ListIssueItem, level: 'high' | 'normal' | 'low') => {
      if (!activeRepo || settingPriorityIssues.has(issue.number)) {
        return;
      }

      const repo = activeRepo;
      trackSettingPriorityIssue(issue.number);

      try {
        const result = await getShipperApi().setPriority(repo, issue.number, level);
        if (!result.ok) {
          pushToast({
            id: `set-priority-error-${issue.number}`,
            sessionId: '',
            variant: 'error',
            title: 'Failed to set priority',
            description: result.error,
          });
          return;
        }

        pushToast({
          id: `set-priority-${issue.number}`,
          sessionId: '',
          variant: 'success',
          title: 'Priority updated',
          description: `#${issue.number} set to ${level}.`,
        });
        await refreshIssuesForActiveRepo(repo);
      } catch (error) {
        pushToast({
          id: `set-priority-error-${issue.number}`,
          sessionId: '',
          variant: 'error',
          title: 'Failed to set priority',
          description: toErrorMessage(error),
        });
      } finally {
        clearSettingPriorityIssue(issue.number);
      }
    },
    [
      activeRepo,
      clearSettingPriorityIssue,
      pushToast,
      refreshIssuesForActiveRepo,
      settingPriorityIssues,
      trackSettingPriorityIssue,
    ]
  );

  const handleUnlockClick = useCallback(
    async (issue: ListIssueItem) => {
      if (!activeRepo) {
        return;
      }

      const repo = activeRepo;
      let clearPendingState = true;
      trackUnlockIssue(issue.number);

      try {
        const result = await getShipperApi().checkLockStale(repo, issue.number);
        if (result.stale) {
          clearPendingState = false;
          await handleUnlockExecute(issue, repo);
          return;
        }

        setUnlockConfirmIssue(issue);
      } catch (error) {
        pushToast({
          id: `unlock-issue-check-error-${issue.number}`,
          sessionId: '',
          variant: 'error',
          title: 'Failed to check issue lock',
          description: toErrorMessage(error),
        });
      } finally {
        if (clearPendingState) {
          clearUnlockIssue(issue.number);
        }
      }
    },
    [activeRepo, clearUnlockIssue, handleUnlockExecute, pushToast, trackUnlockIssue]
  );

  const handleUnlockDialogConfirm = useCallback(async () => {
    if (unlockConfirmIssue === null) {
      return;
    }

    await handleUnlockExecute(unlockConfirmIssue);
  }, [handleUnlockExecute, unlockConfirmIssue]);

  const handleUnblockClick = useCallback(
    async (issue: ListIssueItem) => {
      if (!activeRepo) {
        return;
      }

      trackUnblockIssue(issue.number);

      try {
        await getShipperApi().spawnBackgroundUnblock(issue.number, activeRepo);
      } catch (error) {
        pushToast({
          id: `unblock-spawn-error-${issue.number}`,
          sessionId: '',
          variant: 'error',
          title: 'Failed to start unblock',
          description: toErrorMessage(error),
        });
        clearUnblockIssue(issue.number);
      }
    },
    [activeRepo, clearUnblockIssue, pushToast, trackUnblockIssue]
  );

  const handleOpenNewIssue = useCallback(() => {
    setIsNewIssueOpen(true);
  }, []);

  const handleOpenAdopt = useCallback(() => {
    setIsAdoptOpen(true);
  }, []);

  return {
    issues,
    stageCache,
    isLoading,
    fetchError,
    lastUpdated,
    pausedIssues,
    resettingIssues,
    unlockingIssues,
    unblockingIssues,
    settingPriorityIssues,
    resetSelection,
    closeNotPlannedIssue,
    unlockConfirmIssue,
    isNewIssueOpen,
    isAdoptOpen,
    attentionIssues,
    columnMap,
    setFetchError,
    setResetSelection,
    setCloseNotPlannedIssue,
    setUnlockConfirmIssue,
    setIsNewIssueOpen,
    setIsAdoptOpen,
    loadIssues,
    refreshIssuesForActiveRepo,
    clearIssueState,
    clearStageCacheForRepo,
    getIssueByNumber,
    handleRefresh,
    trackPausedIssue,
    clearPausedIssue,
    trackResetIssue,
    clearResetIssue,
    trackUnlockIssue,
    clearUnlockIssue,
    trackUnblockIssue,
    clearUnblockIssue,
    trackSettingPriorityIssue,
    clearSettingPriorityIssue,
    handleResetSuccess,
    handleCloseNotPlannedSuccess,
    handleCloseNotPlannedError,
    handleUnlockClick,
    handleUnlockDialogConfirm,
    handleUnblockClick,
    handleSetPriority,
    handleOpenNewIssue,
    handleOpenAdopt,
  };
}
