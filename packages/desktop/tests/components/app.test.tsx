// @vitest-environment jsdom

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  reposState: {} as Record<string, unknown>,
  backgroundState: {} as Record<string, unknown>,
  pipelineState: {} as Record<string, unknown>,
  terminalState: {} as Record<string, unknown>,
  spawnShipperSetupMock: vi.fn(),
  spawnBackgroundShipMock: vi.fn(),
}));

vi.mock('../../src/renderer/hooks/use-repos.js', () => ({
  useRepos: () => state.reposState,
}));

vi.mock('../../src/renderer/hooks/use-background-commands.js', () => ({
  useBackgroundCommands: () => state.backgroundState,
}));

vi.mock('../../src/renderer/hooks/use-issue-pipeline.js', () => ({
  useIssuePipeline: () => state.pipelineState,
}));

vi.mock('../../src/renderer/hooks/use-terminal-sessions.js', () => ({
  useTerminalSessions: () => state.terminalState,
}));

vi.mock('../../src/renderer/lib/shipper-api.js', () => ({
  getShipperApi: () => ({
    spawnShipperSetup: state.spawnShipperSetupMock,
    spawnShipperGroom: vi.fn(),
    spawnBackgroundNew: vi.fn(),
    spawnBackgroundShip: state.spawnBackgroundShipMock,
    spawnBackgroundInit: vi.fn(),
  }),
}));

vi.mock('../../src/renderer/components/action-queue-drawer.js', () => ({
  ActionQueueDrawer: () => null,
}));

vi.mock('../../src/renderer/components/adopt-dialog.js', () => ({
  AdoptDialog: () => null,
}));

vi.mock('../../src/renderer/components/app-header.js', () => ({
  AppHeader: () => null,
}));

vi.mock('../../src/renderer/components/background-log-viewer.js', () => ({
  BackgroundLogViewer: () => null,
}));

vi.mock('../../src/renderer/components/background-toast-region.js', () => ({
  BackgroundToastRegion: () => null,
}));

vi.mock('../../src/renderer/components/close-not-planned-dialog.js', () => ({
  CloseNotPlannedDialog: () => null,
}));

vi.mock('../../src/renderer/components/new-issue-dialog.js', () => ({
  NewIssueDialog: () => null,
}));

vi.mock('../../src/renderer/components/pipeline-board.js', () => ({
  PipelineBoard: ({ onShip }: { onShip: (issueNumber: number) => void }) => (
    <button
      type="button"
      onClick={() => {
        onShip(42);
      }}
    >
      Ship issue
    </button>
  ),
}));

vi.mock('../../src/renderer/components/pipeline-empty-state.js', () => ({
  PipelineEmptyState: () => null,
}));

vi.mock('../../src/renderer/components/repo-picker-dialog.js', () => ({
  RepoPickerDialog: () => null,
}));

vi.mock('../../src/renderer/components/reset-confirm-dialog.js', () => ({
  ResetConfirmDialog: () => null,
}));

vi.mock('../../src/renderer/components/resume-ship-dialog.js', () => ({
  ResumeShipDialog: ({
    open,
    onOpenChange,
    onConfirm,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onConfirm: () => void;
  }) =>
    open ? (
      <div>
        <p>This issue is paused. Resume and ship anyway?</p>
        <button type="button" onClick={onConfirm}>
          Resume and ship
        </button>
        <button
          type="button"
          onClick={() => {
            onOpenChange(false);
          }}
        >
          Cancel
        </button>
      </div>
    ) : null,
}));

vi.mock('../../src/renderer/components/session-close-dialog.js', () => ({
  SessionCloseDialog: () => null,
}));

vi.mock('../../src/renderer/components/terminal-drawer.js', () => ({
  TerminalDrawer: () => null,
}));

vi.mock('../../src/renderer/components/unlock-confirm-dialog.js', () => ({
  UnlockConfirmDialog: () => null,
}));

