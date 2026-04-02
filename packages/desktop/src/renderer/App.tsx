import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import type { DragEvent, JSX, SetStateAction } from 'react';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  EllipsisVertical,
  LoaderCircle,
  Square,
} from 'lucide-react';

import {
  BLOCKED_LABEL,
  DISPLAY_NAME_MAP,
  getPriorityTier,
  LOCKED_LABEL,
  NEW_LABEL,
  READY_LABEL,
} from '../../../core/src/lib/labels.js';
import type { ListIssueItem, WorkflowStage } from '@dnsquared/shipper-core';

import { AdoptDialog } from './components/adopt-dialog.js';
import { ActionQueueDrawer } from './components/action-queue-drawer.js';
import { BackgroundLogViewer } from './components/background-log-viewer.js';
import { BackgroundToastRegion } from './components/background-toast-region.js';
import { CloseNotPlannedDialog } from './components/close-not-planned-dialog.js';
import { NewIssueDialog } from './components/new-issue-dialog.js';
import { ResetConfirmDialog } from './components/reset-confirm-dialog.js';
import { RepoPickerDialog } from './components/repo-picker-dialog.js';
import { RepoTabBar } from './components/repo-tab-bar.js';
import { UnlockConfirmDialog } from './components/unlock-confirm-dialog.js';
import { TerminalPanel } from './components/terminal-panel.js';
import { Alert, AlertDescription, AlertTitle } from './components/ui/alert.js';
import { Badge } from './components/ui/badge.js';
import { Button } from './components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './components/ui/dialog.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './components/ui/dropdown-menu.js';
import {
  getActiveShipIssueNumbers,
  getBackgroundDetail,
  getBackgroundRetryPayload,
  getBackgroundTitle,
  getNextAutoShipFailureState,
  getWorkflowStageDisplayName,
  selectNextAutoShipIssue,
  selectNextAutoUnblockIssue,
} from './lib/app-utils.js';
import {
  COLUMN_RESET_STAGE,
  dateFormatter,
  MAX_AUTO_SHIP_CONSECUTIVE_FAILURES,
  PIPELINE_COLUMNS,
  POST_IMPLEMENTATION_LABELS,
  repoPattern,
  RESET_STAGE_LABELS,
  RESET_STAGE_ORDER,
} from './lib/constants.js';
import { cn } from './lib/utils.js';
import type {
  ActiveShippingCommand,
  AppConfig,
  BackgroundCommandKind,
  BackgroundCommandStatus,
  BackgroundCommandState,
  BackgroundLogViewerState,
  BackgroundOutputPayload,
  BackgroundRetryPayload,
  BackgroundStatusPayload,
  BackgroundToastItem,
  PipelineColumnLabel,
  Prerequisites,
  ResetSelection,
  TerminalSession,
} from './types.js';

function isValidRepo(repo: string): boolean {
  return repoPattern.test(repo);
}

function toRepoKey(repo: string): string {
  return repo.trim().toLowerCase();
}

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

function getNextActiveSessionId(
  sessions: TerminalSession[],
  activeSessionId: string | null,
  removedSessionId: string
): string | null {
  if (activeSessionId !== removedSessionId) {
    return activeSessionId;
  }

  const removedIndex = sessions.findIndex((session) => session.id === removedSessionId);
  const remainingSessions = sessions.filter((session) => session.id !== removedSessionId);
  if (removedIndex < 0) {
    return remainingSessions[0]?.id ?? null;
  }

  return remainingSessions[removedIndex - 1]?.id ?? remainingSessions[removedIndex]?.id ?? null;
}

function getPrerequisiteMessage(prerequisites: Prerequisites | null): string | null {
  if (!prerequisites) {
    return null;
  }

  if (!prerequisites.ghInstalled.ok) {
    return prerequisites.ghInstalled.message;
  }

  if (!prerequisites.ghAuth.ok) {
    return prerequisites.ghAuth.message;
  }

  return null;
}

function getResetTargets(labels: string[]): WorkflowStage[] {
  const hasPrLabels = POST_IMPLEMENTATION_LABELS.some((label) => labels.includes(label));
  if (hasPrLabels) {
    return RESET_STAGE_ORDER.map(({ stage }) => stage);
  }

  for (let index = RESET_STAGE_ORDER.length - 1; index >= 0; index -= 1) {
    const entry = RESET_STAGE_ORDER[index];
    if (entry && labels.includes(entry.label)) {
      return RESET_STAGE_ORDER.slice(0, index).map(({ stage }) => stage);
    }
  }

  return [];
}

function getResetTargetLabel(stage: WorkflowStage): string {
  return DISPLAY_NAME_MAP[RESET_STAGE_LABELS[stage]] ?? stage;
}

function isValidDropTarget(
  source: { issue: ListIssueItem; columnIndex: number },
  targetColumnIndex: number
): boolean {
  if (targetColumnIndex >= source.columnIndex) return false;
  const targetLabel = PIPELINE_COLUMNS[targetColumnIndex];
  if (!targetLabel) return false;
  const targetStage = COLUMN_RESET_STAGE[targetLabel];
  if (!targetStage) return false;
  const resetTargets = getResetTargets(source.issue.labels);
  return resetTargets.includes(targetStage);
}

function findActiveIssueSession(
  sessions: TerminalSession[],
  repo: string,
  issueNumber: number
): TerminalSession | undefined {
  return sessions.find(
    (session) =>
      session.repo === repo && session.issueNumber === issueNumber && session.status !== 'exited'
  );
}

interface IssueCardProps {
  issue: ListIssueItem;
  onGroom?: (issueNumber: number) => void;
  onResetSelect?: (targetStage: WorkflowStage) => void;
  onSetPriority?: (level: 'high' | 'normal' | 'low') => void;
  onCloseNotPlanned?: () => void;
  onUnlock?: () => void;
  onUnblock?: () => void;
  resetTargets?: WorkflowStage[];
  groomDisabled?: boolean;
  isResetting?: boolean;
  isUnlocking?: boolean;
  isUnblocking?: boolean;
  isSettingPriority?: boolean;
  onShip?: (issueNumber: number) => void;
  shipDisabled?: boolean;
  shippingStatus?: 'queued' | 'running';
  onStopShip?: () => void;
  draggable?: boolean;
  onDragStart?: (e: DragEvent) => void;
  onDragEnd?: () => void;
}

