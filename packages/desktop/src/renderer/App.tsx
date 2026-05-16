import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';

import { BLOCKED_LABEL, toErrorMessage } from '@baremetallabs-ai/shipper-core';

import { ActionQueueDrawer } from './components/action-queue-drawer.js';
import { AdoptDialog } from './components/adopt-dialog.js';
import { AppHeader } from './components/app-header.js';
import { BackgroundLogViewer } from './components/background-log-viewer.js';
import { BackgroundToastRegion } from './components/background-toast-region.js';
import { CloseNotPlannedDialog } from './components/close-not-planned-dialog.js';
import { NewIssueDialog } from './components/new-issue-dialog.js';
import { PipelineBoard } from './components/pipeline-board.js';
import { PipelineEmptyState } from './components/pipeline-empty-state.js';
import { PipelineToolbar } from './components/pipeline-toolbar.js';
import { RepoPickerDialog } from './components/repo-picker-dialog.js';
import { ResetConfirmDialog } from './components/reset-confirm-dialog.js';
import { ResumeShipDialog } from './components/resume-ship-dialog.js';
import { SessionCloseDialog } from './components/session-close-dialog.js';
import { TerminalDrawer } from './components/terminal-drawer.js';
import { UnlockConfirmDialog } from './components/unlock-confirm-dialog.js';
import { Alert, AlertDescription, AlertTitle } from './components/ui/alert.js';
import { Button } from './components/ui/button.js';
import { TooltipProvider } from './components/ui/tooltip.js';
import { useBackgroundCommands } from './hooks/use-background-commands.js';
import { useIssuePipeline } from './hooks/use-issue-pipeline.js';
import { useRepos } from './hooks/use-repos.js';
import { useTerminalSessions } from './hooks/use-terminal-sessions.js';
import { getWorkflowStageDisplayName } from './lib/app-utils.js';
import { getShipperApi } from './lib/shipper-api.js';
import type { BackgroundCommandsBridge, IssuePipelineBridge } from './types.js';

function getLaunchKey(repo: string, issueNumber: number): string {
  return `${repo}#${issueNumber}`;
}

