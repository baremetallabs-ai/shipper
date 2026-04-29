import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type IpcHandler = (event: unknown, payload: unknown) => unknown;
let mockUserDataPath = '';

const state = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  exitCallbacks: new Map<string, () => void>(),
  acquireIssueLockMock: vi.fn<(repo: string, issueNumber: string) => Promise<void>>(),
  aggregateAllIssueUsageMock: vi.fn(),
  releaseIssueLockMock: vi.fn<(repo: string, issueNumber: string) => Promise<void>>(),
  renewIssueLockMock:
    vi.fn<(repo: string, issueNumber: string, cancelled: { value: boolean }) => Promise<void>>(),
  buildPromptCommandMock: vi.fn(),
  checkGhAuthMock: vi.fn(),
  checkGhInstalledMock: vi.fn(),
  checkLabelsMock: vi.fn(),
  createDesktopGroomWorktreeMock: vi.fn(),
  desktopGroomCleanupMock: vi.fn<() => Promise<void>>(),
  ensureRepoCloneMock: vi.fn(),
  ensureRepoCloneForWorktreeMock: vi.fn(),
  executeResetMock: vi.fn(),
  getSettingsMock: vi.fn(),
  ghMock: vi.fn(),
  isLockStaleMock: vi.fn(),
  listIssuesMock: vi.fn(),
  resolveBaseBranchMock: vi.fn(),
  scanArtifactsMock: vi.fn(),
  backgroundSetWindowMock: vi.fn(),
  backgroundSpawnMock: vi.fn<(options: Record<string, unknown>) => void>(),
  backgroundKillMock: vi.fn<(sessionId: string) => void>(),
  backgroundRequestPauseMock: vi.fn<(sessionId: string) => void>(),
  backgroundRemoveQueuedSessionMock: vi.fn<(sessionId: string) => void>(),
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
  shellOpenExternalMock: vi.fn<(url: string) => Promise<void>>(),
  webContentsSendMock: vi.fn(),
  webContentsOnMock: vi.fn(),
  webContentsGetUrlMock: vi.fn(),
  webContentsSetWindowOpenHandlerMock: vi.fn(),
  ipcHandleMock: vi.fn(),
  browserWindowEventHandlers: new Map<string, (...args: unknown[]) => void>(),
}));

const warnMock = vi.spyOn(console, 'warn').mockImplementation(() => {});

vi.mock('@dnsquared/shipper-core', async () => {
  const { isPlainObject, toError, toErrorMessage } =
    await vi.importActual<typeof import('@dnsquared/shipper-core')>('@dnsquared/shipper-core');
  const stages = ['new', 'groomed', 'designed', 'planned', 'implemented'] as const;
  const stageLabels = stages.map((stage) => `shipper:${stage}`);

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
    aggregateAllIssueUsage: state.aggregateAllIssueUsageMock,
    buildPromptCommand: state.buildPromptCommandMock,
    checkGhAuth: state.checkGhAuthMock,
    checkGhInstalled: state.checkGhInstalledMock,
    checkLabels: state.checkLabelsMock,
    createDesktopGroomWorktree: state.createDesktopGroomWorktreeMock,
    ensureRepoClone: state.ensureRepoCloneMock,
    ensureRepoCloneForWorktree: state.ensureRepoCloneForWorktreeMock,
    executeReset: state.executeResetMock,
    getCurrentStage,
    getSettings: state.getSettingsMock,
    getStageIndex,
    getStageLabel,
    getValidTargets,
    gh: state.ghMock,
    FAILED_LABEL: 'shipper:failed',
    isPlainObject,
    isLockStale: state.isLockStaleMock,
    listIssues: state.listIssuesMock,
    LOCKED_LABEL: 'shipper:locked',
    parseStage,
    PRIORITY_HIGH_LABEL: 'shipper:priority-high',
    PRIORITY_LOW_LABEL: 'shipper:priority-low',
    releaseIssueLock: state.releaseIssueLockMock,
    renewIssueLock: state.renewIssueLockMock,
    resolveBaseBranch: state.resolveBaseBranchMock,
    scanArtifacts: state.scanArtifactsMock,
    STAGE_LABEL_NAMES: stageLabels,
    toError,
    toErrorMessage,
  };
});