function IssueCard({
  issue,
  onGroom,
  onResetSelect,
  onSetPriority,
  onCloseNotPlanned,
  onUnlock,
  onUnblock,
  resetTargets = [],
  groomDisabled = false,
  isResetting = false,
  isUnlocking = false,
  isUnblocking = false,
  isSettingPriority = false,
  onShip,
  shipDisabled = false,
  shippingStatus,
  onStopShip,
  draggable,
  onDragStart,
  onDragEnd,
}: IssueCardProps): JSX.Element {
  const isBlocked = issue.labels.includes(BLOCKED_LABEL);
  const isLocked = issue.labels.includes(LOCKED_LABEL);
  const priorityTier = getPriorityTier(issue.labels);
  const isShipping = !!shippingStatus;
  const isBusy = isResetting || isUnlocking || isUnblocking;
  const isMenuDisabled = isBusy || isSettingPriority;
  const busyLabel = isResetting
    ? 'Resetting...'
    : isUnlocking
      ? 'Unlocking...'
      : isUnblocking
        ? 'Unblocking...'
        : null;
  const isGroomDisabled = groomDisabled || isBlocked || isLocked || isShipping;
  const canUnlock = isLocked && !!onUnlock && !isShipping;
  const canUnblock = isBlocked && !isLocked && !!onUnblock && !isShipping;
  const canCloseNotPlanned = !!onCloseNotPlanned && !isLocked && !isShipping;
  const hasResetMenu = onResetSelect !== undefined && resetTargets.length > 0 && !isShipping;
  const hasPriorityMenu = onSetPriority !== undefined;
  const hasFlatActions = canCloseNotPlanned || canUnlock || canUnblock;
  const showOverflowMenu = hasResetMenu || hasFlatActions || hasPriorityMenu;
  const showStopShipButton = isShipping && onStopShip !== undefined;
  const isShipDisabled = shipDisabled || isBlocked || isLocked || isShipping;

  function handleUnlockSelect(): void {
    onUnlock?.();
  }

  return (
    <article
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={cn(
        'relative space-y-3 rounded-sm border border-border bg-background px-4 py-4 transition-opacity',
        isBusy && 'opacity-70',
        shippingStatus === 'running' && 'shipping-active',
        draggable && 'cursor-grab'
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-muted-foreground">#{issue.number}</p>
        <div className="flex items-center gap-1">
          {showOverflowMenu ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  disabled={isMenuDisabled}
                  aria-label={`Issue #${issue.number} actions`}
                >
                  <EllipsisVertical className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {hasResetMenu ? (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>Reset</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      {resetTargets.map((targetStage) => (
                        <DropdownMenuItem
                          key={targetStage}
                          onSelect={() => {
                            onResetSelect(targetStage);
                          }}
                        >
                          {getResetTargetLabel(targetStage)}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                ) : null}
                {hasPriorityMenu ? (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>Priority</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      {(['high', 'normal', 'low'] as const).map((level) => {
                        const tier = level === 'high' ? 0 : level === 'low' ? 2 : 1;
                        const isActive = tier === priorityTier;

                        return (
                          <DropdownMenuItem
                            key={level}
                            disabled={isSettingPriority}
                            onSelect={() => {
                              if (isActive) {
                                return;
                              }

                              onSetPriority(level);
                            }}
                          >
                            {level.charAt(0).toUpperCase() + level.slice(1)}
                            {isActive ? (
                              <Check className="ml-auto size-4" aria-hidden="true" />
                            ) : null}
                          </DropdownMenuItem>
                        );
                      })}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                ) : null}
                {hasFlatActions && (hasResetMenu || hasPriorityMenu) ? (
                  <DropdownMenuSeparator />
                ) : null}
                {canCloseNotPlanned ? (
                  <DropdownMenuItem
                    onSelect={() => {
                      onCloseNotPlanned();
                    }}
                    className="text-destructive focus:text-destructive"
                  >
                    Close as not planned
                  </DropdownMenuItem>
                ) : null}
                {canUnlock ? (
                  <DropdownMenuItem onSelect={handleUnlockSelect}>Unlock</DropdownMenuItem>
                ) : null}
                {canUnblock ? (
                  <DropdownMenuItem
                    onSelect={() => {
                      onUnblock();
                    }}
                  >
                    Unblock
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          {showStopShipButton ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-destructive"
              aria-label={`Stop shipping #${issue.number}`}
              onClick={onStopShip}
            >
              <Square className="size-3.5 fill-current" />
            </Button>
          ) : null}
        </div>
      </div>
      <h4 className="text-sm font-semibold leading-snug text-foreground">{issue.title}</h4>
      {priorityTier !== 1 || isBlocked || isLocked ? (
        <div className="flex flex-wrap gap-2">
          {priorityTier === 0 ? (
            <Badge variant="outline" className="border-orange-500 text-orange-600">
              High
            </Badge>
          ) : null}
          {priorityTier === 2 ? (
            <Badge variant="outline" className="text-muted-foreground">
              Low
            </Badge>
          ) : null}
          {isBlocked ? <Badge variant="outline">Blocked</Badge> : null}
          {isLocked ? <Badge variant="outline">Locked</Badge> : null}
        </div>
      ) : null}
      {onGroom ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            onGroom(issue.number);
          }}
          disabled={isGroomDisabled}
        >
          Groom
        </Button>
      ) : null}
      {onShip ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            onShip(issue.number);
          }}
          disabled={isShipDisabled}
        >
          Ship
        </Button>
      ) : null}
      {busyLabel ? (
        <div className="absolute inset-0 flex items-center justify-center rounded-sm bg-background/80">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            {busyLabel}
          </div>
        </div>
      ) : null}
    </article>
  );
}

export default function App(): JSX.Element {
  const [repos, setRepos] = useState<string[]>([]);
  const [activeRepo, setActiveRepo] = useState('');
  const [autoMergeRepos, setAutoMergeRepos] = useState<Set<string>>(new Set());
  const [prerequisites, setPrerequisites] = useState<Prerequisites | null>(null);
  const [issues, setIssues] = useState<ListIssueItem[]>([]);
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
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [isNewIssueOpen, setIsNewIssueOpen] = useState(false);
  const [isAdoptOpen, setIsAdoptOpen] = useState(false);
  const [repoInitialized, setRepoInitialized] = useState<boolean | null>(null);
  const [backgroundCommands, setBackgroundCommands] = useState<BackgroundCommandState[]>([]);
  const [toasts, setToasts] = useState<BackgroundToastItem[]>([]);
  const [autoShipRepos, setAutoShipRepos] = useState<Set<string>>(new Set());
  const [isSavingAutoMerge, setIsSavingAutoMerge] = useState(false);
  const [logViewer, setLogViewer] = useState<BackgroundLogViewerState>({
    open: false,
    sessionId: null,
    title: '',
    content: '',
  });
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [pendingCloseSessionId, setPendingCloseSessionId] = useState<string | null>(null);
  const [actionQueueOpen, setActionQueueOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [dragSource, setDragSource] = useState<{
    issue: ListIssueItem;
    columnIndex: number;
  } | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<number | null>(null);
  const requestVersionRef = useRef(0);
  const initVersionRef = useRef(0);
  const contentPaneRef = useRef<HTMLDivElement | null>(null);
  const toggleButtonRef = useRef<HTMLButtonElement | null>(null);
  const drawerPanelRef = useRef<HTMLDivElement | null>(null);
  const backgroundCommandsRef = useRef<BackgroundCommandState[]>([]);
  const autoShipFailuresRef = useRef<Map<string, number>>(new Map());
  const autoShipSkippedRef = useRef<Map<string, Set<number>>>(new Map());
  const autoUnblockQueueRef = useRef<Map<string, number[]>>(new Map());
  const autoUnblockIssuesRef = useRef<Map<string, Set<number>>>(new Map());
  const autoMergeSaveInFlightRef = useRef(false);
  const sessionsRef = useRef<TerminalSession[]>([]);
  const activeSessionIdRef = useRef<string | null>(null);
  const lastOutputAtBySessionRef = useRef<Map<string, number>>(new Map());

  const prerequisiteMessage = getPrerequisiteMessage(prerequisites);
  const canFetch = prerequisites !== null && prerequisiteMessage === null;
  const hasActiveRepo = activeRepo.length > 0 && isValidRepo(activeRepo);
  const hasSession = sessions.length > 0;
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
  const pendingCloseSession =
    pendingCloseSessionId === null
      ? null
      : (sessions.find((session) => session.id === pendingCloseSessionId) ?? null);
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
  const shippingCommands = new Map<number, ActiveShippingCommand>();
  const activeCommandRepos = new Set<string>();

  for (const command of backgroundCommands) {
    if ((command.status === 'queued' || command.status === 'running') && !command.cancelled) {
      activeCommandRepos.add(command.repo);
    }

    if (isActiveShippingCommand(command, activeRepo)) {
      shippingCommands.set(command.issueNumber, command);
    }
  }

  const commitBackgroundCommands = useEffectEvent(
    (updater: SetStateAction<BackgroundCommandState[]>) => {
      setBackgroundCommands((currentCommands) => {
        const nextCommands = typeof updater === 'function' ? updater(currentCommands) : updater;
        backgroundCommandsRef.current = nextCommands;
        return nextCommands;
      });
    }
  );

  function clearIssueState(): void {
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
    setRepoInitialized(null);
    initVersionRef.current = 0;
  }

  function clearAutoShipStateForRepo(repo: string): void {
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
  }

  function enableAutoShipForRepo(repo: string): void {
    setAutoShipRepos((currentRepos) => {
      if (currentRepos.has(repo)) {
        return currentRepos;
      }

      return new Set(currentRepos).add(repo);
    });
    autoShipFailuresRef.current.set(repo, 0);
    autoShipSkippedRef.current.set(repo, new Set());
  }

  async function handleToggleAutoMerge(repo: string): Promise<void> {
    if (autoMergeSaveInFlightRef.current) {
      return;
    }

    autoMergeSaveInFlightRef.current = true;
    setIsSavingAutoMerge(true);

    const nextAutoMergeRepos = new Set(autoMergeRepos);
    if (nextAutoMergeRepos.has(repo)) {
      nextAutoMergeRepos.delete(repo);
    } else {
      nextAutoMergeRepos.add(repo);
    }

    try {
      await persistConfig({ repos, activeRepo, autoMergeRepos: [...nextAutoMergeRepos] });
      setAutoMergeRepos(nextAutoMergeRepos);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFetchError(`Failed to save auto-merge preference: ${message}`);
    } finally {
      autoMergeSaveInFlightRef.current = false;
      setIsSavingAutoMerge(false);
    }
  }

  const loadIssues = useEffectEvent(async (repo: string) => {
    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    setIsLoading(true);
    setFetchError(null);

    try {
      const result = await window.shipperAPI.listIssues(repo);
      if (requestVersion !== requestVersionRef.current) {
        return null;
      }

      if (!result.ok) {
        setFetchError(result.error);
        return result;
      }

      setIssues(result.issues);
      setLastUpdated(new Date());
      return result;
    } catch (error) {
      if (requestVersion !== requestVersionRef.current) {
        return null;
      }

      const message = error instanceof Error ? error.message : String(error);
      setFetchError(message);
      return null;
    } finally {
      if (requestVersion === requestVersionRef.current) {
        setIsLoading(false);
      }
    }
  });

  const checkInitState = useEffectEvent(async (repo: string) => {
    const version = initVersionRef.current + 1;
    initVersionRef.current = version;

    try {
      const result = await window.shipperAPI.checkInit(repo);
      if (version !== initVersionRef.current) return;

      if (result.error) {
        // Operational failure (e.g. gh CLI error) — keep null to avoid
        // incorrectly showing the init CTA for an initialized repo.
        return;
      }
      setRepoInitialized(result.initialized);
    } catch {
      if (version !== initVersionRef.current) return;
      // IPC failure — keep null (unknown)
    }
  });

  const persistConfig = useEffectEvent(async (config: AppConfig) => {
    await window.shipperAPI.setConfig(config);
  });

  const refreshIssuesForActiveRepo = useEffectEvent(async (repo: string) => {
    if (repo !== activeRepo) {
      return;
    }

    await loadIssues(repo);
  });

  const dismissToast = useEffectEvent((toastId: string) => {
    setToasts((currentToasts) => currentToasts.filter((toast) => toast.id !== toastId));
  });

  const refreshRepoAfterBackground = useEffectEvent(
    async (repo: string, command: BackgroundCommandKind, status: BackgroundCommandStatus) => {
      if (repo !== activeRepo) {
        return null;
      }

      if (command === 'new' && status === 'complete') {
        return loadIssues(repo);
      }

      if (command === 'init' && status === 'complete') {
        void checkInitState(repo);
        return loadIssues(repo);
      }

      if (command === 'unblock' && (status === 'complete' || status === 'failed')) {
        return loadIssues(repo);
      }

      if (command === 'ship' && (status === 'complete' || status === 'failed')) {
        return loadIssues(repo);
      }

      return null;
    }
  );

  const handleRetryBackgroundCommand = useEffectEvent(async (payload: BackgroundRetryPayload) => {
    switch (payload.command) {
      case 'new':
        await window.shipperAPI.spawnBackgroundNew(payload.request, payload.repo);
        return;
      case 'ship':
        await window.shipperAPI.spawnBackgroundShip(
          payload.issueNumber,
          payload.repo,
          payload.merge
        );
        return;
      case 'init':
        await window.shipperAPI.spawnBackgroundInit(payload.repo);
        return;
      case 'unblock':
        trackUnblockIssue(payload.issueNumber);
        try {
          await window.shipperAPI.spawnBackgroundUnblock(payload.issueNumber, payload.repo);
        } catch (error) {
          clearUnblockIssue(payload.issueNumber);
          throw error;
        }
        return;
    }
  });

  const pushToast = useEffectEvent((toast: BackgroundToastItem) => {
    setToasts((currentToasts) => {
      const nextToasts = currentToasts.filter((item) => item.id !== toast.id);
      return [...nextToasts, toast];
    });
  });

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
        clearUnblockIssue(issueNumber);
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
          const issueResult = refreshedIssues ?? (await window.shipperAPI.listIssues(event.repo));
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
            await window.shipperAPI.spawnBackgroundShip(
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
            await window.shipperAPI.spawnBackgroundUnblock(
              nextQueuedIssue.issue.number,
              event.repo
            );
          } catch {
            clearUnblockIssue(nextQueuedIssue.issue.number);
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
        const issueResult = await window.shipperAPI.listIssues(event.repo);
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
            await window.shipperAPI.spawnBackgroundUnblock(firstBlocked.number, event.repo);
          } catch {
            clearUnblockIssue(firstBlocked.number);
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
        await window.shipperAPI.spawnBackgroundShip(
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
      const issueResult = await window.shipperAPI.listIssues(event.repo);
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
        await window.shipperAPI.spawnBackgroundShip(
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
        await window.shipperAPI.spawnBackgroundUnblock(nextQueuedIssue.issue.number, event.repo);
      } catch {
        clearUnblockIssue(nextQueuedIssue.issue.number);
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
      autoUnblockQueueRef.current.delete(event.repo);
    }
  });

  useEffect(() => {
    let cancelled = false;

    async function initialize(): Promise<void> {
      try {
        const [prerequisiteResult, config] = await Promise.all([
          window.shipperAPI.checkPrerequisites(),
          window.shipperAPI.getConfig(),
        ]);

        if (cancelled) {
          return;
        }

        setPrerequisites(prerequisiteResult);
        setRepos(config.repos);
        setActiveRepo(config.activeRepo);
        setAutoMergeRepos(new Set(config.autoMergeRepos));

        if (
          prerequisiteResult.ghInstalled.ok &&
          prerequisiteResult.ghAuth.ok &&
          config.activeRepo.length > 0
        ) {
          void checkInitState(config.activeRepo);
          await loadIssues(config.activeRepo);
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : String(error);
          setFetchError(`Failed to initialize desktop app: ${message}`);
        }
      }
    }

    void initialize();

    return () => {
      cancelled = true;
      requestVersionRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!canFetch || !hasActiveRepo) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void loadIssues(activeRepo);
    }, 60_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [activeRepo, canFetch, hasActiveRepo]);

  useEffect(() => {
    if (!canFetch || !hasActiveRepo) {
      return;
    }
    if (!hasRunningShipCommand) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void loadIssues(activeRepo);
    }, 10_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [activeRepo, canFetch, hasActiveRepo, hasRunningShipCommand]);

  useEffect(() => {
    const drawerPanel = drawerPanelRef.current;
    if (!drawerPanel) {
      return;
    }

    if (drawerOpen) {
      drawerPanel.removeAttribute('inert');
      return;
    }

    drawerPanel.setAttribute('inert', '');
  }, [drawerOpen]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    const unsubscribe = window.shipperAPI.onBackgroundStatus((event) => {
      void handleBackgroundStatus(event as BackgroundStatusPayload);
    });

    return unsubscribe;
  }, [handleBackgroundStatus]);

  useEffect(() => {
    const unsubscribe = window.shipperAPI.onBackgroundOutput((event) => {
      const payload = event as BackgroundOutputPayload;

      commitBackgroundCommands((currentCommands) =>
        currentCommands.map((command) => {
          if (command.id !== payload.sessionId) {
            return command;
          }

          const output = `${command.output}${payload.data}`;
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
        if (!currentViewer.open || currentViewer.sessionId !== payload.sessionId) {
          return currentViewer;
        }

        const activeCommand = backgroundCommandsRef.current.find(
          (command) => command.id === payload.sessionId
        );
        if (activeCommand?.command === 'new') {
          return currentViewer;
        }

        return {
          ...currentViewer,
          content: `${currentViewer.content}${payload.data}`,
        };
      });
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    if (pendingCloseSessionId !== null && pendingCloseSession === null) {
      setPendingCloseSessionId(null);
    }
  }, [pendingCloseSession, pendingCloseSessionId]);

  async function handleRefresh(): Promise<void> {
    if (!canFetch || !hasActiveRepo || isLoading) {
      return;
    }

    await loadIssues(activeRepo);
  }

  function handleOpenNewIssue(): void {
    setIsNewIssueOpen(true);
  }

  function handleOpenAdopt(): void {
    setIsAdoptOpen(true);
  }

  async function handleAddRepo(repo: string): Promise<void> {
    const nextRepo = repo.trim();
    if (
      !isValidRepo(nextRepo) ||
      repos.some((currentRepo) => toRepoKey(currentRepo) === toRepoKey(nextRepo))
    ) {
      return;
    }

    const nextRepos = [...repos, nextRepo];

    try {
      await persistConfig({
        repos: nextRepos,
        activeRepo: nextRepo,
        autoMergeRepos: [...autoMergeRepos],
      });
      setRepos(nextRepos);
      setActiveRepo(nextRepo);
      clearIssueState();

      if (canFetch) {
        void checkInitState(nextRepo);
        await loadIssues(nextRepo);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFetchError(`Failed to save repositories: ${message}`);
    }
  }

  async function handleSwitchRepo(repo: string): Promise<void> {
    if (repo === activeRepo) {
      return;
    }

    try {
      await persistConfig({ repos, activeRepo: repo, autoMergeRepos: [...autoMergeRepos] });
      setActiveRepo(repo);
      clearIssueState();

      if (canFetch) {
        void checkInitState(repo);
        await loadIssues(repo);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFetchError(`Failed to save repositories: ${message}`);
    }
  }

  async function handleReorderRepos(nextRepos: string[]): Promise<void> {
    if (
      repos.length < 2 ||
      nextRepos.length !== repos.length ||
      nextRepos.every((repo, index) => repo === repos[index])
    ) {
      return;
    }

    const currentRepoKeys = new Set(repos.map((repo) => toRepoKey(repo)));
    const nextRepoKeys = new Set(nextRepos.map((repo) => toRepoKey(repo)));
    if (
      currentRepoKeys.size !== repos.length ||
      nextRepoKeys.size !== nextRepos.length ||
      currentRepoKeys.size !== nextRepoKeys.size
    ) {
      return;
    }

    for (const repoKey of currentRepoKeys) {
      if (!nextRepoKeys.has(repoKey)) {
        return;
      }
    }

    if (activeRepo && !nextRepos.some((repo) => toRepoKey(repo) === toRepoKey(activeRepo))) {
      return;
    }

    try {
      await persistConfig({ repos: nextRepos, activeRepo, autoMergeRepos: [...autoMergeRepos] });
      setRepos(nextRepos);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFetchError(`Failed to save repositories: ${message}`);
    }
  }

  useEffect(() => {
    const unsubscribe = window.shipperAPI.onPtyOutput((event) => {
      const outputAt = Date.now();
      lastOutputAtBySessionRef.current.set(event.sessionId, outputAt);

      const session = sessionsRef.current.find(
        (currentSession) =>
          currentSession.id === event.sessionId && currentSession.status !== 'exited'
      );
      if (!session || session.status !== 'waiting') {
        return;
      }

      setSessions((currentSessions) => {
        const sessionIndex = currentSessions.findIndex(
          (currentSession) =>
            currentSession.id === event.sessionId && currentSession.status === 'waiting'
        );
        if (sessionIndex < 0) {
          return currentSessions;
        }

        const currentSession = currentSessions[sessionIndex];
        if (!currentSession) {
          return currentSessions;
        }

        const nextSessions = [...currentSessions];
        nextSessions[sessionIndex] = { ...currentSession, status: 'running' };
        return nextSessions;
      });
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = window.shipperAPI.onPtyExit((event) => {
      setSessions((currentSessions) => {
        const sessionIndex = currentSessions.findIndex(
          (session) => session.id === event.sessionId && session.status !== 'exited'
        );
        if (sessionIndex < 0) {
          return currentSessions;
        }

        const session = currentSessions[sessionIndex];
        if (!session) {
          return currentSessions;
        }

        const nextSessions = [...currentSessions];
        nextSessions[sessionIndex] = { ...session, status: 'exited' };
        return nextSessions;
      });
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!logViewer.open || logViewer.sessionId === null || viewedBackgroundCommandType === null) {
      return;
    }

    let cancelled = false;
    const sessionId = logViewer.sessionId;

    const loadOutput = async (): Promise<void> => {
      try {
        const output = await window.shipperAPI.getBackgroundOutput(sessionId);
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
          const message = error instanceof Error ? error.message : String(error);
          setFetchError(`Failed to load background logs: ${message}`);
        }
      }
    };

    void loadOutput();

    if (viewedBackgroundCommandType !== 'new' || viewedBackgroundCommandStatus !== 'running') {
      return () => {
        cancelled = true;
      };
    }

    const intervalId = window.setInterval(() => {
      void loadOutput();
    }, 1_000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [
    logViewer.open,
    logViewer.sessionId,
    viewedBackgroundCommandStatus,
    viewedBackgroundCommandType,
  ]);

  useEffect(() => {
    if (sessions.length === 0) {
      return;
    }

    const intervalId = window.setInterval(() => {
      const now = Date.now();

      setSessions((currentSessions) => {
        let nextSessions: TerminalSession[] | null = null;

        for (const [index, session] of currentSessions.entries()) {
          const lastOutputAt = lastOutputAtBySessionRef.current.get(session.id);
          if (
            session.status !== 'running' ||
            lastOutputAt === undefined ||
            now - lastOutputAt <= 5_000
          ) {
            continue;
          }

          if (nextSessions === null) {
            nextSessions = [...currentSessions];
          }

          nextSessions[index] = { ...session, status: 'waiting' };
        }

        return nextSessions ?? currentSessions;
      });
    }, 1_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [sessions.length]);

  function openRunningSession(
    sessionId: string,
    label: string,
    metadata?: { repo: string; issueNumber: number }
  ): void {
    const session: TerminalSession = {
      id: sessionId,
      label,
      status: 'running',
      ...metadata,
    };

    lastOutputAtBySessionRef.current.set(session.id, Date.now());
    setSessions((currentSessions) => [...currentSessions, session]);
    setActiveSessionId(session.id);
    setDrawerOpen(true);
  }

  async function handleShipperNew(request: string, repo = activeRepo): Promise<void> {
    try {
      await window.shipperAPI.spawnBackgroundNew(request, repo);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFetchError(`Failed to launch shipper new: ${message}`);
    }
  }

  function focusExistingGroomSession(issueNumber: number): boolean {
    const existing = findActiveIssueSession(sessionsRef.current, activeRepo, issueNumber);
    if (existing) {
      setActiveSessionId(existing.id);
      setDrawerOpen(true);
      return true;
    }
    return false;
  }

  async function handleShipperGroom(issueNumber: number): Promise<void> {
    if (focusExistingGroomSession(issueNumber)) return;

    try {
      const result = await window.shipperAPI.spawnShipperGroom(issueNumber, activeRepo, 120, 30);
      openRunningSession(result.sessionId, `groom — #${issueNumber}`, {
        repo: activeRepo,
        issueNumber,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFetchError(`Failed to launch shipper groom: ${message}`);
    }
  }

  async function handleShipperShip(issueNumber: number, repo = activeRepo): Promise<void> {
    try {
      await window.shipperAPI.spawnBackgroundShip(issueNumber, repo, autoMergeRepos.has(repo));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFetchError(`Failed to launch shipper ship: ${message}`);
    }
  }

  async function handleShipperInit(repo = activeRepo): Promise<void> {
    try {
      await window.shipperAPI.spawnBackgroundInit(repo);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFetchError(`Failed to launch shipper init: ${message}`);
    }
  }

  function trackResetIssue(issueNumber: number): void {
    setResettingIssues((current) => new Set(current).add(issueNumber));
  }

  function clearResetIssue(issueNumber: number): void {
    setResettingIssues((current) => {
      const next = new Set(current);
      next.delete(issueNumber);
      return next;
    });
  }

  function trackUnlockIssue(issueNumber: number): void {
    setUnlockingIssues((current) => new Set(current).add(issueNumber));
  }

  function clearUnlockIssue(issueNumber: number): void {
    setUnlockingIssues((current) => {
      const next = new Set(current);
      next.delete(issueNumber);
      return next;
    });
  }

  function trackUnblockIssue(issueNumber: number): void {
    setUnblockingIssues((current) => new Set(current).add(issueNumber));
  }

  function clearUnblockIssue(issueNumber: number): void {
    setUnblockingIssues((current) => {
      const next = new Set(current);
      next.delete(issueNumber);
      return next;
    });
  }

  function trackSettingPriorityIssue(issueNumber: number): void {
    setSettingPriorityIssues((current) => new Set(current).add(issueNumber));
  }

  function clearSettingPriorityIssue(issueNumber: number): void {
    setSettingPriorityIssues((current) => {
      const next = new Set(current);
      next.delete(issueNumber);
      return next;
    });
  }

  function isAutoUnblockIssue(repo: string, issueNumber: number): boolean {
    return autoUnblockIssuesRef.current.get(repo)?.has(issueNumber) ?? false;
  }

  function trackAutoUnblockIssue(repo: string, issueNumber: number): void {
    const currentIssues = autoUnblockIssuesRef.current.get(repo) ?? new Set<number>();
    currentIssues.add(issueNumber);
    autoUnblockIssuesRef.current.set(repo, currentIssues);
    trackUnblockIssue(issueNumber);
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

  function handleResetSuccess(issueNumber: number): void {
    clearResetIssue(issueNumber);
    if (activeRepo) {
      void loadIssues(activeRepo);
    }
  }

  function handleCloseNotPlannedSuccess(issueNumber: number): void {
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
  }

  function handleCloseNotPlannedError(issueNumber: number, error: string): void {
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
  }

  async function handleUnlockExecute(issue: ListIssueItem, repo = activeRepo): Promise<void> {
    if (!repo) {
      return;
    }

    trackUnlockIssue(issue.number);

    try {
      const result = await window.shipperAPI.unlockIssue(repo, issue.number);
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
      const message = error instanceof Error ? error.message : String(error);
      pushToast({
        id: `unlock-issue-error-${issue.number}`,
        sessionId: '',
        variant: 'error',
        title: 'Failed to unlock issue',
        description: message,
      });
    } finally {
      setUnlockConfirmIssue(null);
      clearUnlockIssue(issue.number);
    }
  }

  async function handleSetPriority(
    issue: ListIssueItem,
    level: 'high' | 'normal' | 'low'
  ): Promise<void> {
    if (!activeRepo || settingPriorityIssues.has(issue.number)) {
      return;
    }

    const repo = activeRepo;
    trackSettingPriorityIssue(issue.number);

    try {
      const result = await window.shipperAPI.setPriority(repo, issue.number, level);
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
      const message = error instanceof Error ? error.message : String(error);
      pushToast({
        id: `set-priority-error-${issue.number}`,
        sessionId: '',
        variant: 'error',
        title: 'Failed to set priority',
        description: message,
      });
    } finally {
      clearSettingPriorityIssue(issue.number);
    }
  }

  async function handleUnlockClick(issue: ListIssueItem): Promise<void> {
    if (!activeRepo) {
      return;
    }

    const repo = activeRepo;
    let clearPendingState = true;
    trackUnlockIssue(issue.number);

    try {
      const result = await window.shipperAPI.checkLockStale(repo, issue.number);
      if (result.stale) {
        clearPendingState = false;
        await handleUnlockExecute(issue, repo);
        return;
      }

      setUnlockConfirmIssue(issue);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushToast({
        id: `unlock-issue-check-error-${issue.number}`,
        sessionId: '',
        variant: 'error',
        title: 'Failed to check issue lock',
        description: message,
      });
    } finally {
      if (clearPendingState) {
        clearUnlockIssue(issue.number);
      }
    }
  }

  async function handleUnlockDialogConfirm(): Promise<void> {
    if (unlockConfirmIssue === null) {
      return;
    }

    await handleUnlockExecute(unlockConfirmIssue);
  }

  async function handleUnblockClick(issue: ListIssueItem): Promise<void> {
    if (!activeRepo) {
      return;
    }

    trackUnblockIssue(issue.number);

    try {
      await window.shipperAPI.spawnBackgroundUnblock(issue.number, activeRepo);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushToast({
        id: `unblock-spawn-error-${issue.number}`,
        sessionId: '',
        variant: 'error',
        title: 'Failed to start unblock',
        description: message,
      });
      clearUnblockIssue(issue.number);
    }
  }

  function handleToggleDrawer(): void {
    setDrawerOpen((current) => !current);
  }

  function handleToggleActionQueue(): void {
    setActionQueueOpen((current) => !current);
  }

  function handleDismissBackground(sessionId: string): void {
    commitBackgroundCommands((currentCommands) =>
      currentCommands.filter((command) => command.id !== sessionId)
    );
  }

  async function handleCancelBackground(sessionId: string): Promise<void> {
    try {
      await window.shipperAPI.killBackground(sessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFetchError(`Failed to cancel background command: ${message}`);
    }
  }

  async function handleShowBackgroundLogs(sessionId: string): Promise<void> {
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
      const output = await window.shipperAPI.getBackgroundOutput(sessionId);
      setLogViewer((currentViewer) =>
        currentViewer.sessionId === sessionId
          ? { ...currentViewer, content: output }
          : currentViewer
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFetchError(`Failed to open background logs: ${message}`);
    }
  }

  async function handleRetryToast(toastId: string): Promise<void> {
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
      const message = error instanceof Error ? error.message : String(error);
      setFetchError(`Failed to retry background command: ${message}`);
      throw error;
    }
  }

  function focusVisibleShell(preferToggle: boolean): void {
    window.requestAnimationFrame(() => {
      if (preferToggle && toggleButtonRef.current) {
        toggleButtonRef.current.focus();
        return;
      }

      contentPaneRef.current?.focus();
    });
  }

  function removeSession(sessionId: string): void {
    const currentSessions = sessionsRef.current;
    if (!currentSessions.some((session) => session.id === sessionId)) {
      return;
    }

    const remainingSessions = currentSessions.filter((session) => session.id !== sessionId);
    const nextActiveSessionId = getNextActiveSessionId(
      currentSessions,
      activeSessionIdRef.current,
      sessionId
    );

    sessionsRef.current = remainingSessions;
    activeSessionIdRef.current = nextActiveSessionId;
    lastOutputAtBySessionRef.current.delete(sessionId);
    setSessions(remainingSessions);
    setActiveSessionId(nextActiveSessionId);
    setPendingCloseSessionId((current) => (current === sessionId ? null : current));

    if (remainingSessions.length === 0) {
      setDrawerOpen(false);
      focusVisibleShell(false);
    }
  }

  function handleSelectSession(sessionId: string): void {
    setActiveSessionId(sessionId);
  }

  function handleCloseSession(sessionId: string): void {
    const session = sessionsRef.current.find((currentSession) => currentSession.id === sessionId);
    if (!session) {
      return;
    }

    if (session.status === 'exited') {
      removeSession(sessionId);
      return;
    }

    setPendingCloseSessionId(sessionId);
  }

  function handleSessionInput(sessionId: string): void {
    lastOutputAtBySessionRef.current.set(sessionId, Date.now());

    const session = sessionsRef.current.find(
      (currentSession) => currentSession.id === sessionId && currentSession.status !== 'exited'
    );
    if (!session || session.status !== 'waiting') {
      return;
    }

    setSessions((currentSessions) => {
      const sessionIndex = currentSessions.findIndex(
        (currentSession) => currentSession.id === sessionId && currentSession.status === 'waiting'
      );
      if (sessionIndex < 0) {
        return currentSessions;
      }

      const currentSession = currentSessions[sessionIndex];
      if (!currentSession) {
        return currentSessions;
      }

      const nextSessions = [...currentSessions];
      nextSessions[sessionIndex] = { ...currentSession, status: 'running' };
      return nextSessions;
    });
  }

  async function handleConfirmCloseSession(): Promise<void> {
    const session = pendingCloseSessionId
      ? (sessionsRef.current.find(
          (currentSession) => currentSession.id === pendingCloseSessionId
        ) ?? null)
      : null;
    if (!session) {
      setPendingCloseSessionId(null);
      return;
    }

    if (session.status === 'exited') {
      setPendingCloseSessionId(null);
      removeSession(session.id);
      return;
    }

    try {
      await window.shipperAPI.ptyKill(session.id);
      setPendingCloseSessionId(null);
      removeSession(session.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFetchError(`Failed to close terminal session: ${message}`);
    }
  }

  async function handleCloseRepo(repo: string): Promise<void> {
    const index = repos.findIndex((currentRepo) => currentRepo === repo);
    if (index < 0) {
      return;
    }

    const nextRepos = repos.filter((currentRepo) => currentRepo !== repo);
    const nextActiveRepo =
      repo === activeRepo ? (nextRepos[index] ?? nextRepos.at(-1) ?? '') : activeRepo;
    const nextAutoMergeRepos = [...autoMergeRepos].filter((currentRepo) => currentRepo !== repo);

    try {
      await persistConfig({
        repos: nextRepos,
        activeRepo: nextActiveRepo,
        autoMergeRepos: nextAutoMergeRepos,
      });
      setRepos(nextRepos);
      setActiveRepo(nextActiveRepo);
      setAutoMergeRepos(new Set(nextAutoMergeRepos));
      clearAutoShipStateForRepo(repo);

      if (repo === activeRepo) {
        clearIssueState();

        if (canFetch && nextActiveRepo) {
          void checkInitState(nextActiveRepo);
          await loadIssues(nextActiveRepo);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFetchError(`Failed to save repositories: ${message}`);
    }
  }

  return (
    <div className="flex h-screen flex-col bg-transparent">
      <BackgroundToastRegion toasts={toasts} onDismiss={dismissToast} onRetry={handleRetryToast} />
      <BackgroundLogViewer
        open={logViewer.open}
        title={logViewer.title}
        content={logViewer.content}
        onOpenChange={(open) => {
          setLogViewer((currentViewer) => ({
            ...currentViewer,
            open,
            content: open ? currentViewer.content : '',
            sessionId: open ? currentViewer.sessionId : null,
          }));
        }}
      />
      <RepoPickerDialog
        open={isPickerOpen}
        onOpenChange={setIsPickerOpen}
        repos={repos}
        onSelectRepo={handleAddRepo}
      />
      <NewIssueDialog
        open={isNewIssueOpen}
        onOpenChange={setIsNewIssueOpen}
        repos={repos}
        activeRepo={activeRepo}
        onSubmit={(request, repo) => {
          void handleShipperNew(request, repo);
        }}
      />
      <AdoptDialog
        open={isAdoptOpen}
        onOpenChange={setIsAdoptOpen}
        repo={activeRepo}
        onAdopted={() => {
          void loadIssues(activeRepo);
        }}
      />
      <ResetConfirmDialog
        open={resetSelection !== null}
        onOpenChange={(open) => {
          if (!open) {
            setResetSelection(null);
          }
        }}
        repo={activeRepo}
        issueNumber={resetSelection?.issue.number ?? null}
        targetStage={resetSelection?.targetStage ?? null}
        onResetStart={trackResetIssue}
        onResetSuccess={handleResetSuccess}
        onResetFailure={clearResetIssue}
      />
      <CloseNotPlannedDialog
        open={closeNotPlannedIssue !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCloseNotPlannedIssue(null);
          }
        }}
        repo={activeRepo}
        issue={closeNotPlannedIssue}
        onSuccess={handleCloseNotPlannedSuccess}
        onError={handleCloseNotPlannedError}
      />
      <UnlockConfirmDialog
        open={unlockConfirmIssue !== null}
        onOpenChange={(open) => {
          if (!open) {
            setUnlockConfirmIssue(null);
          }
        }}
        issue={unlockConfirmIssue}
        onConfirm={handleUnlockDialogConfirm}
      />
      <Dialog
        open={pendingCloseSession !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingCloseSessionId(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pendingCloseSession?.status === 'exited'
                ? 'Close terminal tab?'
                : 'Close live terminal session?'}
            </DialogTitle>
            <DialogDescription>
              {pendingCloseSession
                ? pendingCloseSession.status === 'exited'
                  ? `"${pendingCloseSession.label}" has already exited. Closing will remove its tab.`
                  : `Closing "${pendingCloseSession.label}" will kill the live process and remove its tab.`
                : 'Closing this session will remove its tab.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setPendingCloseSessionId(null);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant={pendingCloseSession?.status === 'exited' ? 'default' : 'destructive'}
              onClick={() => {
                void handleConfirmCloseSession();
              }}
            >
              {pendingCloseSession?.status === 'exited' ? 'Close tab' : 'Kill session'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="flex min-h-0 flex-1">
        <ActionQueueDrawer
          open={actionQueueOpen}
          onToggle={handleToggleActionQueue}
          commands={backgroundCommands.map((command) => {
            const issue =
              command.command === 'ship' &&
              command.repo === activeRepo &&
              command.issueNumber !== undefined
                ? issues.find((candidate) => candidate.number === command.issueNumber)
                : undefined;

            return {
              id: command.id,
              command: command.command,
              status: command.status,
              title: command.title,
              repo: command.repo,
              detail: command.detail,
              canCancel: command.status === 'queued' || command.status === 'running',
              canShowLogs:
                command.command === 'new'
                  ? Boolean(command.logFile)
                  : command.output.length > 0 || command.status !== 'queued',
              cancelled: command.cancelled,
              workflowStage: issue ? getWorkflowStageDisplayName(issue.labels) : undefined,
            };
          })}
          onCancel={(sessionId) => {
            void handleCancelBackground(sessionId);
          }}
          onShowLogs={(sessionId) => {
            void handleShowBackgroundLogs(sessionId);
          }}
          onDismiss={handleDismissBackground}
        />
        <div ref={contentPaneRef} tabIndex={-1} className="min-w-0 flex-1 overflow-y-auto">
          <header
            className={cn(
              'sticky top-0 z-10 bg-background nautical-wave-border',
              repos.length === 0 && 'border-b border-border'
            )}
          >
            <div className="mx-auto flex max-w-7xl flex-col gap-4 px-6 py-5">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">
                  Shipper Desktop
                </p>
                <h1 className="text-2xl font-semibold tracking-tight">Pipeline</h1>
              </div>
            </div>
            {repos.length > 0 ? (
              <RepoTabBar
                repos={repos}
                activeRepo={activeRepo}
                activeCommandRepos={activeCommandRepos}
                onSelectRepo={(repo) => {
                  void handleSwitchRepo(repo);
                }}
                onCloseRepo={(repo) => {
                  void handleCloseRepo(repo);
                }}
                onAddRepo={() => {
                  setIsPickerOpen(true);
                }}
                onReorderRepos={(nextRepos) => {
                  void handleReorderRepos(nextRepos);
                }}
              />
            ) : null}
          </header>

          <main className="mx-auto flex max-w-7xl flex-col gap-4 px-6 py-6">
            {prerequisiteMessage ? (
              <Alert variant="destructive">
                <AlertTitle>GitHub CLI required</AlertTitle>
                <AlertDescription>{prerequisiteMessage}</AlertDescription>
              </Alert>
            ) : null}

            {fetchError ? (
              <Alert variant="destructive" className="pr-24">
                <AlertTitle>Issue fetch failed</AlertTitle>
                <AlertDescription>{fetchError}</AlertDescription>
                <Button
                  variant="ghost"
                  size="sm"
                  className="absolute top-2 right-2"
                  onClick={() => {
                    setFetchError(null);
                  }}
                >
                  Dismiss
                </Button>
              </Alert>
            ) : null}

            {hasActiveRepo && repoInitialized === true ? (
              <div className="flex items-center justify-end gap-3">
                {lastUpdated ? (
                  <p className="text-sm text-muted-foreground">
                    Last updated {dateFormatter.format(lastUpdated)}
                  </p>
                ) : null}
                <Button variant="outline" onClick={handleOpenNewIssue} disabled={!canFetch}>
                  New Issue
                </Button>
                <Button variant="outline" onClick={handleOpenAdopt} disabled={!canFetch}>
                  Adopt
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    void handleRefresh();
                  }}
                  disabled={!canFetch || isLoading}
                >
                  {isLoading ? 'Refreshing...' : 'Refresh'}
                </Button>
              </div>
            ) : null}

            {repos.length === 0 ? (
              <section className="relative flex min-h-[24rem] flex-col items-center justify-center rounded-sm border border-dashed border-border bg-card px-6 py-10 text-center">
                <svg
                  className="absolute opacity-[0.06] text-foreground"
                  width="140"
                  height="140"
                  viewBox="0 0 100 100"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <circle cx="50" cy="50" r="40" />
                  <circle cx="50" cy="50" r="3" fill="currentColor" />
                  <line x1="50" y1="5" x2="50" y2="95" />
                  <line x1="5" y1="50" x2="95" y2="50" />
                  <polygon points="50,8 46,25 54,25" fill="currentColor" />
                  <polygon points="50,92 46,75 54,75" fill="currentColor" />
                  <polygon points="8,50 25,46 25,54" fill="currentColor" />
                  <polygon points="92,50 75,46 75,54" fill="currentColor" />
                </svg>
                <div className="max-w-md space-y-3">
                  <h2 className="text-xl font-semibold tracking-tight">
                    Add a repository to get started
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    Choose a GitHub repository to load its shipper-labeled issues into the desktop
                    inbox.
                  </p>
                  <Button
                    onClick={() => {
                      setIsPickerOpen(true);
                    }}
                  >
                    Add repository
                  </Button>
                </div>
              </section>
            ) : repoInitialized === null ? (
              <section className="relative flex min-h-[24rem] flex-col items-center justify-center rounded-sm border border-dashed border-border bg-card px-6 py-10 text-center">
                <LoaderCircle className="size-8 animate-spin text-muted-foreground" />
              </section>
            ) : !repoInitialized ? (
              <section className="relative flex min-h-[24rem] flex-col items-center justify-center rounded-sm border border-dashed border-border bg-card px-6 py-10 text-center">
                <div className="max-w-md space-y-3">
                  <h2 className="text-xl font-semibold tracking-tight">
                    Initialize this repository
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    Run shipper init to set up workflow labels and configuration.
                  </p>
                  <Button
                    onClick={() => {
                      void handleShipperInit();
                    }}
                    disabled={!canFetch || !hasActiveRepo}
                  >
                    Initialize
                  </Button>
                </div>
              </section>
            ) : (
              <section className="overflow-hidden rounded-sm border border-border bg-card">
                <div className="border-b border-border px-6 py-4">
                  <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                    <div>
                      <h2 className="text-lg font-semibold">Issues by workflow stage</h2>
                      <p className="text-sm text-muted-foreground">
                        Review the current repository as a pipeline organized by shipper stage.
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      {activeRepo ? (
                        <Badge variant="outline" className="w-fit">
                          {activeRepo}
                        </Badge>
                      ) : null}
                      <Button
                        type="button"
                        aria-pressed={activeRepo ? autoMergeRepos.has(activeRepo) : false}
                        variant={
                          activeRepo && autoMergeRepos.has(activeRepo) ? 'default' : 'outline'
                        }
                        size="sm"
                        onClick={() => {
                          if (!activeRepo) {
                            return;
                          }

                          void handleToggleAutoMerge(activeRepo);
                        }}
                        disabled={!canFetch || !hasActiveRepo || isSavingAutoMerge}
                      >
                        Auto-merge
                      </Button>
                      <Button
                        type="button"
                        aria-pressed={activeRepo ? autoShipRepos.has(activeRepo) : false}
                        variant={
                          activeRepo && autoShipRepos.has(activeRepo) ? 'default' : 'outline'
                        }
                        size="sm"
                        onClick={() => {
                          if (!activeRepo) {
                            return;
                          }

                          if (autoShipRepos.has(activeRepo)) {
                            clearAutoShipStateForRepo(activeRepo);
                            return;
                          }

                          enableAutoShipForRepo(activeRepo);
                        }}
                        disabled={!canFetch || !hasActiveRepo}
                      >
                        Auto-ship
                      </Button>
                    </div>
                  </div>
                </div>

                {!hasActiveRepo ? (
                  <div className="px-6 py-10 text-sm text-muted-foreground">
                    Select a repository tab to begin.
                  </div>
                ) : issues.length === 0 && !isLoading ? (
                  <div className="px-6 py-10 text-sm text-muted-foreground">
                    No shipper-labeled issues found for this repository.
                  </div>
                ) : (
                  <div className="space-y-6 px-6 py-6">
                    {attentionIssues.length > 0 ? (
                      <div className="space-y-3 border-b border-border pb-6">
                        <div>
                          <h3 className="text-sm font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                            Needs attention
                          </h3>
                          <p className="text-sm text-muted-foreground">
                            New issues stay here until they are groomed into the pipeline.
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-3">
                          {attentionIssues.map((issue) => (
                            <div key={issue.number} className="w-[240px] shrink-0">
                              <IssueCard
                                issue={issue}
                                onGroom={(issueNumber) => {
                                  void handleShipperGroom(issueNumber);
                                }}
                                onCloseNotPlanned={() => {
                                  setCloseNotPlannedIssue(issue);
                                }}
                                onSetPriority={(level) => {
                                  void handleSetPriority(issue, level);
                                }}
                                onUnlock={() => {
                                  void handleUnlockClick(issue);
                                }}
                                onUnblock={() => {
                                  void handleUnblockClick(issue);
                                }}
                                groomDisabled={!canFetch}
                                isSettingPriority={settingPriorityIssues.has(issue.number)}
                                isUnlocking={unlockingIssues.has(issue.number)}
                                isUnblocking={unblockingIssues.has(issue.number)}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    <div className="overflow-x-auto pb-1">
                      <div className="flex min-w-max items-start gap-4">
                        {PIPELINE_COLUMNS.map((label, columnIndex) => {
                          const stageIssues = columnMap.get(label) ?? [];
                          const isReadyColumn = label === READY_LABEL;
                          const isValidTarget =
                            dragSource !== null && isValidDropTarget(dragSource, columnIndex);

                          return (
                            <section
                              key={label}
                              className={cn(
                                'flex w-[240px] shrink-0 flex-col gap-4 rounded-sm border px-4 py-4 transition-colors',
                                isReadyColumn
                                  ? 'border-success/30 bg-success/10'
                                  : 'border-border bg-background/40',
                                dragSource !== null &&
                                  (isValidTarget
                                    ? dragOverColumn === columnIndex
                                      ? 'border-blue-400 bg-blue-500/10'
                                      : 'border-blue-400/40'
                                    : 'opacity-50')
                              )}
                              onDragOver={(e) => {
                                if (dragSource && isValidDropTarget(dragSource, columnIndex)) {
                                  e.preventDefault();
                                  e.dataTransfer.dropEffect = 'move';
                                } else {
                                  e.dataTransfer.dropEffect = 'none';
                                }
                              }}
                              onDragEnter={(e) => {
                                e.preventDefault();
                                setDragOverColumn(columnIndex);
                              }}
                              onDragLeave={(e) => {
                                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                                  setDragOverColumn(null);
                                }
                              }}
                              onDrop={(e) => {
                                e.preventDefault();
                                const targetLabel = PIPELINE_COLUMNS[columnIndex];
                                const targetStage = targetLabel
                                  ? COLUMN_RESET_STAGE[targetLabel]
                                  : undefined;
                                if (dragSource && targetStage) {
                                  setResetSelection({
                                    issue: dragSource.issue,
                                    targetStage,
                                  });
                                }
                                setDragSource(null);
                                setDragOverColumn(null);
                              }}
                            >
                              <div>
                                <h3 className="text-sm font-semibold">{DISPLAY_NAME_MAP[label]}</h3>
                              </div>

                              <div className="space-y-3">
                                {stageIssues.length > 0 ? (
                                  stageIssues.map((issue) => {
                                    const resetTargets = getResetTargets(issue.labels);
                                    const shippingCmd = shippingCommands.get(issue.number);
                                    const shippingStatus = shippingCmd?.status;

                                    return (
                                      <IssueCard
                                        key={issue.number}
                                        issue={issue}
                                        onResetSelect={(targetStage) => {
                                          setResetSelection({ issue, targetStage });
                                        }}
                                        onCloseNotPlanned={() => {
                                          setCloseNotPlannedIssue(issue);
                                        }}
                                        onSetPriority={(level) => {
                                          void handleSetPriority(issue, level);
                                        }}
                                        onUnlock={() => {
                                          void handleUnlockClick(issue);
                                        }}
                                        onUnblock={() => {
                                          void handleUnblockClick(issue);
                                        }}
                                        resetTargets={resetTargets}
                                        isResetting={resettingIssues.has(issue.number)}
                                        isSettingPriority={settingPriorityIssues.has(issue.number)}
                                        isUnlocking={unlockingIssues.has(issue.number)}
                                        isUnblocking={unblockingIssues.has(issue.number)}
                                        onShip={
                                          !isReadyColumn
                                            ? (issueNumber) => void handleShipperShip(issueNumber)
                                            : undefined
                                        }
                                        shipDisabled={
                                          !!shippingStatus || !canFetch || !hasActiveRepo
                                        }
                                        shippingStatus={shippingStatus}
                                        onStopShip={
                                          shippingCmd
                                            ? () => void handleCancelBackground(shippingCmd.id)
                                            : undefined
                                        }
                                        draggable={
                                          !resettingIssues.has(issue.number) &&
                                          !unlockingIssues.has(issue.number) &&
                                          !unblockingIssues.has(issue.number) &&
                                          !shippingStatus
                                        }
                                        onDragStart={(e) => {
                                          e.dataTransfer.effectAllowed = 'move';
                                          setDragSource({ issue, columnIndex });
                                        }}
                                        onDragEnd={() => {
                                          setDragSource(null);
                                          setDragOverColumn(null);
                                        }}
                                      />
                                    );
                                  })
                                ) : (
                                  <p className="rounded-sm border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
                                    No issues
                                  </p>
                                )}
                              </div>
                            </section>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}
              </section>
            )}
          </main>
        </div>

        {hasSession ? (
          <>
            <button
              ref={toggleButtonRef}
              type="button"
              onClick={handleToggleDrawer}
              className="cursor-pointer flex w-5 flex-shrink-0 items-center justify-center border-l border-border bg-background text-muted-foreground outline-none transition-[color,box-shadow] hover:bg-muted hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              aria-label={drawerOpen ? 'Close terminal drawer' : 'Open terminal drawer'}
            >
              {drawerOpen ? (
                <ChevronRight className="h-4 w-4" />
              ) : (
                <ChevronLeft className="h-4 w-4" />
              )}
            </button>
            <div
              ref={drawerPanelRef}
              aria-hidden={!drawerOpen}
              className={cn(
                'flex-shrink-0 overflow-hidden transition-[width] duration-200',
                drawerOpen ? 'w-[40%]' : 'pointer-events-none w-0'
              )}
            >
              <div className="h-full min-w-[40vw]">
                <TerminalPanel
                  sessions={sessions}
                  activeSessionId={activeSessionId}
                  onSelectSession={handleSelectSession}
                  onCloseSession={handleCloseSession}
                  onSessionInput={handleSessionInput}
                />
              </div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
