import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import { NEW_LABEL } from '../../../../core/src/lib/labels.js';
import { toErrorMessage } from '../../../../core/src/lib/errors.js';
import type { ListIssueItem } from '@dnsquared/shipper-core';

import { syncWorkflowStageCacheForRepo } from '../lib/app-utils.js';
import { getShipperApi } from '../lib/shipper-api.js';
import { PIPELINE_COLUMNS } from '../lib/constants.js';
import type {
  BackgroundToastItem,
  IssueListResult,
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
  issues: ListIssueItem[];
  stageCache: Map<string, string>;
  isLoading: boolean;
  fetchError: string | null;
  lastUpdated: Date | null;
  resettingIssues: Set<number>;
  unlockingIssues: Set<number>;
  unblockingIssues: Set<number>;
  settingPriorityIssues: Set<number>;
  resetSelection: ResetSelection | null;
  closeNotPlannedIssue: ListIssueItem | null;
  unlockConfirmIssue: ListIssueItem | null;
  isNewIssueOpen: boolean;
  isAdoptOpen: boolean;
  attentionIssues: ListIssueItem[];
  columnMap: Map<PipelineColumnLabel, ListIssueItem[]>;
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
  handleRefresh: () => Promise<void>;
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
  const [issues, setIssues] = useState<ListIssueItem[]>([]);
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
  const [isNewIssueOpen, setIsNewIssueOpen] = useState(false);
  const [isAdoptOpen, setIsAdoptOpen] = useState(false);
  const requestVersionRef = useRef(0);

  const { attentionIssues, columnMap } = useMemo(() => {
    const nextColumnMap = new Map<PipelineColumnLabel, ListIssueItem[]>(
      PIPELINE_COLUMNS.map((label) => [label, []])
    );
    const nextAttentionIssues: ListIssueItem[] = [];

    for (const issue of issues) {
      if (issue.labels.includes(NEW_LABEL)) {
        nextAttentionIssues.push(issue);
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

  const clearIssueState = useEffectEvent(() => {
    requestVersionRef.current += 1;
    setIssues([]);
    setLastUpdated(null);
    setFetchError(null);
    setIsLoading(false);
    setResetSelection(null);
    setCloseNotPlannedIssue(null);
    setUnlockConfirmIssue(null);
    setResettingIssues(new Set());
    setUnlockingIssues(new Set());
    setUnblockingIssues(new Set());
    setSettingPriorityIssues(new Set());
  });

  const clearStageCacheForRepo = useEffectEvent((repo: string) => {
    setStageCache((current) => syncWorkflowStageCacheForRepo(current, repo, []));
  });

  const loadIssues = useEffectEvent(async (repo: string) => {
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
  });

  const refreshIssuesForActiveRepo = useEffectEvent(async (repo: string) => {
    if (repo !== activeRepo) {
      return;
    }

    await loadIssues(repo);
  });

  useEffect(() => {
    return () => {
      requestVersionRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!canFetch || !hasActiveRepo) {
      return;
    }

    const intervalId = globalThis.setInterval(() => {
      void loadIssues(activeRepo);
    }, 60_000);

    return () => {
      globalThis.clearInterval(intervalId);
    };
  }, [activeRepo, canFetch, hasActiveRepo, loadIssues]);

  useEffect(() => {
    if (!canFetch || !hasActiveRepo || !hasRunningShipCommand) {
      return;
    }

    const intervalId = globalThis.setInterval(() => {
      void loadIssues(activeRepo);
    }, 10_000);

    return () => {
      globalThis.clearInterval(intervalId);
    };
  }, [activeRepo, canFetch, hasActiveRepo, hasRunningShipCommand, loadIssues]);

  const handleRefresh = useEffectEvent(async () => {
    if (!canFetch || !hasActiveRepo || isLoading) {
      return;
    }

    await loadIssues(activeRepo);
  });

  const trackResetIssue = useEffectEvent((issueNumber: number) => {
    setResettingIssues((current) => new Set(current).add(issueNumber));
  });

  const clearResetIssue = useEffectEvent((issueNumber: number) => {
    setResettingIssues((current) => {
      const next = new Set(current);
      next.delete(issueNumber);
      return next;
    });
  });

  const trackUnlockIssue = useEffectEvent((issueNumber: number) => {
    setUnlockingIssues((current) => new Set(current).add(issueNumber));
  });

  const clearUnlockIssue = useEffectEvent((issueNumber: number) => {
    setUnlockingIssues((current) => {
      const next = new Set(current);
      next.delete(issueNumber);
      return next;
    });
  });

  const trackUnblockIssue = useEffectEvent((issueNumber: number) => {
    setUnblockingIssues((current) => new Set(current).add(issueNumber));
  });

  const clearUnblockIssue = useEffectEvent((issueNumber: number) => {
    setUnblockingIssues((current) => {
      const next = new Set(current);
      next.delete(issueNumber);
      return next;
    });
  });

  const trackSettingPriorityIssue = useEffectEvent((issueNumber: number) => {
    setSettingPriorityIssues((current) => new Set(current).add(issueNumber));
  });

  const clearSettingPriorityIssue = useEffectEvent((issueNumber: number) => {
    setSettingPriorityIssues((current) => {
      const next = new Set(current);
      next.delete(issueNumber);
      return next;
    });
  });

  const handleResetSuccess = useEffectEvent((issueNumber: number) => {
    clearResetIssue(issueNumber);
    if (activeRepo) {
      void loadIssues(activeRepo);
    }
  });

  const handleCloseNotPlannedSuccess = useEffectEvent((issueNumber: number) => {
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
  });

  const handleCloseNotPlannedError = useEffectEvent((issueNumber: number, error: string) => {
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
  });

  const handleUnlockExecute = useEffectEvent(async (issue: ListIssueItem, repo = activeRepo) => {
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
  });

  const handleSetPriority = useEffectEvent(
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
    }
  );

  const handleUnlockClick = useEffectEvent(async (issue: ListIssueItem) => {
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
  });

  const handleUnlockDialogConfirm = useEffectEvent(async () => {
    if (unlockConfirmIssue === null) {
      return;
    }

    await handleUnlockExecute(unlockConfirmIssue);
  });

  const handleUnblockClick = useEffectEvent(async (issue: ListIssueItem) => {
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
  });

  const handleOpenNewIssue = useEffectEvent(() => {
    setIsNewIssueOpen(true);
  });

  const handleOpenAdopt = useEffectEvent(() => {
    setIsAdoptOpen(true);
  });

  return {
    issues,
    stageCache,
    isLoading,
    fetchError,
    lastUpdated,
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
    handleRefresh,
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