export default function App(): JSX.Element {
  const pipelineBridgeRef = useRef<IssuePipelineBridge | null>(null);
  const backgroundBridgeRef = useRef<BackgroundCommandsBridge | null>(null);
  const launchingGroomKeysRef = useRef<Set<string>>(new Set());
  const launchingShipKeysRef = useRef<Map<string, string | null>>(new Map());
  const launchingSetupReposRef = useRef<Set<string>>(new Set());
  const [resumeShipIssueNumber, setResumeShipIssueNumber] = useState<number | null>(null);
  const [launchingGroomKeys, setLaunchingGroomKeys] = useState<Set<string>>(() => new Set());
  const [launchingShipKeys, setLaunchingShipKeys] = useState<Map<string, string | null>>(
    () => new Map()
  );
  const [launchingSetupRepos, setLaunchingSetupRepos] = useState<Set<string>>(() => new Set());

  const reposState = useRepos({
    pipelineBridgeRef,
    backgroundBridgeRef,
  });
  const backgroundState = useBackgroundCommands({
    activeRepo: reposState.activeRepo,
    autoMergeRepos: reposState.autoMergeRepos,
    checkInitState: reposState.checkInitState,
    pipelineBridgeRef,
  });
  const pipelineState = useIssuePipeline({
    activeRepo: reposState.activeRepo,
    canFetch: reposState.canFetch,
    hasActiveRepo: reposState.hasActiveRepo,
    pushToast: backgroundState.pushToast,
  });
  const terminalState = useTerminalSessions({
    activeRepo: reposState.activeRepo,
    pushToast: backgroundState.pushToast,
    refreshIssuesForActiveRepo: pipelineState.refreshIssuesForActiveRepo,
    setFetchError: pipelineState.setFetchError,
  });

  const activeRepo = reposState.activeRepo;
  const canFetch = reposState.canFetch;
  const hasActiveRepo = reposState.hasActiveRepo;
  const repoInitialized = reposState.repoInitialized;
  const showPipelineBoard = reposState.repos.length > 0 && repoInitialized === true;
  const autoMergeEnabled = activeRepo ? reposState.autoMergeRepos.has(activeRepo) : false;
  const autoShipEnabled = activeRepo ? backgroundState.autoShipRepos.has(activeRepo) : false;
  const activeRepoGroomPendingIssues = useMemo(() => {
    if (!activeRepo) {
      return new Set<number>();
    }

    const keyPrefix = `${activeRepo}#`;
    const issueNumbers = new Set<number>();
    for (const key of launchingGroomKeys) {
      if (key.startsWith(keyPrefix)) {
        issueNumbers.add(Number(key.slice(keyPrefix.length)));
      }
    }

    return issueNumbers;
  }, [activeRepo, launchingGroomKeys]);
  const activeRepoShipPendingIssues = useMemo(() => {
    if (!activeRepo) {
      return new Set<number>();
    }

    const keyPrefix = `${activeRepo}#`;
    const issueNumbers = new Set<number>();
    for (const key of launchingShipKeys.keys()) {
      if (key.startsWith(keyPrefix)) {
        issueNumbers.add(Number(key.slice(keyPrefix.length)));
      }
    }

    return issueNumbers;
  }, [activeRepo, launchingShipKeys]);
  const actionQueueCommands = useMemo(
    () =>
      backgroundState.backgroundCommands.map((command) => {
        const currentIssue =
          command.issueNumber !== undefined && command.repo === activeRepo
            ? pipelineState.getIssueByNumber(command.issueNumber)
            : undefined;

        return {
          id: command.id,
          command: command.command,
          status: command.status,
          stateChangedAt: command.stateChangedAt,
          repo: command.repo,
          issueNumber: command.issueNumber,
          issueUrl: command.issueUrl,
          issueTitle: currentIssue?.title ?? command.issueTitle,
          workflowStage: currentIssue
            ? getWorkflowStageDisplayName(currentIssue.labels)
            : undefined,
          stillBlocked: currentIssue?.labels.includes(BLOCKED_LABEL) ?? false,
          prMerged: command.prMerged,
          canCancel: command.status === 'queued' || command.status === 'running',
          canShowLogs:
            command.command === 'new'
              ? Boolean(command.logFile)
              : command.output.length > 0 || command.status !== 'queued',
          cancelled: command.cancelled,
        };
      }),
    [activeRepo, backgroundState.backgroundCommands, pipelineState.getIssueByNumber]
  );

  useEffect(() => {
    if (launchingShipKeysRef.current.size === 0) {
      return;
    }

    const visibleBackgroundSessionIds = new Set(
      backgroundState.backgroundCommands.map((command) => command.id)
    );
    let changed = false;

    for (const [shipKey, sessionId] of launchingShipKeysRef.current) {
      if (sessionId !== null && visibleBackgroundSessionIds.has(sessionId)) {
        launchingShipKeysRef.current.delete(shipKey);
        changed = true;
      }
    }

    if (changed) {
      setLaunchingShipKeys(new Map(launchingShipKeysRef.current));
    }
  }, [backgroundState.backgroundCommands, launchingShipKeys]);

  async function handleShipperNew(request: string, repo = activeRepo): Promise<void> {
    try {
      await getShipperApi().spawnBackgroundNew(request, repo);
    } catch (error) {
      pipelineState.setFetchError(`Failed to launch shipper new: ${toErrorMessage(error)}`);
    }
  }

  async function handleShipperGroom(issueNumber: number): Promise<void> {
    const repo = activeRepo;
    if (!repo) {
      return;
    }

    if (terminalState.focusExistingGroomSession(issueNumber)) {
      return;
    }

    const groomKey = getLaunchKey(repo, issueNumber);
    if (launchingGroomKeysRef.current.has(groomKey)) {
      return;
    }

    launchingGroomKeysRef.current.add(groomKey);
    setLaunchingGroomKeys(new Set(launchingGroomKeysRef.current));

    try {
      const result = await getShipperApi().spawnShipperGroom(issueNumber, repo, 120, 30);
      terminalState.openRunningSession(result.sessionId, `groom — #${issueNumber}`, {
        repo,
        issueNumber,
      });
    } catch (error) {
      pipelineState.setFetchError(`Failed to launch shipper groom: ${toErrorMessage(error)}`);
    } finally {
      launchingGroomKeysRef.current.delete(groomKey);
      setLaunchingGroomKeys(new Set(launchingGroomKeysRef.current));
    }
  }

  async function handleShipperSetup(): Promise<void> {
    const repo = activeRepo;
    if (!repo || terminalState.focusExistingSetupSession(repo)) {
      return;
    }

    if (launchingSetupReposRef.current.has(repo)) {
      return;
    }

    launchingSetupReposRef.current.add(repo);
    setLaunchingSetupRepos(new Set(launchingSetupReposRef.current));

    try {
      const result = await getShipperApi().spawnShipperSetup(repo, 120, 30);
      terminalState.openRunningSession(result.sessionId, `setup — ${repo}`, {
        repo,
      });
    } catch (error) {
      pipelineState.setFetchError(`Failed to launch shipper setup: ${toErrorMessage(error)}`);
    } finally {
      launchingSetupReposRef.current.delete(repo);
      setLaunchingSetupRepos(new Set(launchingSetupReposRef.current));
    }
  }

  async function handleShipperShip(issueNumber: number, repo = activeRepo): Promise<void> {
    if (!repo) {
      return;
    }

    const shipKey = getLaunchKey(repo, issueNumber);
    if (launchingShipKeysRef.current.has(shipKey)) {
      return;
    }

    launchingShipKeysRef.current.set(shipKey, null);
    setLaunchingShipKeys(new Map(launchingShipKeysRef.current));

    try {
      const issueTitle =
        repo === activeRepo ? pipelineState.getIssueByNumber(issueNumber)?.title : undefined;
      const result = await getShipperApi().spawnBackgroundShip(
        issueNumber,
        repo,
        reposState.autoMergeRepos.has(repo),
        undefined,
        issueTitle
      );
      launchingShipKeysRef.current.set(shipKey, result.sessionId);
      setLaunchingShipKeys(new Map(launchingShipKeysRef.current));
    } catch (error) {
      launchingShipKeysRef.current.delete(shipKey);
      setLaunchingShipKeys(new Map(launchingShipKeysRef.current));
      pipelineState.setFetchError(`Failed to launch shipper ship: ${toErrorMessage(error)}`);
    }
  }

  async function handleResumeAndShipConfirm(): Promise<void> {
    if (resumeShipIssueNumber === null) {
      return;
    }

    try {
      await backgroundState.handleResumeIssue(resumeShipIssueNumber, activeRepo);
      await handleShipperShip(resumeShipIssueNumber, activeRepo);
      setResumeShipIssueNumber(null);
    } catch (error) {
      pipelineState.setFetchError(`Failed to resume and ship: ${toErrorMessage(error)}`);
    }
  }

  async function handleShipperInit(repo = activeRepo): Promise<void> {
    try {
      await getShipperApi().spawnBackgroundInit(repo);
    } catch (error) {
      pipelineState.setFetchError(`Failed to launch shipper init: ${toErrorMessage(error)}`);
    }
  }

  function openRepoPicker(): void {
    reposState.setIsPickerOpen(true);
  }

  function handleToggleAutoMerge(): void {
    if (!activeRepo) {
      return;
    }

    void reposState.handleToggleAutoMerge(activeRepo);
  }

  async function handleToggleAutoShip(): Promise<void> {
    if (!activeRepo) {
      return;
    }

    if (backgroundState.autoShipRepos.has(activeRepo)) {
      backgroundState.clearAutoShipStateForRepo(activeRepo);
      await getShipperApi().requestAutoShipHalt(activeRepo);
      return;
    }

    backgroundState.enableAutoShipForRepo(activeRepo);
  }

  pipelineBridgeRef.current = {
    loadIssues: pipelineState.loadIssues,
    clearIssueState: pipelineState.clearIssueState,
    setFetchError: pipelineState.setFetchError,
    getIssueByNumber: pipelineState.getIssueByNumber,
    getPausedIssues: () => pipelineState.pausedIssues,
    trackPausedIssue: pipelineState.trackPausedIssue,
    clearPausedIssue: pipelineState.clearPausedIssue,
    trackUnblockIssue: pipelineState.trackUnblockIssue,
    clearUnblockIssue: pipelineState.clearUnblockIssue,
  };
  backgroundBridgeRef.current = {
    clearAutoShipStateForRepo: backgroundState.clearAutoShipStateForRepo,
  };

  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col bg-transparent">
        <BackgroundToastRegion
          toasts={backgroundState.toasts}
          onDismiss={backgroundState.dismissToast}
          onRetry={backgroundState.handleRetryToast}
        />
        <BackgroundLogViewer
          open={backgroundState.logViewer.open}
          title={backgroundState.logViewer.title}
          content={backgroundState.logViewer.content}
          onOpenChange={backgroundState.handleLogViewerOpenChange}
        />
        <RepoPickerDialog
          open={reposState.isPickerOpen}
          onOpenChange={reposState.setIsPickerOpen}
          repos={reposState.repos}
          onSelectRepo={reposState.handleAddRepo}
        />
        <NewIssueDialog
          open={pipelineState.isNewIssueOpen}
          onOpenChange={pipelineState.setIsNewIssueOpen}
          repos={reposState.repos}
          activeRepo={activeRepo}
          onSubmit={(request, repo) => {
            void handleShipperNew(request, repo);
          }}
        />
        <AdoptDialog
          open={pipelineState.isAdoptOpen}
          onOpenChange={pipelineState.setIsAdoptOpen}
          repo={activeRepo}
          onAdopted={() => {
            void pipelineState.loadIssues(activeRepo);
          }}
        />
        <ResetConfirmDialog
          open={pipelineState.resetSelection !== null}
          onOpenChange={(open) => {
            if (!open) {
              pipelineState.setResetSelection(null);
            }
          }}
          repo={activeRepo}
          issueNumber={pipelineState.resetSelection?.issue.number ?? null}
          targetStage={pipelineState.resetSelection?.targetStage ?? null}
          onResetStart={pipelineState.trackResetIssue}
          onResetSuccess={pipelineState.handleResetSuccess}
          onResetFailure={pipelineState.clearResetIssue}
        />
        <CloseNotPlannedDialog
          open={pipelineState.closeNotPlannedIssue !== null}
          onOpenChange={(open) => {
            if (!open) {
              pipelineState.setCloseNotPlannedIssue(null);
            }
          }}
          repo={activeRepo}
          issue={pipelineState.closeNotPlannedIssue}
          onSuccess={pipelineState.handleCloseNotPlannedSuccess}
          onError={pipelineState.handleCloseNotPlannedError}
        />
        <UnlockConfirmDialog
          open={pipelineState.unlockConfirmIssue !== null}
          onOpenChange={(open) => {
            if (!open) {
              pipelineState.setUnlockConfirmIssue(null);
            }
          }}
          issue={pipelineState.unlockConfirmIssue}
          onConfirm={pipelineState.handleUnlockDialogConfirm}
        />
        <SessionCloseDialog
          pendingClose={terminalState.pendingClose}
          onOpenChange={terminalState.handlePendingCloseOpenChange}
          onConfirm={() => {
            void terminalState.handleConfirmCloseSession();
          }}
        />
        <ResumeShipDialog
          issueNumber={resumeShipIssueNumber}
          open={resumeShipIssueNumber !== null}
          onOpenChange={(open) => {
            if (!open) {
              setResumeShipIssueNumber(null);
            }
          }}
          onConfirm={() => {
            void handleResumeAndShipConfirm();
          }}
        />

        <div className="flex min-h-0 flex-1">
          <ActionQueueDrawer
            open={backgroundState.actionQueueOpen}
            onToggle={backgroundState.handleToggleActionQueue}
            commands={actionQueueCommands}
            onCancel={(sessionId) => {
              void backgroundState.handleCancelBackground(sessionId);
            }}
            onShowLogs={(sessionId) => {
              void backgroundState.handleShowBackgroundLogs(sessionId);
            }}
            onClearFinished={backgroundState.handleClearFinishedBackground}
            onDismiss={backgroundState.handleDismissBackground}
          />
          <div
            ref={terminalState.contentPaneRef}
            tabIndex={-1}
            className="min-w-0 flex-1 overflow-y-auto"
          >
            <AppHeader
              repos={reposState.repos}
              activeRepo={activeRepo}
              activeCommandRepos={backgroundState.activeCommandRepos}
              onSelectRepo={(repo) => {
                void reposState.handleSwitchRepo(repo);
              }}
              onCloseRepo={(repo) => {
                void reposState.handleCloseRepo(repo);
              }}
              onAddRepo={openRepoPicker}
              onReorderRepos={(nextRepos) => {
                void reposState.handleReorderRepos(nextRepos);
              }}
            />

            <main className="mx-auto flex max-w-7xl flex-col gap-4 px-6 py-6">
              {reposState.prerequisiteMessage ? (
                <Alert variant="destructive">
                  <AlertTitle>GitHub CLI required</AlertTitle>
                  <AlertDescription>{reposState.prerequisiteMessage}</AlertDescription>
                </Alert>
              ) : null}

              {pipelineState.fetchError ? (
                <Alert variant="destructive" className="pr-24">
                  <AlertTitle>Issue fetch failed</AlertTitle>
                  <AlertDescription>{pipelineState.fetchError}</AlertDescription>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="absolute top-2 right-2"
                    onClick={() => {
                      pipelineState.setFetchError(null);
                    }}
                  >
                    Dismiss
                  </Button>
                </Alert>
              ) : null}

              {hasActiveRepo ? (
                <PipelineToolbar
                  lastUpdated={pipelineState.lastUpdated}
                  canFetch={canFetch}
                  isLoading={pipelineState.isLoading}
                  setupEnabled={hasActiveRepo}
                  isSetupPending={activeRepo ? launchingSetupRepos.has(activeRepo) : false}
                  onNewIssue={pipelineState.handleOpenNewIssue}
                  onAdopt={pipelineState.handleOpenAdopt}
                  onSetup={() => {
                    void handleShipperSetup();
                  }}
                  onRefresh={() => {
                    void pipelineState.handleRefresh();
                  }}
                />
              ) : null}

              {showPipelineBoard ? (
                <PipelineBoard
                  repo={activeRepo}
                  issues={pipelineState.issues}
                  columnMap={pipelineState.columnMap}
                  attentionIssues={pipelineState.attentionIssues}
                  resettingIssues={pipelineState.resettingIssues}
                  unlockingIssues={pipelineState.unlockingIssues}
                  unblockingIssues={pipelineState.unblockingIssues}
                  settingPriorityIssues={pipelineState.settingPriorityIssues}
                  pausedIssues={pipelineState.pausedIssues}
                  pausePendingIssues={backgroundState.pausePendingIssues}
                  groomPendingIssues={activeRepoGroomPendingIssues}
                  shipPendingIssues={activeRepoShipPendingIssues}
                  shippingCommands={backgroundState.shippingCommands}
                  autoMergeEnabled={autoMergeEnabled}
                  autoShipEnabled={autoShipEnabled}
                  isLoading={pipelineState.isLoading}
                  canFetch={canFetch}
                  hasActiveRepo={hasActiveRepo}
                  isSavingAutoMerge={reposState.isSavingAutoMerge}
                  onToggleAutoMerge={handleToggleAutoMerge}
                  onToggleAutoShip={() => {
                    void handleToggleAutoShip();
                  }}
                  onResetSelect={pipelineState.setResetSelection}
                  onCloseNotPlanned={pipelineState.setCloseNotPlannedIssue}
                  onSetPriority={(issue, level) => {
                    void pipelineState.handleSetPriority(issue, level);
                  }}
                  onUnlockClick={(issue) => {
                    void pipelineState.handleUnlockClick(issue);
                  }}
                  onUnblockClick={(issue) => {
                    void pipelineState.handleUnblockClick(issue);
                  }}
                  onPauseIssue={(issue) => {
                    void backgroundState.handlePauseIssue(issue);
                  }}
                  onResumeIssue={(issueNumber) => {
                    void backgroundState.handleResumeIssue(issueNumber);
                  }}
                  onGroom={(issueNumber) => {
                    void handleShipperGroom(issueNumber);
                  }}
                  onShip={(issueNumber) => {
                    if (pipelineState.pausedIssues.has(issueNumber)) {
                      setResumeShipIssueNumber(issueNumber);
                      return;
                    }

                    void handleShipperShip(issueNumber);
                  }}
                  onCancelShip={(sessionId) => {
                    void backgroundState.handleCancelBackground(sessionId);
                  }}
                />
              ) : (
                <PipelineEmptyState
                  repoCount={reposState.repos.length}
                  repoInitialized={repoInitialized}
                  canFetch={canFetch}
                  hasActiveRepo={hasActiveRepo}
                  onAddRepo={openRepoPicker}
                  onInit={() => {
                    void handleShipperInit();
                  }}
                />
              )}
            </main>
          </div>

          {terminalState.hasSession ? (
            <TerminalDrawer
              sessions={terminalState.sessions}
              activeSessionId={terminalState.activeSessionId}
              open={terminalState.drawerOpen}
              toggleButtonRef={terminalState.toggleButtonRef}
              drawerPanelRef={terminalState.drawerPanelRef}
              onToggle={terminalState.handleToggleDrawer}
              onSelectSession={terminalState.handleSelectSession}
              onCloseSession={terminalState.handleCloseSession}
              onSessionInput={terminalState.handleSessionInput}
            />
          ) : null}
        </div>
      </div>
    </TooltipProvider>
  );
}
