// @vitest-environment jsdom

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  reposState: {},
  backgroundState: {},
  pipelineState: {},
  terminalState: {},
  terminalOptions: null as Record<string, unknown> | null,
  spawnShipperSetupMock: vi.fn(),
  spawnShipperGroomMock: vi.fn(),
  spawnBackgroundShipMock: vi.fn(),
  requestAutoShipHaltMock: vi.fn(),
  actionQueueDrawerProps: null as Record<string, unknown> | null,
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
  useTerminalSessions: (options: Record<string, unknown>) => {
    state.terminalOptions = options;
    return state.terminalState;
  },
}));

vi.mock('../../src/renderer/lib/shipper-api.js', () => ({
  getShipperApi: () => ({
    spawnShipperSetup: state.spawnShipperSetupMock,
    spawnShipperGroom: state.spawnShipperGroomMock,
    spawnBackgroundNew: vi.fn(),
    spawnBackgroundShip: state.spawnBackgroundShipMock,
    spawnBackgroundInit: vi.fn(),
    requestAutoShipHalt: state.requestAutoShipHaltMock,
  }),
}));

vi.mock('../../src/renderer/components/action-queue-drawer.js', () => ({
  ActionQueueDrawer: (props: Record<string, unknown>) => {
    state.actionQueueDrawerProps = props;
    return null;
  },
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
  PipelineBoard: ({
    groomPendingIssues,
    shipPendingIssues,
    onGroom,
    onShip,
    onToggleAutoShip,
  }: {
    groomPendingIssues: ReadonlySet<number>;
    shipPendingIssues: ReadonlySet<number>;
    onGroom: (issueNumber: number) => void;
    onShip: (issueNumber: number) => void;
    onToggleAutoShip: () => void;
  }) => (
    <>
      <button
        type="button"
        disabled={groomPendingIssues.has(42)}
        onClick={() => {
          onGroom(42);
        }}
      >
        Groom issue 42
      </button>
      <button
        type="button"
        disabled={groomPendingIssues.has(43)}
        onClick={() => {
          onGroom(43);
        }}
      >
        Groom issue 43
      </button>
      <button
        type="button"
        disabled={shipPendingIssues.has(42)}
        onClick={() => {
          onShip(42);
        }}
      >
        Ship issue 42
      </button>
      <button
        type="button"
        disabled={shipPendingIssues.has(43)}
        onClick={() => {
          onShip(43);
        }}
      >
        Ship issue 43
      </button>
      <button
        type="button"
        onClick={() => {
          onToggleAutoShip();
        }}
      >
        Toggle auto-ship
      </button>
    </>
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
  state.spawnShipperGroomMock.mockReset();
  state.spawnBackgroundShipMock.mockReset();
  state.requestAutoShipHaltMock.mockReset();
  state.actionQueueDrawerProps = null;
  state.terminalOptions = null;
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
    refreshIssuesForActiveRepo: vi.fn(() => Promise.resolve()),
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
    pendingClose: null,
    sessions: [],
    toggleButtonRef: { current: null },
  };
}

function createBackgroundShipCommand(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 'bg-ship-42',
    command: 'ship',
    repo: 'owner/repo',
    status: 'running',
    stateChangedAt: Date.parse('2026-04-03T12:00:00.000Z'),
    title: 'Ship #42',
    detail: 'Shipping #42...',
    output: '',
    cancelled: false,
    issueNumber: 42,
    ...overrides,
  };
}

describe('App setup launch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockState();
  });

  it('passes app-level callbacks into terminal session state', () => {
    render(<App />);

    expect(state.terminalOptions?.activeRepo).toBe('owner/repo');
    expect(state.terminalOptions?.setFetchError).toBe(state.pipelineState.setFetchError);
    expect(state.terminalOptions?.pushToast).toBe(state.backgroundState.pushToast);
    expect(state.terminalOptions?.refreshIssuesForActiveRepo).toBe(
      state.pipelineState.refreshIssuesForActiveRepo
    );
  });

  it('shows pending Groom feedback only for the launching issue and clears it on success', async () => {
    let resolveGroom: ((value: { sessionId: string }) => void) | undefined;
    const groomPromise = new Promise<{ sessionId: string }>((resolve) => {
      resolveGroom = resolve;
    });
    state.spawnShipperGroomMock.mockReturnValue(groomPromise);

    render(<App />);

    const issue42Button = screen.getByRole('button', { name: 'Groom issue 42' });
    const issue43Button = screen.getByRole('button', { name: 'Groom issue 43' });
    fireEvent.click(issue42Button);

    expect(issue42Button).toHaveProperty('disabled', true);
    expect(issue43Button).toHaveProperty('disabled', false);

    fireEvent.click(issue42Button);

    expect(state.terminalState.focusExistingGroomSession).toHaveBeenCalledTimes(1);
    expect(state.spawnShipperGroomMock).toHaveBeenCalledTimes(1);
    expect(state.spawnShipperGroomMock).toHaveBeenCalledWith(42, 'owner/repo', 120, 30);
    expect(state.terminalState.openRunningSession).not.toHaveBeenCalled();

    await act(async () => {
      resolveGroom?.({ sessionId: 'pty-groom-42' });
      await groomPromise;
    });

    expect(state.terminalState.openRunningSession).toHaveBeenCalledWith(
      'pty-groom-42',
      'groom — #42',
      { repo: 'owner/repo', issueNumber: 42 }
    );
    expect(issue42Button).toHaveProperty('disabled', false);
  });

  it('clears pending Groom feedback after a failed launch and keeps the fetch-error path', async () => {
    state.spawnShipperGroomMock.mockRejectedValue(new Error('spawn failed'));

    render(<App />);

    const issue42Button = screen.getByRole('button', { name: 'Groom issue 42' });

    await act(async () => {
      fireEvent.click(issue42Button);
      await Promise.resolve();
    });

    expect(issue42Button).toHaveProperty('disabled', false);
    expect(state.pipelineState.setFetchError).toHaveBeenCalledWith(
      'Failed to launch shipper groom: spawn failed'
    );
  });

  it('focuses an existing Groom session without showing pending feedback or spawning', () => {
    vi.mocked(
      state.terminalState.focusExistingGroomSession as (issueNumber: number) => boolean
    ).mockReturnValue(true);

    render(<App />);

    const issue42Button = screen.getByRole('button', { name: 'Groom issue 42' });
    fireEvent.click(issue42Button);

    expect(state.terminalState.focusExistingGroomSession).toHaveBeenCalledWith(42);
    expect(state.spawnShipperGroomMock).not.toHaveBeenCalled();
    expect(issue42Button).toHaveProperty('disabled', false);
  });

  it('does not launch Groom without an active repo', () => {
    state.reposState = {
      ...state.reposState,
      activeRepo: '',
    };

    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Groom issue 42' }));

    expect(state.terminalState.focusExistingGroomSession).not.toHaveBeenCalled();
    expect(state.spawnShipperGroomMock).not.toHaveBeenCalled();
  });

  it('scopes pending Groom feedback by repo and opens sessions with the launch repo', async () => {
    let resolveRepoAGroom: ((value: { sessionId: string }) => void) | undefined;
    const repoAGroomPromise = new Promise<{ sessionId: string }>((resolve) => {
      resolveRepoAGroom = resolve;
    });
    state.spawnShipperGroomMock
      .mockReturnValueOnce(repoAGroomPromise)
      .mockReturnValueOnce(new Promise(() => {}));

    const { rerender } = render(<App />);

    const repoAIssue42Button = screen.getByRole('button', { name: 'Groom issue 42' });
    fireEvent.click(repoAIssue42Button);

    expect(repoAIssue42Button).toHaveProperty('disabled', true);
    expect(state.spawnShipperGroomMock).toHaveBeenCalledWith(42, 'owner/repo', 120, 30);

    state.reposState = {
      ...state.reposState,
      activeRepo: 'owner/repo-b',
      repos: ['owner/repo', 'owner/repo-b'],
    };

    rerender(<App />);

    const repoBIssue42Button = screen.getByRole('button', { name: 'Groom issue 42' });
    expect(repoBIssue42Button).toHaveProperty('disabled', false);

    fireEvent.click(repoBIssue42Button);

    expect(state.spawnShipperGroomMock).toHaveBeenCalledTimes(2);
    expect(state.spawnShipperGroomMock).toHaveBeenLastCalledWith(42, 'owner/repo-b', 120, 30);

    await act(async () => {
      resolveRepoAGroom?.({ sessionId: 'pty-groom-repo-a-42' });
      await repoAGroomPromise;
    });

    expect(state.terminalState.openRunningSession).toHaveBeenCalledWith(
      'pty-groom-repo-a-42',
      'groom — #42',
      { repo: 'owner/repo', issueNumber: 42 }
    );
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

    expect(setupButton).toHaveProperty('disabled', true);

    fireEvent.click(setupButton);

    expect(state.terminalState.focusExistingSetupSession).toHaveBeenCalledTimes(1);
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
    expect(setupButton).toHaveProperty('disabled', false);
  });

  it('clears pending Setup feedback after a failed launch and keeps the fetch-error path', async () => {
    state.spawnShipperSetupMock
      .mockRejectedValueOnce(new Error('clone failed'))
      .mockResolvedValueOnce({ sessionId: 'pty-setup-43' });

    render(<App />);

    const setupButton = screen.getByRole('button', { name: 'Setup' });

    await act(async () => {
      fireEvent.click(setupButton);
      await Promise.resolve();
    });

    expect(setupButton).toHaveProperty('disabled', false);
    expect(state.pipelineState.setFetchError).toHaveBeenCalledWith(
      'Failed to launch shipper setup: clone failed'
    );

    await act(async () => {
      fireEvent.click(setupButton);
      await Promise.resolve();
    });

    expect(state.spawnShipperSetupMock).toHaveBeenCalledTimes(2);
  });

  it('focuses an existing Setup session without showing pending feedback or spawning', () => {
    vi.mocked(
      state.terminalState.focusExistingSetupSession as (repo: string) => boolean
    ).mockReturnValue(true);

    render(<App />);

    const setupButton = screen.getByRole('button', { name: 'Setup' });
    fireEvent.click(setupButton);

    expect(state.terminalState.focusExistingSetupSession).toHaveBeenCalledWith('owner/repo');
    expect(state.spawnShipperSetupMock).not.toHaveBeenCalled();
    expect(setupButton).toHaveProperty('disabled', false);
  });

  it('scopes pending Setup feedback by repo when the active repo changes', () => {
    state.spawnShipperSetupMock.mockReturnValue(new Promise(() => {}));

    const { rerender } = render(<App />);

    const repoASetupButton = screen.getByRole('button', { name: 'Setup' });
    fireEvent.click(repoASetupButton);

    expect(repoASetupButton).toHaveProperty('disabled', true);
    expect(state.spawnShipperSetupMock).toHaveBeenCalledWith('owner/repo', 120, 30);

    state.reposState = {
      ...state.reposState,
      activeRepo: 'owner/repo-b',
      repos: ['owner/repo', 'owner/repo-b'],
    };

    rerender(<App />);

    const repoBSetupButton = screen.getByRole('button', { name: 'Setup' });
    expect(repoBSetupButton).toHaveProperty('disabled', false);

    fireEvent.click(repoBSetupButton);

    expect(state.spawnShipperSetupMock).toHaveBeenCalledTimes(2);
    expect(state.spawnShipperSetupMock).toHaveBeenLastCalledWith('owner/repo-b', 120, 30);
  });

  it('shows pending Ship feedback until the launched background command is visible', async () => {
    let resolveShip: ((value: { sessionId: string }) => void) | undefined;
    const shipPromise = new Promise<{ sessionId: string }>((resolve) => {
      resolveShip = resolve;
    });
    state.spawnBackgroundShipMock.mockReturnValue(shipPromise);

    const { rerender } = render(<App />);

    const issue42Button = screen.getByRole('button', { name: 'Ship issue 42' });
    const issue43Button = screen.getByRole('button', { name: 'Ship issue 43' });

    fireEvent.click(issue42Button);

    expect(issue42Button).toHaveProperty('disabled', true);
    expect(issue43Button).toHaveProperty('disabled', false);

    fireEvent.click(issue42Button);

    expect(state.spawnBackgroundShipMock).toHaveBeenCalledTimes(1);
    expect(state.spawnBackgroundShipMock).toHaveBeenCalledWith(42, 'owner/repo', false);

    await act(async () => {
      resolveShip?.({ sessionId: 'bg-ship-42' });
      await shipPromise;
    });

    expect(screen.getByRole('button', { name: 'Ship issue 42' })).toHaveProperty('disabled', true);

    state.backgroundState = {
      ...state.backgroundState,
      backgroundCommands: [createBackgroundShipCommand()],
    };

    await act(async () => {
      rerender(<App />);
      await Promise.resolve();
    });

    expect(screen.getByRole('button', { name: 'Ship issue 42' })).toHaveProperty('disabled', false);
  });

  it('passes stateChangedAt into action queue commands for all background command kinds', () => {
    const stateChangedAtById = new Map([
      ['bg-new', Date.parse('2026-04-03T12:00:00.000Z')],
      ['bg-ship', Date.parse('2026-04-03T12:01:00.000Z')],
      ['bg-init', Date.parse('2026-04-03T12:02:00.000Z')],
      ['bg-unblock', Date.parse('2026-04-03T12:03:00.000Z')],
    ]);
    state.backgroundState = {
      ...state.backgroundState,
      backgroundCommands: [
        createBackgroundShipCommand({
          id: 'bg-new',
          command: 'new',
          title: 'New issue',
          issueNumber: undefined,
          stateChangedAt: stateChangedAtById.get('bg-new'),
        }),
        createBackgroundShipCommand({
          id: 'bg-ship',
          command: 'ship',
          title: 'Ship #42',
          stateChangedAt: stateChangedAtById.get('bg-ship'),
        }),
        createBackgroundShipCommand({
          id: 'bg-init',
          command: 'init',
          title: 'Init repo',
          issueNumber: undefined,
          stateChangedAt: stateChangedAtById.get('bg-init'),
        }),
        createBackgroundShipCommand({
          id: 'bg-unblock',
          command: 'unblock',
          title: 'Unblock #43',
          issueNumber: 43,
          stateChangedAt: stateChangedAtById.get('bg-unblock'),
        }),
      ],
    };

    render(<App />);

    const commands = state.actionQueueDrawerProps?.commands as
      | Array<{ id: string; command: string; stateChangedAt: number }>
      | undefined;
    expect(commands).toHaveLength(4);
    expect(commands?.map((command) => command.command)).toEqual(['new', 'ship', 'init', 'unblock']);
    for (const command of commands ?? []) {
      expect(command.stateChangedAt).toBe(stateChangedAtById.get(command.id));
    }
  });

  it('does not clear pending Ship feedback for stale commands from the same issue', async () => {
    state.backgroundState = {
      ...state.backgroundState,
      backgroundCommands: [
        createBackgroundShipCommand({
          id: 'old-bg-ship-42',
          status: 'complete',
        }),
      ],
    };
    state.spawnBackgroundShipMock.mockResolvedValue({ sessionId: 'new-bg-ship-42' });

    const { rerender } = render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Ship issue 42' }));

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByRole('button', { name: 'Ship issue 42' })).toHaveProperty('disabled', true);

    state.backgroundState = {
      ...state.backgroundState,
      backgroundCommands: [
        createBackgroundShipCommand({
          id: 'new-bg-ship-42',
        }),
      ],
    };

    await act(async () => {
      rerender(<App />);
      await Promise.resolve();
    });

    expect(screen.getByRole('button', { name: 'Ship issue 42' })).toHaveProperty('disabled', false);
  });

  it('clears pending Ship feedback after a failed launch and keeps the fetch-error path', async () => {
    state.spawnBackgroundShipMock.mockRejectedValue(new Error('spawn failed'));

    render(<App />);

    const issue42Button = screen.getByRole('button', { name: 'Ship issue 42' });

    await act(async () => {
      fireEvent.click(issue42Button);
      await Promise.resolve();
    });

    expect(issue42Button).toHaveProperty('disabled', false);
    expect(state.pipelineState.setFetchError).toHaveBeenCalledWith(
      'Failed to launch shipper ship: spawn failed'
    );
  });

  it('prompts before shipping a paused issue and shows pending feedback only after confirm', async () => {
    state.pipelineState.pausedIssues = new Set<number>([42]);
    state.spawnBackgroundShipMock.mockReturnValue(new Promise(() => {}));

    render(<App />);

    const issue42Button = screen.getByRole('button', { name: 'Ship issue 42' });
    fireEvent.click(issue42Button);

    expect(screen.getByText('This issue is paused. Resume and ship anyway?')).toBeTruthy();
    expect(state.spawnBackgroundShipMock).not.toHaveBeenCalled();
    expect(issue42Button).toHaveProperty('disabled', false);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Resume and ship' }));
      await Promise.resolve();
    });

    expect(state.backgroundState.handleResumeIssue).toHaveBeenCalledWith(42, 'owner/repo');
    expect(state.spawnBackgroundShipMock).toHaveBeenCalledWith(42, 'owner/repo', false);
    expect(screen.getByRole('button', { name: 'Ship issue 42' })).toHaveProperty('disabled', true);
  });

  it('leaves a paused issue untouched when the resume-and-ship dialog is cancelled', () => {
    state.pipelineState.pausedIssues = new Set<number>([42]);

    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Ship issue 42' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(state.backgroundState.handleResumeIssue).not.toHaveBeenCalled();
    expect(state.spawnBackgroundShipMock).not.toHaveBeenCalled();
    expect(screen.queryByText('This issue is paused. Resume and ship anyway?')).toBeNull();
  });

  it('clears auto-ship state before requesting an auto-ship halt when toggled off', async () => {
    state.backgroundState.autoShipRepos = new Set<string>(['owner/repo']);
    const callOrder: string[] = [];
    state.backgroundState.clearAutoShipStateForRepo = vi.fn(() => {
      callOrder.push('clear');
    });
    state.requestAutoShipHaltMock.mockImplementation(() => {
      callOrder.push('halt');
      return Promise.resolve(1);
    });

    render(<App />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Toggle auto-ship' }));
      await Promise.resolve();
    });

    expect(state.backgroundState.clearAutoShipStateForRepo).toHaveBeenCalledWith('owner/repo');
    expect(state.requestAutoShipHaltMock).toHaveBeenCalledWith('owner/repo');
    expect(callOrder).toEqual(['clear', 'halt']);
  });
});
