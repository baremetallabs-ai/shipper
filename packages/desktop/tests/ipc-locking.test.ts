import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type IpcHandler = (event: unknown, payload: unknown) => unknown;

const state = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  exitCallbacks: new Map<string, () => void>(),
  acquireIssueLockMock: vi.fn<(repo: string, issueNumber: string) => Promise<void>>(),
  releaseIssueLockMock: vi.fn<(repo: string, issueNumber: string) => Promise<void>>(),
  renewIssueLockMock:
    vi.fn<(repo: string, issueNumber: string, cancelled: { value: boolean }) => Promise<void>>(),
  buildPromptCommandMock: vi.fn(),
  checkGhAuthMock: vi.fn(),
  checkGhInstalledMock: vi.fn(),
  checkLabelsMock: vi.fn(),
  ensureRepoCloneMock: vi.fn(),
  executeResetMock: vi.fn(),
  getSettingsMock: vi.fn(),
  ghMock: vi.fn(),
  isLockStaleMock: vi.fn(),
  listIssuesMock: vi.fn(),
  scanArtifactsMock: vi.fn(),
  ptySetWindowMock: vi.fn(),
  ptySpawnMock: vi.fn(),
  ptyOnSessionExitMock: vi.fn(),
  ptyWriteMock: vi.fn(),
  ptyResizeMock: vi.fn(),
  ptyKillMock: vi.fn(),
  ptyDestroyAllMock: vi.fn(),
  appWhenReadyMock: vi.fn(),
  appOnMock: vi.fn(),
  appQuitMock: vi.fn(),
  appGetPathMock: vi.fn(),
  browserWindowOnMock: vi.fn(),
  browserWindowOnceMock: vi.fn(),
  browserWindowShowMock: vi.fn(),
  browserWindowLoadUrlMock: vi.fn(),
  browserWindowLoadFileMock: vi.fn(),
  browserWindowGetAllWindowsMock: vi.fn(),
  webContentsSendMock: vi.fn(),
  ipcHandleMock: vi.fn(),
}));

vi.mock('@dnsquared/shipper-core', () => {
  const stages = ['new', 'groomed', 'designed', 'planned', 'implemented'] as const;

  function normalizeStage(input: string): string {
    return input.replace(/^shipper:/, '');
  }

  function getStageLabel(stage: string): string {
    return `shipper:${stage}`;
  }

  function getStageIndex(stage: string): number {
    return stages.indexOf(normalizeStage(stage) as (typeof stages)[number]);
  }

  function parseStage(input: string): string | null {
    const normalized = normalizeStage(input);
    return stages.includes(normalized as (typeof stages)[number]) ? normalized : null;
  }

  function getCurrentStage(labels: string[]): { stage: string; hasPrLabels: boolean } {
    for (let index = stages.length - 1; index >= 0; index -= 1) {
      const stage = stages[index];
      if (stage !== undefined && labels.includes(getStageLabel(stage))) {
        return { stage, hasPrLabels: false };
      }
    }

    return { stage: 'new', hasPrLabels: false };
  }

  function getValidTargets(currentStage: { stage: string; hasPrLabels: boolean }): string[] {
    const currentIndex = getStageIndex(currentStage.stage);
    return currentIndex <= 0 ? [] : stages.slice(0, currentIndex);
  }

  return {
    acquireIssueLock: state.acquireIssueLockMock,
    buildPromptCommand: state.buildPromptCommandMock,
    checkGhAuth: state.checkGhAuthMock,
    checkGhInstalled: state.checkGhInstalledMock,
    checkLabels: state.checkLabelsMock,
    ensureRepoClone: state.ensureRepoCloneMock,
    executeReset: state.executeResetMock,
    getCurrentStage,
    getSettings: state.getSettingsMock,
    getStageIndex,
    getStageLabel,
    getValidTargets,
    gh: state.ghMock,
    isLockStale: state.isLockStaleMock,
    listIssues: state.listIssuesMock,
    LOCKED_LABEL: 'shipper:locked',
    parseStage,
    releaseIssueLock: state.releaseIssueLockMock,
    renewIssueLock: state.renewIssueLockMock,
    scanArtifacts: state.scanArtifactsMock,
  };
});

vi.mock('electron', () => {
  class MockBrowserWindow {
    static getAllWindows = state.browserWindowGetAllWindowsMock;

    webContents = {
      send: state.webContentsSendMock,
    };

    on = state.browserWindowOnMock;
    once = state.browserWindowOnceMock;
    show = state.browserWindowShowMock;
    loadURL = state.browserWindowLoadUrlMock;
    loadFile = state.browserWindowLoadFileMock;
  }

  return {
    app: {
      whenReady: state.appWhenReadyMock,
      on: state.appOnMock,
      quit: state.appQuitMock,
      getPath: state.appGetPathMock,
    },
    BrowserWindow: MockBrowserWindow,
    ipcMain: {
      handle: state.ipcHandleMock,
    },
  };
});

