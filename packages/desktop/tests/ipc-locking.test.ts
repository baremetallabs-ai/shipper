import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type IpcHandler = (event: unknown, payload: unknown) => unknown;
const mockUserDataPath = '/tmp/shipper-desktop-tests';

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
  backgroundSetWindowMock: vi.fn(),
  backgroundSpawnMock: vi.fn<(options: Record<string, unknown>) => void>(),
  backgroundKillMock: vi.fn<(sessionId: string) => void>(),
  backgroundGetOutputMock: vi.fn<(sessionId: string) => Promise<string> | string>(),
  backgroundDestroyAllMock: vi.fn(),
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
  browserWindowEventHandlers: new Map<string, (...args: unknown[]) => void>(),
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

vi.mock('../src/main/background-manager.js', () => ({
  BackgroundManager: class MockBackgroundManager {
    setWindow = state.backgroundSetWindowMock;
    spawn = (options: unknown) => {
      state.backgroundSpawnMock(options);
      if (
        typeof options === 'object' &&
        options !== null &&
        'sessionId' in options &&
        typeof options.sessionId === 'string'
      ) {
        return { sessionId: options.sessionId };
      }

      return { sessionId: 'background-session' };
    };
    kill = state.backgroundKillMock;
    getOutput = state.backgroundGetOutputMock;
    destroyAll = state.backgroundDestroyAllMock;
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
  state.browserWindowEventHandlers.clear();

  state.ipcHandleMock.mockImplementation((channel: string, handler: IpcHandler) => {
    state.handlers.set(channel, handler);
  });
  state.appWhenReadyMock.mockResolvedValue(undefined);
  state.appGetPathMock.mockImplementation(() => mockUserDataPath);
  state.browserWindowGetAllWindowsMock.mockReturnValue([]);
  state.browserWindowLoadUrlMock.mockResolvedValue(undefined);
  state.browserWindowLoadFileMock.mockResolvedValue(undefined);
  state.browserWindowOnMock.mockImplementation(
    (event: string, handler: (...args: unknown[]) => void) => {
      state.browserWindowEventHandlers.set(event, handler);
    }
  );
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
  state.backgroundSpawnMock.mockReset();
  state.backgroundKillMock.mockReset();
  state.backgroundGetOutputMock.mockResolvedValue('');
  state.backgroundDestroyAllMock.mockReset();

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

function parseBackgroundSpawnCall(index = 0): Record<string, unknown> {
  const call = state.backgroundSpawnMock.mock.calls[index]?.[0];
  if (call === undefined) {
    throw new Error(`Expected background spawn call at index ${index}.`);
  }

  return call;
}

beforeEach(() => {
  vi.clearAllMocks();
  rmSync(mockUserDataPath, { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
  state.handlers.clear();
  state.exitCallbacks.clear();
  state.browserWindowEventHandlers.clear();
  rmSync(mockUserDataPath, { recursive: true, force: true });
});

describe('desktop IPC locking', () => {
  it('spawns `new` in headless mode with a deterministic log file and no PTY', async () => {
    await loadHandlers();
    const handler = getHandler('bg-spawn-new');

    const result = parseSessionResult(
      await handler({}, { repo: 'owner/repo', request: 'draft issue' })
    );
    const spawnCall = parseBackgroundSpawnCall();
    const args = spawnCall.args;
    const meta = spawnCall.meta;

    if (!Array.isArray(args) || args.length !== 6) {
      throw new Error('Expected background new args.');
    }
    if (typeof args[5] !== 'string') {
      throw new Error('Expected deterministic log file path.');
    }
    if (typeof meta !== 'object' || meta === null || typeof meta.logFile !== 'string') {
      throw new Error('Expected background new metadata.');
    }

    expect(result.sessionId).toEqual(expect.any(String));
    expect(state.ensureRepoCloneMock).toHaveBeenCalledWith('owner/repo');
    expect(spawnCall.sessionId).toBe(result.sessionId);
    expect(spawnCall.command).toBe('new');
    expect(spawnCall.repo).toBe('owner/repo');
    expect(spawnCall.commandName).toBe('shipper');
    expect(spawnCall.cwd).toBe('/tmp/repo');
    expect(args.slice(0, 5)).toEqual(['new', 'draft issue', '--mode', 'headless', '--log-file']);
    expect(args[5]).toContain('/.shipper/sessions/owner-repo/desktop-');
    expect(meta.request).toBe('draft issue');
    expect(meta.logFile).toContain('/.shipper/sessions/owner-repo/desktop-');
    expect(typeof spawnCall.onComplete).toBe('function');
    expect(state.ptySpawnMock).not.toHaveBeenCalled();
  });

  it('spawns `ship` through the background manager with `--merge` when requested', async () => {
    await loadHandlers();
    const handler = getHandler('bg-spawn-ship');

    const result = parseSessionResult(
      await handler({}, { repo: 'owner/repo', issueNumber: 42, merge: true })
    );
    const spawnCall = parseBackgroundSpawnCall();

    expect(result.sessionId).toEqual(expect.any(String));
    expect(spawnCall.sessionId).toBe(result.sessionId);
    expect(spawnCall.command).toBe('ship');
    expect(spawnCall.repo).toBe('owner/repo');
    expect(spawnCall.commandName).toBe('shipper');
    expect(spawnCall.cwd).toBe('/tmp/repo');
    expect(spawnCall.args).toEqual(['ship', '42', '--mode', 'headless', '--merge']);
    expect(spawnCall.meta).toEqual({ issueNumber: 42, merge: true });
    expect(state.ptySpawnMock).not.toHaveBeenCalled();
  });

  it('spawns `ship` without `--merge` when the payload omits merge', async () => {
    await loadHandlers();
    const handler = getHandler('bg-spawn-ship');

    const result = parseSessionResult(await handler({}, { repo: 'owner/repo', issueNumber: 42 }));
    const spawnCall = parseBackgroundSpawnCall();

    expect(result.sessionId).toEqual(expect.any(String));
    expect(spawnCall.sessionId).toBe(result.sessionId);
    expect(spawnCall.command).toBe('ship');
    expect(spawnCall.repo).toBe('owner/repo');
    expect(spawnCall.commandName).toBe('shipper');
    expect(spawnCall.cwd).toBe('/tmp/repo');
    expect(spawnCall.args).toEqual(['ship', '42', '--mode', 'headless']);
    expect(spawnCall.meta).toEqual({ issueNumber: 42, merge: false });
    expect(state.ptySpawnMock).not.toHaveBeenCalled();
  });

  it('defaults missing auto-merge repos to an empty array on get-config', async () => {
    await loadHandlers();
    mkdirSync(mockUserDataPath, { recursive: true });
    writeFileSync(
      join(mockUserDataPath, 'config.json'),
      JSON.stringify({
        repos: ['owner/repo'],
        activeRepo: 'owner/repo',
      }),
      'utf8'
    );

    const handler = getHandler('get-config');
    const result = await handler({}, undefined);
    const savedConfig: unknown = JSON.parse(
      readFileSync(join(mockUserDataPath, 'config.json'), 'utf8')
    );

    expect(result).toEqual({
      repos: ['owner/repo'],
      activeRepo: 'owner/repo',
      autoMergeRepos: [],
    });
    expect(savedConfig).toEqual(result);
  });

  it('normalizes auto-merge repos on get-config and writes corrections back to disk', async () => {
    await loadHandlers();
    mkdirSync(mockUserDataPath, { recursive: true });
    writeFileSync(
      join(mockUserDataPath, 'config.json'),
      JSON.stringify({
        repos: ['owner/repo', 'owner/other'],
        activeRepo: 'owner/repo',
        autoMergeRepos: ['owner/repo', ' owner/repo ', 'OWNER/OTHER', 'owner/missing', 42],
      }),
      'utf8'
    );

    const handler = getHandler('get-config');
    const result = await handler({}, undefined);
    const savedConfig: unknown = JSON.parse(
      readFileSync(join(mockUserDataPath, 'config.json'), 'utf8')
    );

    expect(result).toEqual({
      repos: ['owner/repo', 'owner/other'],
      activeRepo: 'owner/repo',
      autoMergeRepos: ['owner/repo', 'owner/other'],
    });
    expect(savedConfig).toEqual(result);
  });

  it('persists auto-merge repos through set-config', async () => {
    await loadHandlers();
    const handler = getHandler('set-config');

    await handler(
      {},
      {
        repos: ['owner/repo'],
        activeRepo: 'owner/repo',
        autoMergeRepos: ['owner/repo'],
      }
    );

    const savedConfig: unknown = JSON.parse(
      readFileSync(join(mockUserDataPath, 'config.json'), 'utf8')
    );
    expect(savedConfig).toEqual({
      repos: ['owner/repo'],
      activeRepo: 'owner/repo',
      autoMergeRepos: ['owner/repo'],
    });
  });

  it('prefers settings.local.json over settings.json when resolving the init agent', async () => {
    await loadHandlers();
    const repoPath = mkdtempSync(join(tmpdir(), 'shipper-desktop-init-'));
    mkdirSync(join(repoPath, '.shipper'), { recursive: true });
    writeFileSync(
      join(repoPath, '.shipper', 'settings.json'),
      JSON.stringify({ commands: { default: { agent: 'claude' } } }),
      'utf8'
    );
    writeFileSync(
      join(repoPath, '.shipper', 'settings.local.json'),
      JSON.stringify({ commands: { default: { agent: 'codex' } } }),
      'utf8'
    );
    state.ensureRepoCloneMock.mockResolvedValueOnce(repoPath);
    const handler = getHandler('bg-spawn-init');

    const result = parseSessionResult(await handler({}, { repo: 'owner/repo' }));
    const spawnCall = parseBackgroundSpawnCall();

    expect(spawnCall.sessionId).toBe(result.sessionId);
    expect(spawnCall.command).toBe('init');
    expect(spawnCall.args).toEqual(['init', '--agent', 'codex']);
    expect(spawnCall.cwd).toBe(repoPath);

    rmSync(repoPath, { recursive: true, force: true });
  });

  it('falls back to legacy settings keys and then to claude for init', async () => {
    await loadHandlers();
    const repoPath = mkdtempSync(join(tmpdir(), 'shipper-desktop-init-'));
    mkdirSync(join(repoPath, '.shipper'), { recursive: true });
    writeFileSync(
      join(repoPath, '.shipper', 'settings.json'),
      JSON.stringify({ agents: { default: 'codex' } }),
      'utf8'
    );
    state.ensureRepoCloneMock.mockResolvedValueOnce(repoPath);
    const initHandler = getHandler('bg-spawn-init');

    await initHandler({}, { repo: 'owner/repo' });
    const legacySpawnCall = parseBackgroundSpawnCall();

    expect(legacySpawnCall.command).toBe('init');
    expect(legacySpawnCall.args).toEqual(['init', '--agent', 'codex']);

    const emptyRepoPath = mkdtempSync(join(tmpdir(), 'shipper-desktop-init-empty-'));
    state.ensureRepoCloneMock.mockResolvedValueOnce(emptyRepoPath);
    await initHandler({}, { repo: 'owner/repo' });
    const defaultSpawnCall = parseBackgroundSpawnCall(1);

    expect(defaultSpawnCall.command).toBe('init');
    expect(defaultSpawnCall.args).toEqual(['init', '--agent', 'claude']);

    rmSync(repoPath, { recursive: true, force: true });
    rmSync(emptyRepoPath, { recursive: true, force: true });
  });

  it('destroys both the PTY and background managers when the window closes', async () => {
    await loadHandlers();

    state.browserWindowEventHandlers.get('close')?.();

    expect(state.ptyDestroyAllMock).toHaveBeenCalledTimes(1);
    expect(state.backgroundDestroyAllMock).toHaveBeenCalledTimes(1);
  });

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

  it('reports when an issue lock is stale', async () => {
    await loadHandlers();
    state.isLockStaleMock.mockResolvedValueOnce(true);
    const handler = getHandler('check-lock-stale');

    await expect(handler({}, { repo: 'owner/repo', issueNumber: 42 })).resolves.toEqual({
      stale: true,
    });
    expect(state.isLockStaleMock).toHaveBeenCalledWith('owner/repo', '42');
  });

  it('reports when an issue lock is not stale', async () => {
    await loadHandlers();
    state.isLockStaleMock.mockResolvedValueOnce(false);
    const handler = getHandler('check-lock-stale');

    await expect(handler({}, { repo: 'owner/repo', issueNumber: 42 })).resolves.toEqual({
      stale: false,
    });
    expect(state.isLockStaleMock).toHaveBeenCalledWith('owner/repo', '42');
  });

  it('fails closed for stale-lock checks with invalid payloads', async () => {
    await loadHandlers();
    const handler = getHandler('check-lock-stale');

    await expect(handler({}, { repo: 'owner/repo', issueNumber: 0 })).resolves.toEqual({
      stale: false,
    });
    expect(state.isLockStaleMock).not.toHaveBeenCalled();
  });

  it('fails closed for stale-lock checks when isLockStale throws', async () => {
    await loadHandlers();
    state.isLockStaleMock.mockRejectedValueOnce(new Error('lock lookup failed'));
    const handler = getHandler('check-lock-stale');

    await expect(handler({}, { repo: 'owner/repo', issueNumber: 42 })).resolves.toEqual({
      stale: false,
    });
    expect(state.isLockStaleMock).toHaveBeenCalledWith('owner/repo', '42');
  });

  it('removes only the locked label when unlocking an issue', async () => {
    await loadHandlers();
    state.ghMock.mockResolvedValueOnce({ stdout: '', stderr: '' });
    const handler = getHandler('unlock-issue');

    await expect(handler({}, { repo: 'owner/repo', issueNumber: 42 })).resolves.toEqual({
      ok: true,
    });
    expect(state.ghMock).toHaveBeenCalledWith([
      'issue',
      'edit',
      '42',
      '-R',
      'owner/repo',
      '--remove-label',
      'shipper:locked',
    ]);
    expect(state.releaseIssueLockMock).not.toHaveBeenCalled();
  });

  it('returns an inline error for unlock requests with invalid payloads', async () => {
    await loadHandlers();
    const handler = getHandler('unlock-issue');

    await expect(handler({}, { repo: 'owner/repo', issueNumber: 0 })).resolves.toEqual({
      ok: false,
      error: 'Enter a repository in owner/repo format and a positive issue number.',
    });
    expect(state.ghMock).not.toHaveBeenCalled();
    expect(state.releaseIssueLockMock).not.toHaveBeenCalled();
  });

  it('surfaces unlock failures without routing through releaseIssueLock', async () => {
    await loadHandlers();
    state.ghMock.mockRejectedValueOnce(new Error('gh failed'));
    const handler = getHandler('unlock-issue');

    await expect(handler({}, { repo: 'owner/repo', issueNumber: 42 })).resolves.toEqual({
      ok: false,
      error: 'gh failed',
    });
    expect(state.releaseIssueLockMock).not.toHaveBeenCalled();
  });

  it('still registers groom on the PTY path with lock acquisition intact', async () => {
    await loadHandlers();

    expect(state.handlers.has('pty-spawn-shipper-groom')).toBe(true);
    expect(state.handlers.has('bg-spawn-new')).toBe(true);
    expect(state.handlers.has('bg-spawn-ship')).toBe(true);
    expect(state.handlers.has('bg-spawn-init')).toBe(true);
  });
});