vi.mock('electron', () => {
  class MockBrowserWindow {
    static getAllWindows = state.browserWindowGetAllWindowsMock;

    webContents = {
      getURL: state.webContentsGetUrlMock,
      on: state.webContentsOnMock,
      send: state.webContentsSendMock,
      setWindowOpenHandler: state.webContentsSetWindowOpenHandlerMock,
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
    shell: {
      openExternal: state.shellOpenExternalMock,
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
    requestPause = state.backgroundRequestPauseMock;
    removeQueuedSession = state.backgroundRemoveQueuedSessionMock;
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
  state.shellOpenExternalMock.mockReset();
  state.shellOpenExternalMock.mockResolvedValue(undefined);
  state.webContentsOnMock.mockReset();
  state.webContentsGetUrlMock.mockReset();
  state.webContentsGetUrlMock.mockReturnValue('http://localhost:3000/');
  state.webContentsSetWindowOpenHandlerMock.mockReset();
  state.browserWindowOnMock.mockImplementation(
    (event: string, handler: (...args: unknown[]) => void) => {
      state.browserWindowEventHandlers.set(event, handler);
    }
  );
  state.getSettingsMock.mockReturnValue({ lockTimeoutMinutes: 30, defaultBaseBranch: undefined });
  state.acquireIssueLockMock.mockResolvedValue(undefined);
  state.aggregateAllIssueUsageMock.mockResolvedValue(new Map());
  state.releaseIssueLockMock.mockResolvedValue(undefined);
  state.renewIssueLockMock.mockResolvedValue(undefined);
  state.ensureRepoCloneMock.mockResolvedValue('/tmp/repo');
  state.ensureRepoCloneForWorktreeMock.mockResolvedValue('/tmp/repo');
  state.desktopGroomCleanupMock.mockResolvedValue(undefined);
  state.createDesktopGroomWorktreeMock.mockResolvedValue({
    wtPath: '/tmp/groom-wt',
    cleanup: state.desktopGroomCleanupMock,
  });
  state.resolveBaseBranchMock.mockResolvedValue('main');
  state.buildPromptCommandMock.mockImplementation(
    (command: string, opts: { cwd?: string; issueRef?: string }) =>
      Promise.resolve({
        command: 'codex',
        args: [command, opts.issueRef ?? ''],
        cwd: opts.cwd,
        initialInput: undefined,
      })
  );
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
  state.backgroundRequestPauseMock.mockReset();
  state.backgroundRemoveQueuedSessionMock.mockReset();
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

function getPtySpawnCwds(): unknown[] {
  return (state.ptySpawnMock.mock.calls as unknown[][]).map((call) => {
    const options = call[3];
    if (typeof options !== 'object' || options === null || !('cwd' in options)) {
      return undefined;
    }

    return (options as { cwd?: unknown }).cwd;
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });

  return { promise, resolve };
}

async function flushMicrotasks(count = 5): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

beforeEach(() => {
  vi.clearAllMocks();
  warnMock.mockClear();
  warnMock.mockImplementation(() => {});
  mockUserDataPath = mkdtempSync(join(tmpdir(), 'shipper-desktop-tests-'));
});

afterEach(() => {
  vi.useRealTimers();
  state.handlers.clear();
  state.exitCallbacks.clear();
  state.browserWindowEventHandlers.clear();
  if (mockUserDataPath) {
    rmSync(mockUserDataPath, { recursive: true, force: true });
    mockUserDataPath = '';
  }
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

  it('accepts preload-shaped ship payloads with origin set to undefined', async () => {
    await loadHandlers();
    const handler = getHandler('bg-spawn-ship');

    const result = parseSessionResult(
      await handler({}, { repo: 'owner/repo', issueNumber: 42, merge: false, origin: undefined })
    );
    const spawnCall = parseBackgroundSpawnCall();

    expect(result.sessionId).toEqual(expect.any(String));
    expect(spawnCall.sessionId).toBe(result.sessionId);
    expect(spawnCall.command).toBe('ship');
    expect(spawnCall.repo).toBe('owner/repo');
    expect(spawnCall.commandName).toBe('shipper');
    expect(spawnCall.cwd).toBe('/tmp/repo');
    expect(spawnCall.args).toEqual(['ship', '42', '--mode', 'headless']);
    expect(spawnCall.meta).toEqual({ issueNumber: 42, merge: false, origin: undefined });
    expect(state.ptySpawnMock).not.toHaveBeenCalled();
  });

  it('spawns `unblock` through the background manager in headless mode', async () => {
    await loadHandlers();
    const handler = getHandler('bg-spawn-unblock');

    const result = parseSessionResult(await handler({}, { repo: 'owner/repo', issueNumber: 42 }));
    const spawnCall = parseBackgroundSpawnCall();

    expect(result.sessionId).toEqual(expect.any(String));
    expect(spawnCall.sessionId).toBe(result.sessionId);
    expect(spawnCall.command).toBe('unblock');
    expect(spawnCall.repo).toBe('owner/repo');
    expect(spawnCall.commandName).toBe('shipper');
    expect(spawnCall.cwd).toBe('/tmp/repo');
    expect(spawnCall.args).toEqual(['unblock', '42', '--mode', 'headless']);
    expect(spawnCall.meta).toEqual({ issueNumber: 42 });
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

  it('lists repositories through GraphQL with owner and other grouping', async () => {
    await loadHandlers();
    state.ghMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        data: {
          viewer: {
            login: 'OctoCat',
            repositories: {
              nodes: [
                { nameWithOwner: 'octocat/personal-new', owner: { login: 'octocat' } },
                { nameWithOwner: 'acme/org-repo', owner: { login: 'acme' } },
                { nameWithOwner: 'someone-else/foo', owner: { login: 'someone-else' } },
              ],
            },
          },
        },
      }),
      stderr: '',
    });
    const handler = getHandler('list-repos');

    await expect(handler({}, undefined)).resolves.toEqual([
      { nameWithOwner: 'octocat/personal-new', group: 'owner' },
      { nameWithOwner: 'acme/org-repo', group: 'other' },
      { nameWithOwner: 'someone-else/foo', group: 'other' },
    ]);

    const ghCall: unknown = state.ghMock.mock.calls[0]?.[0];
    if (!isStringArray(ghCall)) {
      throw new Error('Expected gh to be called with arguments.');
    }

    expect(ghCall).toEqual([
      'api',
      'graphql',
      '-f',
      expect.stringMatching(/^query=/),
      '-F',
      'limit=100',
    ]);

    const queryArgument = ghCall[3];
    if (queryArgument === undefined) {
      throw new Error('Expected GraphQL query argument.');
    }

    const query = queryArgument.slice('query='.length);
    expect(query).toContain('affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]');
    expect(query).toContain('isArchived: false');
    expect(query).toContain('field: PUSHED_AT');
    expect(query).toContain('direction: DESC');
  });

  it('surfaces a descriptive error when list-repos returns malformed JSON', async () => {
    await loadHandlers();
    state.ghMock.mockResolvedValueOnce({ stdout: 'not json', stderr: '' });
    const handler = getHandler('list-repos');

    await expect(handler({}, undefined)).rejects.toThrow(
      /Failed to parse repository list from GitHub CLI: Unexpected token/
    );
  });

  it('surfaces a descriptive error when list-repos returns GraphQL errors', async () => {
    await loadHandlers();
    state.ghMock.mockResolvedValueOnce({
      stdout: JSON.stringify({ errors: [{ message: 'bad query' }] }),
      stderr: '',
    });
    const handler = getHandler('list-repos');

    await expect(handler({}, undefined)).rejects.toThrow(
      /Failed to parse repository list from GitHub CLI:/
    );
  });

  it('surfaces a descriptive error when list-repos returns malformed GraphQL data', async () => {
    await loadHandlers();
    state.ghMock.mockResolvedValueOnce({
      stdout: JSON.stringify({ data: { viewer: { login: 'octocat', repositories: {} } } }),
      stderr: '',
    });
    const handler = getHandler('list-repos');

    await expect(handler({}, undefined)).rejects.toThrow(
      /Failed to parse repository list from GitHub CLI:/
    );
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

  it('uses copilot from settings.json when resolving the init agent', async () => {
    await loadHandlers();
    const repoPath = mkdtempSync(join(tmpdir(), 'shipper-desktop-init-'));
    mkdirSync(join(repoPath, '.shipper'), { recursive: true });
    writeFileSync(
      join(repoPath, '.shipper', 'settings.json'),
      JSON.stringify({ commands: { default: { agent: 'copilot' } } }),
      'utf8'
    );
    state.ensureRepoCloneMock.mockResolvedValueOnce(repoPath);
    const handler = getHandler('bg-spawn-init');

    const result = parseSessionResult(await handler({}, { repo: 'owner/repo' }));
    const spawnCall = parseBackgroundSpawnCall();

    expect(spawnCall.sessionId).toBe(result.sessionId);
    expect(spawnCall.command).toBe('init');
    expect(spawnCall.args).toEqual(['init', '--agent', 'copilot']);
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

  it('forwards bg-request-pause and bg-remove-queued-session payloads to the background manager', async () => {
    await loadHandlers();
    const requestPauseHandler = getHandler('bg-request-pause');
    const removeQueuedHandler = getHandler('bg-remove-queued-session');

    await requestPauseHandler({}, { sessionId: 'ship-1' });
    await removeQueuedHandler({}, { sessionId: 'ship-2' });

    expect(state.backgroundRequestPauseMock).toHaveBeenCalledWith('ship-1');
    expect(state.backgroundRemoveQueuedSessionMock).toHaveBeenCalledWith('ship-2');
  });

  it('validates bg-request-pause and bg-remove-queued-session payloads', async () => {
    await loadHandlers();
    const requestPauseHandler = getHandler('bg-request-pause');
    const removeQueuedHandler = getHandler('bg-remove-queued-session');

    expect(() => requestPauseHandler({}, { sessionId: 42 })).toThrow(
      'Invalid bg-request-pause payload.'
    );
    expect(() => removeQueuedHandler({}, null)).toThrow(
      'Invalid bg-remove-queued-session payload.'
    );
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
    expect(state.ensureRepoCloneForWorktreeMock).toHaveBeenCalledWith('owner/repo');
    expect(state.ensureRepoCloneMock).not.toHaveBeenCalled();
    expect(state.createDesktopGroomWorktreeMock).toHaveBeenCalledWith({
      repoRoot: '/tmp/repo',
      issueNumber: '42',
      baseBranch: 'main',
    });
    expect(state.ptySpawnMock).toHaveBeenCalledWith(
      expect.any(String),
      'codex',
      ['groom', '42'],
      expect.objectContaining({
        cols: 120,
        rows: 40,
        cwd: '/tmp/groom-wt',
        initialInput: undefined,
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

  it('builds the groom prompt with the detached worktree path as cwd', async () => {
    await loadHandlers();
    const handler = getHandler('pty-spawn-shipper-groom');

    await handler(
      {},
      {
        repo: 'owner/repo',
        issueNumber: 42,
        cols: 120,
        rows: 40,
      }
    );

    expect(state.buildPromptCommandMock).toHaveBeenCalledWith('groom', {
      issueRef: '42',
      repo: 'owner/repo',
      cwd: '/tmp/groom-wt',
      mode: 'interactive',
    });
  });

  it('allows different issues in the same repo to spawn groom PTYs in different worktrees', async () => {
    await loadHandlers();
    state.createDesktopGroomWorktreeMock
      .mockResolvedValueOnce({
        wtPath: '/tmp/groom-wt-42',
        cleanup: state.desktopGroomCleanupMock,
      })
      .mockResolvedValueOnce({
        wtPath: '/tmp/groom-wt-43',
        cleanup: state.desktopGroomCleanupMock,
      });
    const handler = getHandler('pty-spawn-shipper-groom');

    await handler({}, { repo: 'owner/repo', issueNumber: 42, cols: 120, rows: 40 });
    await handler({}, { repo: 'owner/repo', issueNumber: 43, cols: 120, rows: 40 });

    expect(state.createDesktopGroomWorktreeMock).toHaveBeenNthCalledWith(1, {
      repoRoot: '/tmp/repo',
      issueNumber: '42',
      baseBranch: 'main',
    });
    expect(state.createDesktopGroomWorktreeMock).toHaveBeenNthCalledWith(2, {
      repoRoot: '/tmp/repo',
      issueNumber: '43',
      baseBranch: 'main',
    });
    expect(getPtySpawnCwds()).toEqual(['/tmp/groom-wt-42', '/tmp/groom-wt-43']);
  });

  it('serializes groom clone preparation and worktree creation per repo without blocking active groom sessions', async () => {
    await loadHandlers();
    const firstWorktree = deferred<{ wtPath: string; cleanup: () => Promise<void> }>();
    state.createDesktopGroomWorktreeMock
      .mockReturnValueOnce(firstWorktree.promise)
      .mockResolvedValueOnce({
        wtPath: '/tmp/groom-wt-43',
        cleanup: state.desktopGroomCleanupMock,
      });
    const handler = getHandler('pty-spawn-shipper-groom');

    const first = handler({}, { repo: 'owner/repo', issueNumber: 42, cols: 120, rows: 40 });
    await flushMicrotasks();
    const second = handler({}, { repo: 'owner/repo', issueNumber: 43, cols: 120, rows: 40 });
    await flushMicrotasks();

    expect(state.ensureRepoCloneForWorktreeMock).toHaveBeenCalledTimes(1);
    expect(state.createDesktopGroomWorktreeMock).toHaveBeenCalledTimes(1);

    firstWorktree.resolve({
      wtPath: '/tmp/groom-wt-42',
      cleanup: state.desktopGroomCleanupMock,
    });

    await first;
    await second;

    expect(state.ensureRepoCloneForWorktreeMock).toHaveBeenCalledTimes(2);
    expect(state.createDesktopGroomWorktreeMock).toHaveBeenCalledTimes(2);
    expect(getPtySpawnCwds()).toEqual(['/tmp/groom-wt-42', '/tmp/groom-wt-43']);
  });

  it('releases the groom lock and removes the worktree when the PTY session exits', async () => {
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
    await Promise.resolve();

    expect(state.releaseIssueLockMock).toHaveBeenCalledWith('owner/repo', '42');
    expect(state.desktopGroomCleanupMock).toHaveBeenCalledTimes(1);
  });

  it('logs groom cleanup failures on PTY exit', async () => {
    await loadHandlers();
    const handler = getHandler('pty-spawn-shipper-groom');
    state.releaseIssueLockMock.mockRejectedValueOnce(new Error('release failed'));

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
    await flushMicrotasks();

    expect(warnMock).toHaveBeenCalledWith(
      '[shipper] Failed to clean up groom session after session exit',
      expect.any(Error)
    );
  });

  it('releases the groom lock and removes the worktree when prompt building fails', async () => {
    await loadHandlers();
    const handler = getHandler('pty-spawn-shipper-groom');
    state.buildPromptCommandMock.mockRejectedValueOnce(new Error('prompt failed'));

    await expect(
      handler({}, { repo: 'owner/repo', issueNumber: 42, cols: 120, rows: 40 })
    ).rejects.toThrow('prompt failed');

    expect(state.releaseIssueLockMock).toHaveBeenCalledWith('owner/repo', '42');
    expect(state.desktopGroomCleanupMock).toHaveBeenCalledTimes(1);
    expect(state.ptySpawnMock).not.toHaveBeenCalled();
  });

  it('uses the configured base branch for groom worktrees without resolving the default branch', async () => {
    await loadHandlers();
    state.getSettingsMock.mockReturnValue({ lockTimeoutMinutes: 30, defaultBaseBranch: 'develop' });
    const handler = getHandler('pty-spawn-shipper-groom');

    await handler({}, { repo: 'owner/repo', issueNumber: 42, cols: 120, rows: 40 });

    expect(state.resolveBaseBranchMock).not.toHaveBeenCalled();
    expect(state.createDesktopGroomWorktreeMock).toHaveBeenCalledWith({
      repoRoot: '/tmp/repo',
      issueNumber: '42',
      baseBranch: 'develop',
    });
  });

  it('forwards initialInput from buildPromptCommand into PTY spawn', async () => {
    await loadHandlers();
    state.buildPromptCommandMock.mockResolvedValueOnce({
      command: 'copilot',
      args: ['--model', 'gpt-5'],
      cwd: '/tmp/groom-wt',
      initialInput: 'seed prompt',
    });
    const handler = getHandler('pty-spawn-shipper-groom');

    await handler(
      {},
      {
        repo: 'owner/repo',
        issueNumber: 42,
        cols: 120,
        rows: 40,
      }
    );

    expect(state.ptySpawnMock).toHaveBeenCalledWith(
      expect.any(String),
      'copilot',
      ['--model', 'gpt-5'],
      expect.objectContaining({
        cols: 120,
        rows: 40,
        cwd: '/tmp/groom-wt',
        initialInput: 'seed prompt',
      })
    );
  });

  it('spawns a setup PTY with the fresh-setup opening input when .shipper is absent', async () => {
    await loadHandlers();
    const repoPath = mkdtempSync(join(tmpdir(), 'shipper-desktop-setup-fresh-'));
    state.ensureRepoCloneMock.mockResolvedValueOnce(repoPath);
    state.buildPromptCommandMock.mockResolvedValueOnce({
      command: 'copilot',
      args: ['setup'],
      cwd: repoPath,
      initialInput: 'seed prompt',
    });
    const handler = getHandler('pty-spawn-shipper-setup');

    const result = parseSessionResult(
      await handler({}, { repo: 'owner/repo', cols: 120, rows: 40 })
    );

    expect(result.sessionId).toEqual(expect.any(String));
    expect(state.ensureRepoCloneMock).toHaveBeenCalledWith('owner/repo');
    expect(state.buildPromptCommandMock).toHaveBeenCalledWith('setup', {
      userInput: `Run setup for ${basename(repoPath)}. This is a fresh setup — no .shipper/ directory found.`,
      repo: 'owner/repo',
      cwd: repoPath,
      mode: 'interactive',
    });
    expect(state.ptySpawnMock).toHaveBeenCalledWith(result.sessionId, 'copilot', ['setup'], {
      cols: 120,
      rows: 40,
      cwd: repoPath,
      initialInput: 'seed prompt',
    });
    expect(state.acquireIssueLockMock).not.toHaveBeenCalled();
    expect(state.renewIssueLockMock).not.toHaveBeenCalled();
    expect(state.releaseIssueLockMock).not.toHaveBeenCalled();
    expect(state.ptyOnSessionExitMock).toHaveBeenCalledWith(result.sessionId, expect.any(Function));

    rmSync(repoPath, { recursive: true, force: true });
  });

  it('spawns a setup PTY with the rerun opening input when .shipper exists', async () => {
    await loadHandlers();
    const repoPath = mkdtempSync(join(tmpdir(), 'shipper-desktop-setup-existing-'));
    mkdirSync(join(repoPath, '.shipper'));
    state.ensureRepoCloneMock.mockResolvedValueOnce(repoPath);
    state.buildPromptCommandMock.mockResolvedValueOnce({
      command: 'copilot',
      args: ['setup'],
      cwd: repoPath,
      initialInput: 'seed prompt',
    });
    const handler = getHandler('pty-spawn-shipper-setup');

    const result = parseSessionResult(
      await handler({}, { repo: 'owner/repo', cols: 120, rows: 40 })
    );

    expect(result.sessionId).toEqual(expect.any(String));
    expect(state.buildPromptCommandMock).toHaveBeenCalledWith('setup', {
      userInput: `Run setup for ${basename(repoPath)}. .shipper/ directory already exists.`,
      repo: 'owner/repo',
      cwd: repoPath,
      mode: 'interactive',
    });
    expect(state.ptySpawnMock).toHaveBeenCalledWith(result.sessionId, 'copilot', ['setup'], {
      cols: 120,
      rows: 40,
      cwd: repoPath,
      initialInput: 'seed prompt',
    });
    expect(state.acquireIssueLockMock).not.toHaveBeenCalled();
    expect(state.renewIssueLockMock).not.toHaveBeenCalled();
    expect(state.releaseIssueLockMock).not.toHaveBeenCalled();
    expect(state.ptyOnSessionExitMock).toHaveBeenCalledWith(result.sessionId, expect.any(Function));

    rmSync(repoPath, { recursive: true, force: true });
  });

  it('refuses a second setup PTY for the same repo while setup is active', async () => {
    await loadHandlers();
    const handler = getHandler('pty-spawn-shipper-setup');

    await handler({}, { repo: 'owner/repo', cols: 120, rows: 40 });

    await expect(handler({}, { repo: 'owner/repo', cols: 120, rows: 40 })).rejects.toThrow(
      'Setup is already running for owner/repo.'
    );
    expect(state.ensureRepoCloneMock).toHaveBeenCalledTimes(1);
    expect(state.ptySpawnMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a second setup PTY for the same repo regardless of repo casing', async () => {
    await loadHandlers();
    const handler = getHandler('pty-spawn-shipper-setup');

    await handler({}, { repo: 'Owner/Repo', cols: 120, rows: 40 });

    await expect(handler({}, { repo: 'owner/repo', cols: 120, rows: 40 })).rejects.toThrow(
      'Setup is already running for owner/repo.'
    );
    expect(state.ensureRepoCloneMock).toHaveBeenCalledTimes(1);
    expect(state.ptySpawnMock).toHaveBeenCalledTimes(1);
  });

  it('allows setup for the same repo again after the active setup PTY exits', async () => {
    await loadHandlers();
    const handler = getHandler('pty-spawn-shipper-setup');

    const firstResult = parseSessionResult(
      await handler({}, { repo: 'owner/repo', cols: 120, rows: 40 })
    );
    state.exitCallbacks.get(firstResult.sessionId)?.();
    const secondResult = parseSessionResult(
      await handler({}, { repo: 'owner/repo', cols: 120, rows: 40 })
    );

    expect(secondResult.sessionId).toEqual(expect.any(String));
    expect(state.ensureRepoCloneMock).toHaveBeenCalledTimes(2);
    expect(state.ptySpawnMock).toHaveBeenCalledTimes(2);
  });

  it('allows setup PTYs for different repos to run concurrently', async () => {
    await loadHandlers();
    state.ensureRepoCloneMock
      .mockResolvedValueOnce('/tmp/repo-a')
      .mockResolvedValueOnce('/tmp/repo-b');
    const handler = getHandler('pty-spawn-shipper-setup');

    await handler({}, { repo: 'owner/repo-a', cols: 120, rows: 40 });
    await handler({}, { repo: 'owner/repo-b', cols: 120, rows: 40 });

    expect(state.ensureRepoCloneMock).toHaveBeenNthCalledWith(1, 'owner/repo-a');
    expect(state.ensureRepoCloneMock).toHaveBeenNthCalledWith(2, 'owner/repo-b');
    expect(getPtySpawnCwds()).toEqual(['/tmp/repo-a', '/tmp/repo-b']);
  });

  it('allows groom and setup for the same repo to run concurrently in separate directories', async () => {
    await loadHandlers();
    const groomHandler = getHandler('pty-spawn-shipper-groom');
    const setupHandler = getHandler('pty-spawn-shipper-setup');

    await groomHandler({}, { repo: 'owner/repo', issueNumber: 42, cols: 120, rows: 40 });
    await setupHandler({}, { repo: 'owner/repo', cols: 120, rows: 40 });

    expect(state.ensureRepoCloneForWorktreeMock).toHaveBeenCalledWith('owner/repo');
    expect(state.ensureRepoCloneMock).toHaveBeenCalledTimes(1);
    expect(getPtySpawnCwds()).toEqual(['/tmp/groom-wt', '/tmp/repo']);
  });

  it('serializes groom and setup canonical repo preparation for the same repo', async () => {
    await loadHandlers();
    const firstWorktree = deferred<{ wtPath: string; cleanup: () => Promise<void> }>();
    state.createDesktopGroomWorktreeMock.mockReturnValueOnce(firstWorktree.promise);
    const groomHandler = getHandler('pty-spawn-shipper-groom');
    const setupHandler = getHandler('pty-spawn-shipper-setup');

    const groom = groomHandler({}, { repo: 'owner/repo', issueNumber: 42, cols: 120, rows: 40 });
    await flushMicrotasks();
    const setup = setupHandler({}, { repo: 'owner/repo', cols: 120, rows: 40 });
    await flushMicrotasks();

    expect(state.ensureRepoCloneForWorktreeMock).toHaveBeenCalledTimes(1);
    expect(state.createDesktopGroomWorktreeMock).toHaveBeenCalledTimes(1);
    expect(state.ensureRepoCloneMock).not.toHaveBeenCalled();

    firstWorktree.resolve({
      wtPath: '/tmp/groom-wt',
      cleanup: state.desktopGroomCleanupMock,
    });

    await groom;
    await setup;

    expect(state.ensureRepoCloneMock).toHaveBeenCalledTimes(1);
    expect(getPtySpawnCwds()).toEqual(['/tmp/groom-wt', '/tmp/repo']);
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
    expect(state.ensureRepoCloneForWorktreeMock).not.toHaveBeenCalled();
    expect(state.createDesktopGroomWorktreeMock).not.toHaveBeenCalled();
    expect(state.ptySpawnMock).not.toHaveBeenCalled();
  });

  it('releases the groom lock when clone preparation fails before PTY spawn', async () => {
    await loadHandlers();
    const handler = getHandler('pty-spawn-shipper-groom');
    state.ensureRepoCloneForWorktreeMock.mockRejectedValueOnce(new Error('clone failed'));

    await expect(
      handler({}, { repo: 'owner/repo', issueNumber: 42, cols: 120, rows: 40 })
    ).rejects.toThrow('clone failed');
    expect(state.ptySpawnMock).not.toHaveBeenCalled();
    expect(state.releaseIssueLockMock).toHaveBeenCalledWith('owner/repo', '42');
    expect(state.desktopGroomCleanupMock).not.toHaveBeenCalled();
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
    expect(state.desktopGroomCleanupMock).toHaveBeenCalledTimes(1);

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

  it('allows failed-only issues through scan-reset validation', async () => {
    await loadHandlers();
    queueResetIssue(['shipper:failed']);
    state.scanArtifactsMock.mockResolvedValueOnce({
      targetStage: 'planned',
      targetLabel: 'shipper:planned',
      labelsToRemove: [],
      addTarget: false,
      prs: [],
      branchesToDelete: [],
      localBranches: [],
      localWorktrees: [],
      commentIds: [],
    });
    const handler = getHandler('scan-reset');

    await expect(
      handler({}, { repo: 'owner/repo', issueNumber: 42, targetStage: 'planned' })
    ).resolves.toEqual({
      ok: true,
      scan: {
        targetStage: 'planned',
        targetLabel: 'shipper:planned',
        labelsToRemove: [],
        addTarget: false,
        prs: [],
        branchesToDelete: [],
        localBranches: [],
        localWorktrees: [],
        commentCount: 0,
      },
    });
    expect(state.scanArtifactsMock).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'planned',
      ['shipper:failed'],
      expect.objectContaining({ repoName: 'repo' })
    );
  });

  it('allows failed-only issues through execute-reset validation', async () => {
    await loadHandlers();
    queueResetIssue(['shipper:failed']);
    const handler = getHandler('execute-reset');

    await expect(
      handler({}, { repo: 'owner/repo', issueNumber: 42, targetStage: 'planned' })
    ).resolves.toEqual({ ok: true });
    expect(state.acquireIssueLockMock).toHaveBeenCalledWith('owner/repo', '42');
    expect(state.executeResetMock).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ targetStage: 'groomed', targetLabel: 'shipper:groomed' }),
      'owner/repo'
    );
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
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const handler = getHandler('check-lock-stale');

      await expect(handler({}, { repo: 'owner/repo', issueNumber: 42 })).resolves.toEqual({
        stale: false,
      });
      expect(state.isLockStaleMock).toHaveBeenCalledWith('owner/repo', '42');
      expect(warnSpy).toHaveBeenCalledWith('[shipper] Failed to check lock staleness');
    } finally {
      warnSpy.mockRestore();
    }
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

  it('returns adoptable issues with url fields from gh issue list output', async () => {
    await loadHandlers();
    state.ghMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 42,
          title: 'Adopt this issue',
          labels: [{ name: 'bug' }],
          state: 'OPEN',
          author: { login: 'octocat' },
          createdAt: '2026-04-03T00:00:00Z',
          url: 'https://github.com/owner/repo/issues/42',
        },
      ]),
      stderr: '',
    });
    const handler = getHandler('list-adoptable-issues');

    await expect(handler({}, { repo: 'owner/repo' })).resolves.toEqual({
      ok: true,
      issues: [
        {
          number: 42,
          title: 'Adopt this issue',
          labels: ['bug'],
          state: 'OPEN',
          author: 'octocat',
          createdAt: '2026-04-03T00:00:00Z',
          url: 'https://github.com/owner/repo/issues/42',
        },
      ],
    });
    expect(state.ghMock).toHaveBeenCalledWith([
      'issue',
      'list',
      '-R',
      'owner/repo',
      '--state',
      'open',
      '--limit',
      '1000',
      '--json',
      'number,title,labels,state,author,createdAt,url',
    ]);
  });

  it('sets high priority by adding the high label and removing the low label', async () => {
    await loadHandlers();
    state.ghMock.mockResolvedValueOnce({ stdout: '', stderr: '' });
    const handler = getHandler('set-priority');

    await expect(
      handler({}, { repo: 'owner/repo', issueNumber: 42, level: 'high' })
    ).resolves.toEqual({
      ok: true,
    });
    expect(state.ghMock).toHaveBeenCalledWith([
      'issue',
      'edit',
      '42',
      '-R',
      'owner/repo',
      '--add-label',
      'shipper:priority-high',
      '--remove-label',
      'shipper:priority-low',
    ]);
  });

  it('sets low priority by adding the low label and removing the high label', async () => {
    await loadHandlers();
    state.ghMock.mockResolvedValueOnce({ stdout: '', stderr: '' });
    const handler = getHandler('set-priority');

    await expect(
      handler({}, { repo: 'owner/repo', issueNumber: 42, level: 'low' })
    ).resolves.toEqual({
      ok: true,
    });
    expect(state.ghMock).toHaveBeenCalledWith([
      'issue',
      'edit',
      '42',
      '-R',
      'owner/repo',
      '--add-label',
      'shipper:priority-low',
      '--remove-label',
      'shipper:priority-high',
    ]);
  });

  it('sets normal priority by removing both priority labels', async () => {
    await loadHandlers();
    state.ghMock.mockResolvedValueOnce({ stdout: '', stderr: '' });
    const handler = getHandler('set-priority');

    await expect(
      handler({}, { repo: 'owner/repo', issueNumber: 42, level: 'normal' })
    ).resolves.toEqual({
      ok: true,
    });
    expect(state.ghMock).toHaveBeenCalledWith([
      'issue',
      'edit',
      '42',
      '-R',
      'owner/repo',
      '--remove-label',
      'shipper:priority-high',
      '--remove-label',
      'shipper:priority-low',
    ]);
  });

  it('returns an inline error for set-priority requests with invalid payloads', async () => {
    await loadHandlers();
    const handler = getHandler('set-priority');

    await expect(
      handler({}, { repo: 'owner/repo', issueNumber: 0, level: 'high' })
    ).resolves.toEqual({
      ok: false,
      error: 'Enter a repository in owner/repo format and a positive issue number.',
    });
    expect(state.ghMock).not.toHaveBeenCalled();
  });

  it('rejects invalid priority levels without calling gh', async () => {
    await loadHandlers();
    const handler = getHandler('set-priority');

    await expect(
      handler({}, { repo: 'owner/repo', issueNumber: 42, level: 'urgent' })
    ).resolves.toEqual({
      ok: false,
      error: 'Invalid priority level.',
    });
    expect(state.ghMock).not.toHaveBeenCalled();
  });

  it('surfaces gh failures when setting priority', async () => {
    await loadHandlers();
    state.ghMock.mockRejectedValueOnce(new Error('gh failed'));
    const handler = getHandler('set-priority');

    await expect(
      handler({}, { repo: 'owner/repo', issueNumber: 42, level: 'high' })
    ).resolves.toEqual({
      ok: false,
      error: 'gh failed',
    });
  });

  it('returns token usage on list-issues responses, including zero fallbacks', async () => {
    await loadHandlers();
    state.listIssuesMock.mockResolvedValueOnce([
      {
        number: 42,
        title: 'Show token totals',
        labels: ['shipper:planned'],
        state: 'OPEN',
        author: 'dnsquared',
        createdAt: '2026-04-20T00:00:00Z',
        url: 'https://github.com/owner/repo/issues/42',
      },
      {
        number: 43,
        title: 'No usage yet',
        labels: ['shipper:new'],
        state: 'OPEN',
        author: 'dnsquared',
        createdAt: '2026-04-20T00:00:00Z',
        url: 'https://github.com/owner/repo/issues/43',
      },
    ]);
    state.aggregateAllIssueUsageMock.mockResolvedValueOnce(
      new Map([
        [
          '42',
          {
            inputTokens: 10,
            outputTokens: 20,
            cacheReadTokens: 30,
            cacheWriteTokens: 40,
          },
        ],
      ])
    );
    const handler = getHandler('list-issues');

    await expect(handler({}, { repo: 'owner/repo' })).resolves.toEqual({
      ok: true,
      issues: [
        {
          number: 42,
          title: 'Show token totals',
          labels: ['shipper:planned'],
          state: 'OPEN',
          author: 'dnsquared',
          createdAt: '2026-04-20T00:00:00Z',
          url: 'https://github.com/owner/repo/issues/42',
          tokenUsage: {
            inputTokens: 10,
            outputTokens: 20,
            cacheReadTokens: 30,
            cacheWriteTokens: 40,
          },
        },
        {
          number: 43,
          title: 'No usage yet',
          labels: ['shipper:new'],
          state: 'OPEN',
          author: 'dnsquared',
          createdAt: '2026-04-20T00:00:00Z',
          url: 'https://github.com/owner/repo/issues/43',
          tokenUsage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        },
      ],
    });
    expect(state.aggregateAllIssueUsageMock).toHaveBeenCalledWith('owner/repo');
  });

  it('still registers groom on the PTY path with lock acquisition intact', async () => {
    await loadHandlers();

    expect([...state.handlers.keys()].sort()).toEqual(
      [
        'check-prerequisites',
        'check-init',
        'fetch-issue-timelines',
        'list-issues',
        'list-adoptable-issues',
        'adopt-issue',
        'close-not-planned',
        'set-priority',
        'check-lock-stale',
        'unlock-issue',
        'scan-reset',
        'execute-reset',
        'get-config',
        'list-repos',
        'pause-state:list',
        'pause-state:add',
        'pause-state:remove',
        'set-config',
        'pty-spawn-shipper-groom',
        'pty-spawn-shipper-setup',
        'pty-write',
        'pty-resize',
        'pty-kill',
        'bg-spawn-new',
        'bg-spawn-ship',
        'bg-spawn-init',
        'bg-spawn-unblock',
        'bg-kill',
        'bg-request-pause',
        'bg-request-auto-ship-halt',
        'bg-remove-queued-session',
        'bg-get-output',
      ].sort()
    );
  });
});
