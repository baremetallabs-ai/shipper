import { useRef } from 'react';
import type { DragEvent, JSX } from 'react';
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
  READY_LABEL,
} from '../../../core/src/lib/labels.js';
import { toErrorMessage } from '../../../core/src/lib/errors.js';
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
import { getWorkflowStageCacheKey } from './lib/app-utils.js';
import {
  COLUMN_RESET_STAGE,
  dateFormatter,
  PIPELINE_COLUMNS,
  POST_IMPLEMENTATION_LABELS,
  RESET_STAGE_LABELS,
  RESET_STAGE_ORDER,
} from './lib/constants.js';
import { useBackgroundCommands } from './hooks/use-background-commands.js';
import { useDragDrop } from './hooks/use-drag-drop.js';
import { useTerminalSessions } from './hooks/use-terminal-sessions.js';
import { cn } from './lib/utils.js';
import { useIssuePipeline } from './hooks/use-issue-pipeline.js';
import { useRepos } from './hooks/use-repos.js';
import type { BackgroundCommandsBridge, IssuePipelineBridge } from './types.js';

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
  const pipelineBridgeRef = useRef<IssuePipelineBridge | null>(null);
  const backgroundBridgeRef = useRef<BackgroundCommandsBridge | null>(null);

  const {
    repos,
    activeRepo,
    autoMergeRepos,
    repoInitialized,
    isPickerOpen,
    isSavingAutoMerge,
    prerequisiteMessage,
    canFetch,
    hasActiveRepo,
    setIsPickerOpen,
    checkInitState,
    handleAddRepo,
    handleSwitchRepo,
    handleReorderRepos,
    handleCloseRepo,
    handleToggleAutoMerge,
  } = useRepos({
    pipelineBridgeRef,
    backgroundBridgeRef,
  });

  const {
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
  } = useBackgroundCommands({
    activeRepo,
    autoMergeRepos,
    checkInitState,
    pipelineBridgeRef,
  });
  const {
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
    clearIssueState,
    clearStageCacheForRepo,
    handleRefresh,
    trackResetIssue,
    clearResetIssue,
    trackUnblockIssue,
    clearUnblockIssue,
    handleResetSuccess,
    handleCloseNotPlannedSuccess,
    handleCloseNotPlannedError,
    handleUnlockClick,
    handleUnlockDialogConfirm,
    handleUnblockClick,
    handleSetPriority,
    handleOpenNewIssue,
    handleOpenAdopt,
  } = useIssuePipeline({
    activeRepo,
    canFetch,
    hasActiveRepo,
    hasRunningShipCommand,
    pushToast,
  });
  const {
    sessions,
    activeSessionId,
    pendingCloseSession,
    drawerOpen,
    hasSession,
    contentPaneRef,
    toggleButtonRef,
    drawerPanelRef,
    openRunningSession,
    focusExistingGroomSession,
    handlePendingCloseOpenChange,
    handleToggleDrawer,
    handleSelectSession,
    handleCloseSession,
    handleSessionInput,
    handleConfirmCloseSession,
  } = useTerminalSessions({
    activeRepo,
    setFetchError,
  });
  const { dragSource, dragOverColumn, startDrag, endDrag, setDragOverColumn, clearDrag } =
    useDragDrop();

  async function handleShipperNew(request: string, repo = activeRepo): Promise<void> {
    try {
      await window.shipperAPI.spawnBackgroundNew(request, repo);
    } catch (error) {
      const message = toErrorMessage(error);
      setFetchError(`Failed to launch shipper new: ${message}`);
    }
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
      const message = toErrorMessage(error);
      setFetchError(`Failed to launch shipper groom: ${message}`);
    }
  }

  async function handleShipperShip(issueNumber: number, repo = activeRepo): Promise<void> {
    try {
      await window.shipperAPI.spawnBackgroundShip(issueNumber, repo, autoMergeRepos.has(repo));
    } catch (error) {
      const message = toErrorMessage(error);
      setFetchError(`Failed to launch shipper ship: ${message}`);
    }
  }

  async function handleShipperInit(repo = activeRepo): Promise<void> {
    try {
      await window.shipperAPI.spawnBackgroundInit(repo);
    } catch (error) {
      const message = toErrorMessage(error);
      setFetchError(`Failed to launch shipper init: ${message}`);
    }
  }

  pipelineBridgeRef.current = {
    loadIssues,
    clearIssueState,
    clearStageCacheForRepo,
    setFetchError,
    trackUnblockIssue,
    clearUnblockIssue,
  };

  backgroundBridgeRef.current = {
    clearAutoShipStateForRepo,
  };

  return (
    <div className="flex h-screen flex-col bg-transparent">
      <BackgroundToastRegion toasts={toasts} onDismiss={dismissToast} onRetry={handleRetryToast} />
      <BackgroundLogViewer
        open={logViewer.open}
        title={logViewer.title}
        content={logViewer.content}
        onOpenChange={handleLogViewerOpenChange}
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
      <Dialog open={pendingCloseSession !== null} onOpenChange={handlePendingCloseOpenChange}>
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
                handlePendingCloseOpenChange(false);
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
              workflowStage:
                command.command === 'ship' && command.issueNumber !== undefined
                  ? stageCache.get(getWorkflowStageCacheKey(command.repo, command.issueNumber))
                  : undefined,
            };
          })}
          onCancel={(sessionId) => {
            void handleCancelBackground(sessionId);
          }}
          onShowLogs={(sessionId) => {
            void handleShowBackgroundLogs(sessionId);
          }}
          onClearFinished={handleClearFinishedBackground}
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
                                clearDrag();
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
                                          startDrag(issue, columnIndex);
                                        }}
                                        onDragEnd={endDrag}
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