vi.mock('../../src/renderer/components/ui/tooltip.js', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import App from '../../src/renderer/App.js';

function resetMockState(): void {
  state.spawnShipperSetupMock.mockReset();
  state.spawnBackgroundShipMock.mockReset();
  state.reposState = {
    activeRepo: 'owner/repo',
    autoMergeRepos: new Set<string>(),
    canFetch: true,
    checkInitState: vi.fn(),
    handleAddRepo: vi.fn(),
    handleCloseRepo: vi.fn(),
    handleReorderRepos: vi.fn(),
    handleSwitchRepo: vi.fn(),
    handleToggleAutoMerge: vi.fn(),
    hasActiveRepo: true,
    isPickerOpen: false,
    isSavingAutoMerge: false,
    prerequisiteMessage: null,
    repoInitialized: true,
    repos: ['owner/repo'],
    setIsPickerOpen: vi.fn(),
  };
  state.backgroundState = {
    actionQueueOpen: false,
    activeCommandRepos: new Set<string>(),
    autoShipRepos: new Set<string>(),
    backgroundCommands: [],
    checkInitState: vi.fn(),
    clearAutoShipStateForRepo: vi.fn(),
    dismissToast: vi.fn(),
    enableAutoShipForRepo: vi.fn(),
    handleCancelBackground: vi.fn(),
    handleClearFinishedBackground: vi.fn(),
    handleDismissBackground: vi.fn(),
    handlePauseIssue: vi.fn(),
    handleResumeIssue: vi.fn(() => Promise.resolve()),
    handleRetryToast: vi.fn(),
    handleShowBackgroundLogs: vi.fn(),
    handleToggleActionQueue: vi.fn(),
    hasRunningShipCommand: false,
    logViewer: {
      content: '',
      open: false,
      title: '',
    },
    pausePendingIssues: new Set<number>(),
    pushToast: vi.fn(),
    shippingCommands: new Map<number, unknown>(),
    toasts: [],
  };
  state.pipelineState = {
    attentionIssues: {
      failed: [],
      new: [],
    },
    clearIssueState: vi.fn(),
    clearPausedIssue: vi.fn(),
    clearResetIssue: vi.fn(),
    clearStageCacheForRepo: vi.fn(),
    clearUnblockIssue: vi.fn(),
    closeNotPlannedIssue: null,
    columnMap: new Map<string, unknown[]>(),
    fetchError: null,
    handleCloseNotPlannedError: vi.fn(),
    handleCloseNotPlannedSuccess: vi.fn(),
    handleOpenAdopt: vi.fn(),
    handleOpenNewIssue: vi.fn(),
    handleRefresh: vi.fn(),
    handleSetPriority: vi.fn(),
    handleUnblockClick: vi.fn(),
    handleUnlockClick: vi.fn(),
    handleUnlockDialogConfirm: vi.fn(),
    isAdoptOpen: false,
    isLoading: false,
    isNewIssueOpen: false,
    issues: [],
    lastUpdated: null,
    loadIssues: vi.fn(),
    getIssueByNumber: vi.fn(),
    pausedIssues: new Set<number>(),
    resetSelection: null,
    resettingIssues: new Set<number>(),
    setCloseNotPlannedIssue: vi.fn(),
    setFetchError: vi.fn(),
    setIsAdoptOpen: vi.fn(),
    setIsNewIssueOpen: vi.fn(),
    setResetSelection: vi.fn(),
    settingPriorityIssues: new Set<number>(),
    stageCache: new Map<string, unknown>(),
    trackPausedIssue: vi.fn(),
    trackResetIssue: vi.fn(),
    trackUnblockIssue: vi.fn(),
    unblockIssues: new Set<number>(),
    unblockingIssues: new Set<number>(),
    unlockConfirmIssue: null,
    unlockingIssues: new Set<number>(),
  };
  state.terminalState = {
    activeSessionId: null,
    contentPaneRef: { current: null },
    drawerOpen: false,
    drawerPanelRef: { current: null },
    focusExistingGroomSession: vi.fn(() => false),
    focusExistingSetupSession: vi.fn(() => false),
    handleCloseSession: vi.fn(),
    handleConfirmCloseSession: vi.fn(() => Promise.resolve()),
    handlePendingCloseOpenChange: vi.fn(),
    handleSelectSession: vi.fn(),
    handleSessionInput: vi.fn(),
    handleToggleDrawer: vi.fn(),
    hasSession: false,
    openRunningSession: vi.fn(),
    pendingCloseSession: null,
    sessions: [],
    toggleButtonRef: { current: null },
  };
}

describe('App setup launch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockState();
  });

  it('deduplicates rapid Setup clicks while the first launch is still pending', async () => {
    let resolveSetup: ((value: { sessionId: string }) => void) | undefined;
    const setupPromise = new Promise<{ sessionId: string }>((resolve) => {
      resolveSetup = resolve;
    });
    state.spawnShipperSetupMock.mockReturnValue(setupPromise);

    render(<App />);

    const setupButton = screen.getByRole('button', { name: 'Setup' });
    fireEvent.click(setupButton);
    fireEvent.click(setupButton);

    expect(state.terminalState.focusExistingSetupSession).toHaveBeenCalledTimes(2);
    expect(state.spawnShipperSetupMock).toHaveBeenCalledTimes(1);
    expect(state.spawnShipperSetupMock).toHaveBeenCalledWith('owner/repo', 120, 30);
    expect(state.terminalState.openRunningSession).not.toHaveBeenCalled();

    await act(async () => {
      resolveSetup?.({ sessionId: 'pty-setup-42' });
      await setupPromise;
    });

    expect(state.terminalState.openRunningSession).toHaveBeenCalledWith(
      'pty-setup-42',
      'setup — owner/repo',
      { repo: 'owner/repo' }
    );
  });

  it('allows retrying Setup after a failed launch settles', async () => {
    state.spawnShipperSetupMock
      .mockRejectedValueOnce(new Error('clone failed'))
      .mockResolvedValueOnce({ sessionId: 'pty-setup-43' });

    render(<App />);

    const setupButton = screen.getByRole('button', { name: 'Setup' });

    await act(async () => {
      fireEvent.click(setupButton);
      await Promise.resolve();
    });

    fireEvent.click(setupButton);

    expect(state.spawnShipperSetupMock).toHaveBeenCalledTimes(2);
    expect(state.pipelineState.setFetchError).toHaveBeenCalledWith(
      'Failed to launch shipper setup: clone failed'
    );
  });

  it('prompts before shipping a paused issue and resumes only on confirm', async () => {
    state.pipelineState.pausedIssues = new Set<number>([42]);

    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Ship issue' }));
    expect(screen.getByText('This issue is paused. Resume and ship anyway?')).toBeTruthy();
    expect(state.spawnBackgroundShipMock).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Resume and ship' }));
      await Promise.resolve();
    });

    expect(state.backgroundState.handleResumeIssue).toHaveBeenCalledWith(42, 'owner/repo');
    expect(state.spawnBackgroundShipMock).toHaveBeenCalledWith(42, 'owner/repo', false);
  });

  it('leaves a paused issue untouched when the resume-and-ship dialog is cancelled', () => {
    state.pipelineState.pausedIssues = new Set<number>([42]);

    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Ship issue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(state.backgroundState.handleResumeIssue).not.toHaveBeenCalled();
    expect(state.spawnBackgroundShipMock).not.toHaveBeenCalled();
    expect(screen.queryByText('This issue is paused. Resume and ship anyway?')).toBeNull();
  });
});