vi.mock('../src/main/pty-manager.js', () => ({
  PtyManager: class MockPtyManager {
    setWindow = state.ptySetWindowMock;
    spawn = state.ptySpawnMock;
    onSessionExit = (id: string, callback: () => void) => {
      state.ptyOnSessionExitMock(id, callback);
      state.exitCallbacks.set(id, callback);
    };
    write = state.ptyWriteMock;
    resize = state.ptyResizeMock;
    kill = state.ptyKillMock;
    destroyAll = state.ptyDestroyAllMock;
  },
}));

function queueResetIssue(labels: string[] = ['shipper:planned']): void {
  state.ghMock.mockResolvedValueOnce({
    stdout: JSON.stringify({
      number: 42,
      state: 'OPEN',
      labels: labels.map((name) => ({ name })),
    }),
    stderr: '',
  });
}

async function loadHandlers(): Promise<Map<string, IpcHandler>> {
  vi.resetModules();
  state.handlers.clear();
  state.exitCallbacks.clear();

  state.ipcHandleMock.mockImplementation((channel: string, handler: IpcHandler) => {
    state.handlers.set(channel, handler);
  });
  state.appWhenReadyMock.mockResolvedValue(undefined);
  state.appGetPathMock.mockReturnValue('/tmp/shipper-desktop-tests');
  state.browserWindowGetAllWindowsMock.mockReturnValue([]);
  state.browserWindowLoadUrlMock.mockResolvedValue(undefined);
  state.browserWindowLoadFileMock.mockResolvedValue(undefined);
  state.getSettingsMock.mockReturnValue({ lockTimeoutMinutes: 30 });
  state.acquireIssueLockMock.mockResolvedValue(undefined);
  state.releaseIssueLockMock.mockResolvedValue(undefined);
  state.renewIssueLockMock.mockResolvedValue(undefined);
  state.ensureRepoCloneMock.mockResolvedValue('/tmp/repo');
  state.buildPromptCommandMock.mockResolvedValue({
    command: 'codex',
    args: ['groom', '42'],
    cwd: '/tmp/repo',
  });
  state.scanArtifactsMock.mockResolvedValue({
    targetStage: 'groomed',
    targetLabel: 'shipper:groomed',
    labelsToRemove: [],
    addTarget: false,
    prs: [],
    branchesToDelete: [],
    localBranches: [],
    localWorktrees: [],
    commentIds: [],
  });
  state.executeResetMock.mockResolvedValue(undefined);
  state.isLockStaleMock.mockResolvedValue(false);
  state.checkGhAuthMock.mockResolvedValue({ ok: true, message: '' });
  state.checkGhInstalledMock.mockResolvedValue({ ok: true, message: '' });
  state.checkLabelsMock.mockResolvedValue({ ok: true, message: '' });
  state.listIssuesMock.mockResolvedValue([]);

  await import('../src/main/index.ts');
  await Promise.resolve();

  return state.handlers;
}

function getHandler(name: string): IpcHandler {
  const handler = state.handlers.get(name);
  if (!handler) {
    throw new Error(`Missing IPC handler: ${name}`);
  }

  return handler;
}

function parseSessionResult(result: unknown): { sessionId: string } {
  if (
    typeof result !== 'object' ||
    result === null ||
    !('sessionId' in result) ||
    typeof result.sessionId !== 'string'
  ) {
    throw new Error('Expected a session result.');
  }

  return { sessionId: result.sessionId };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  state.handlers.clear();
  state.exitCallbacks.clear();
});

describe('desktop IPC locking', () => {
  it('acquires the issue lock before spawning a groom PTY', async () => {
    await loadHandlers();
    const handler = getHandler('pty-spawn-shipper-groom');

    const result = parseSessionResult(
      await handler(
        {},
        {
          repo: 'owner/repo',
          issueNumber: 42,
          cols: 120,
          rows: 40,
        }
      )
    );

    expect(result.sessionId).toEqual(expect.any(String));
    expect(state.acquireIssueLockMock).toHaveBeenCalledWith('owner/repo', '42');
    expect(state.ptySpawnMock).toHaveBeenCalledWith(
      expect.any(String),
      'codex',
      ['groom', '42'],
      expect.objectContaining({
        cols: 120,
        rows: 40,
        cwd: '/tmp/repo',
      })
    );
    expect(state.acquireIssueLockMock.mock.invocationCallOrder[0]).toBeLessThan(
      state.ptySpawnMock.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
    );

    const sessionId: unknown = state.ptySpawnMock.mock.calls[0]?.[0];
    if (typeof sessionId !== 'string') {
      throw new Error('Expected groom spawn session ID.');
    }
    state.exitCallbacks.get(sessionId)?.();
  });

  it('releases the groom lock when the PTY session exits', async () => {
    await loadHandlers();
    const handler = getHandler('pty-spawn-shipper-groom');

    const result = parseSessionResult(
      await handler(
        {},
        {
          repo: 'owner/repo',
          issueNumber: 42,
          cols: 120,
          rows: 40,
        }
      )
    );

    state.exitCallbacks.get(result.sessionId)?.();

    expect(state.releaseIssueLockMock).toHaveBeenCalledWith('owner/repo', '42');
  });

  it('does not start groom when lock acquisition fails', async () => {
    await loadHandlers();
    const handler = getHandler('pty-spawn-shipper-groom');
    state.acquireIssueLockMock.mockRejectedValueOnce(
      new Error('Issue #42 is locked by another shipper instance.')
    );

    await expect(
      handler({}, { repo: 'owner/repo', issueNumber: 42, cols: 120, rows: 40 })
    ).rejects.toThrow('Issue #42 is locked by another shipper instance.');
    expect(state.ptySpawnMock).not.toHaveBeenCalled();
  });

  it('releases the groom lock when setup fails before PTY spawn', async () => {
    await loadHandlers();
    const handler = getHandler('pty-spawn-shipper-groom');
    state.ensureRepoCloneMock.mockRejectedValueOnce(new Error('clone failed'));

    await expect(
      handler({}, { repo: 'owner/repo', issueNumber: 42, cols: 120, rows: 40 })
    ).rejects.toThrow('clone failed');
    expect(state.ptySpawnMock).not.toHaveBeenCalled();
    expect(state.releaseIssueLockMock).toHaveBeenCalledWith('owner/repo', '42');
  });

  it('releases the groom lock and stops the heartbeat when PTY spawn fails', async () => {
    vi.useFakeTimers();
    await loadHandlers();
    const handler = getHandler('pty-spawn-shipper-groom');
    state.ptySpawnMock.mockImplementationOnce(() => {
      throw new Error('spawn failed');
    });

    await expect(
      handler({}, { repo: 'owner/repo', issueNumber: 42, cols: 120, rows: 40 })
    ).rejects.toThrow('spawn failed');
    expect(state.releaseIssueLockMock).toHaveBeenCalledWith('owner/repo', '42');

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(state.renewIssueLockMock).not.toHaveBeenCalled();
  });

  it('renews the groom lock heartbeat until the PTY exits', async () => {
    vi.useFakeTimers();
    await loadHandlers();
    const handler = getHandler('pty-spawn-shipper-groom');

    const result = parseSessionResult(
      await handler(
        {},
        {
          repo: 'owner/repo',
          issueNumber: 42,
          cols: 120,
          rows: 40,
        }
      )
    );

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(state.renewIssueLockMock).toHaveBeenCalledWith(
      'owner/repo',
      '42',
      expect.objectContaining({ value: false })
    );

    const cancelled = state.renewIssueLockMock.mock.calls[0]?.[2];
    if (!cancelled) {
      throw new Error('Expected heartbeat cancelled flag.');
    }

    state.exitCallbacks.get(result.sessionId)?.();
    expect(cancelled.value).toBe(true);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(state.renewIssueLockMock).toHaveBeenCalledTimes(1);
  });

  it('acquires the issue lock before executing a reset', async () => {
    await loadHandlers();
    queueResetIssue();
    const handler = getHandler('execute-reset');

    const result = await handler(
      {},
      {
        repo: 'owner/repo',
        issueNumber: 42,
        targetStage: 'groomed',
      }
    );

    expect(result).toEqual({ ok: true });
    expect(state.acquireIssueLockMock).toHaveBeenCalledWith('owner/repo', '42');
    expect(state.executeResetMock).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ targetStage: 'groomed' }),
      'owner/repo'
    );
    expect(state.acquireIssueLockMock.mock.invocationCallOrder[0]).toBeLessThan(
      state.executeResetMock.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
    );
    expect(state.releaseIssueLockMock).toHaveBeenCalledWith('owner/repo', '42');
  });

  it('releases the reset lock when executeReset fails', async () => {
    await loadHandlers();
    queueResetIssue();
    state.executeResetMock.mockRejectedValueOnce(new Error('reset failed'));
    const handler = getHandler('execute-reset');

    await expect(
      handler({}, { repo: 'owner/repo', issueNumber: 42, targetStage: 'groomed' })
    ).resolves.toEqual({ ok: false, error: 'reset failed' });
    expect(state.releaseIssueLockMock).toHaveBeenCalledWith('owner/repo', '42');
  });

  it('surfaces reset lock acquisition failure as an inline error response', async () => {
    await loadHandlers();
    queueResetIssue();
    state.acquireIssueLockMock.mockRejectedValueOnce(
      new Error('Issue #42 is locked by another shipper instance.')
    );
    const handler = getHandler('execute-reset');

    await expect(
      handler({}, { repo: 'owner/repo', issueNumber: 42, targetStage: 'groomed' })
    ).resolves.toEqual({
      ok: false,
      error: 'Issue #42 is locked by another shipper instance.',
    });
    expect(state.executeResetMock).not.toHaveBeenCalled();
  });
});
