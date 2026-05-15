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
  ptyGetCloseStateMock: vi.fn(),
  ptyFinalizeMock: vi.fn(),
  ptyForceKillMock: vi.fn(),
  ptyListLiveWorkflowSessionsMock: vi.fn(),
  ptyCloseLiveWorkflowSessionsForQuitMock: vi.fn(),
  ptyDestroyAllMock: vi.fn(),
  appWhenReadyMock: vi.fn(),
  appOnMock: vi.fn(),
  appQuitMock: vi.fn(),
  appGetPathMock: vi.fn(),
  browserWindowOnMock: vi.fn(),
  browserWindowOnceMock: vi.fn(),
  browserWindowShowMock: vi.fn(),
  browserWindowCloseMock: vi.fn(),
  browserWindowLoadUrlMock: vi.fn(),
  browserWindowLoadFileMock: vi.fn(),
  browserWindowGetAllWindowsMock: vi.fn(),
  shellOpenExternalMock: vi.fn<(url: string) => Promise<void>>(),
  dialogShowMessageBoxMock: vi.fn(),
  webContentsSendMock: vi.fn(),
  webContentsOnMock: vi.fn(),
  webContentsGetUrlMock: vi.fn(),
  webContentsSetWindowOpenHandlerMock: vi.fn(),
  ipcHandleMock: vi.fn(),
  browserWindowEventHandlers: new Map<string, (...args: unknown[]) => void>(),
}));

const warnMock = vi.spyOn(console, 'warn').mockImplementation(() => {});

vi.mock('@baremetallabs-ai/shipper-core', async () => {
  const { isPlainObject, toError, toErrorMessage } = await vi.importActual<
    typeof import('@baremetallabs-ai/shipper-core')
  >('@baremetallabs-ai/shipper-core');
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
    SHIPPER_DESKTOP_CONTROL_DIR_ENV: 'SHIPPER_DESKTOP_CONTROL_DIR',
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
    close = state.browserWindowCloseMock;
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
    dialog: {
      showMessageBox: state.dialogShowMessageBoxMock,
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
    getCloseState = state.ptyGetCloseStateMock;
    finalize = state.ptyFinalizeMock;
    forceKill = state.ptyForceKillMock;
    listLiveWorkflowSessions = state.ptyListLiveWorkflowSessionsMock;
    closeLiveWorkflowSessionsForQuit = state.ptyCloseLiveWorkflowSessionsForQuitMock;
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
  state.browserWindowCloseMock.mockReset();
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
  state.ptyGetCloseStateMock.mockReset();
  state.ptyGetCloseStateMock.mockResolvedValue({ state: 'finalizable' });
  state.ptyFinalizeMock.mockReset();
  state.ptyFinalizeMock.mockResolvedValue(undefined);
  state.ptyForceKillMock.mockReset();
  state.ptyListLiveWorkflowSessionsMock.mockReset();
  state.ptyListLiveWorkflowSessionsMock.mockReturnValue([]);
  state.ptyCloseLiveWorkflowSessionsForQuitMock.mockReset();
  state.ptyCloseLiveWorkflowSessionsForQuitMock.mockResolvedValue(undefined);
  state.dialogShowMessageBoxMock.mockReset();
  state.dialogShowMessageBoxMock.mockResolvedValue({ response: 1 });

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

function getBackgroundOnComplete(
  spawnCall: Record<string, unknown>
): (session: { spawnedAt: number | null; meta: Record<string, unknown> }) => Promise<unknown> {
  if (typeof spawnCall.onComplete !== 'function') {
    throw new Error('Expected background spawn call to include onComplete.');
  }

  return spawnCall.onComplete as (session: {
    spawnedAt: number | null;
    meta: Record<string, unknown>;
  }) => Promise<unknown>;
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

function getGhArgs(index: number): string[] {
  const ghCall: unknown = state.ghMock.mock.calls[index]?.[0];
  if (!isStringArray(ghCall)) {
    throw new Error(`Expected gh call ${index} to have string arguments.`);
  }

  return ghCall;
}

function getGhQuery(index: number): string {
  const queryArgument = getGhArgs(index).find((argument) => argument.startsWith('query='));
  if (queryArgument === undefined) {
    throw new Error(`Expected gh call ${index} to include a GraphQL query.`);
  }

  return queryArgument.slice('query='.length);
}

function getGhVariable(index: number, variableName: string): string | undefined {
  return getGhArgs(index).find((argument) => argument.startsWith(`${variableName}=`));
}

function getGhVariableValue(index: number, variableName: string): string | undefined {
  return getGhVariable(index, variableName)?.slice(`${variableName}=`.length);
}

function getGhVariableFlag(index: number, variableName: string): string | undefined {
  const args = getGhArgs(index);
  const variableIndex = args.findIndex((argument) => argument.startsWith(`${variableName}=`));
  return variableIndex > 0 ? args[variableIndex - 1] : undefined;
}

function mockRepoSearchScope({
  viewerLogin = 'octocat',
  organizations = ['acme'],
}: {
  viewerLogin?: string;
  organizations?: string[];
} = {}): void {
  state.ghMock
    .mockResolvedValueOnce({
      stdout: JSON.stringify({ data: { viewer: { login: viewerLogin } } }),
      stderr: '',
    })
    .mockResolvedValueOnce({
      stdout: JSON.stringify({
        data: {
          viewer: {
            organizations: {
              nodes: organizations.map((login) => ({ login })),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      }),
      stderr: '',
    });
}

function mockCollaboratorSearchRepositories(repositories: string[]): void {
  state.ghMock.mockResolvedValueOnce({
    stdout: JSON.stringify({
      data: {
        viewer: {
          repositories: {
            nodes: repositories.map((nameWithOwner) => ({ nameWithOwner })),
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    }),
    stderr: '',
  });
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
    state.ghMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 43,
          title: 'Created activity title',
          url: 'https://github.com/owner/repo/issues/43',
          createdAt: '2026-01-01T00:00:01.000Z',
        },
      ]),
      stderr: '',
    });
    await expect(
      getBackgroundOnComplete(spawnCall)({
        spawnedAt: Date.parse('2026-01-01T00:00:00.000Z'),
        meta: {},
      })
    ).resolves.toEqual({
      issueNumber: 43,
      issueUrl: 'https://github.com/owner/repo/issues/43',
      issueTitle: 'Created activity title',
    });
    expect(state.ptySpawnMock).not.toHaveBeenCalled();
  }, 10_000);

  it('spawns `ship` through the background manager with `--merge` when requested', async () => {
    await loadHandlers();
    const handler = getHandler('bg-spawn-ship');

    const result = parseSessionResult(
      await handler(
        {},
        {
          repo: 'owner/repo',
          issueNumber: 42,
          merge: true,
          issueTitle: 'Ship activity title',
        }
      )
    );
    const spawnCall = parseBackgroundSpawnCall();

    expect(result.sessionId).toEqual(expect.any(String));
    expect(spawnCall.sessionId).toBe(result.sessionId);
    expect(spawnCall.command).toBe('ship');
    expect(spawnCall.repo).toBe('owner/repo');
    expect(spawnCall.commandName).toBe('shipper');
    expect(spawnCall.cwd).toBe('/tmp/repo');
    expect(spawnCall.args).toEqual(['ship', '42', '--mode', 'headless', '--merge']);
    expect(spawnCall.meta).toEqual({
      issueNumber: 42,
      merge: true,
      issueTitle: 'Ship activity title',
    });
    expect(typeof spawnCall.onComplete).toBe('function');
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
    expect(typeof spawnCall.onComplete).toBe('function');
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
    expect(spawnCall.meta).toEqual({ issueNumber: 42, merge: false });
    expect(state.ptySpawnMock).not.toHaveBeenCalled();
  });

  it('marks completed merge-requested ships as merged only when the matching PR is merged', async () => {
    await loadHandlers();
    const handler = getHandler('bg-spawn-ship');

    await handler({}, { repo: 'owner/repo', issueNumber: 42, merge: true });
    const spawnCall = parseBackgroundSpawnCall();

    state.ghMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 9,
          headRefName: 'shipper/42-activity',
          state: 'MERGED',
          mergedAt: null,
        },
      ]),
      stderr: '',
    });

    await expect(
      getBackgroundOnComplete(spawnCall)({
        spawnedAt: Date.now(),
        meta: { autoShipHalted: false },
      })
    ).resolves.toEqual({ prMerged: true });
    expect(state.ghMock).toHaveBeenCalledWith([
      'pr',
      'list',
      '-R',
      'owner/repo',
      '--state',
      'all',
      '--json',
      'number,headRefName,state,mergedAt',
      '--limit',
      '100',
    ]);
  });

  it('does not mark completed ships as merged when the PR is open or lookup fails', async () => {
    await loadHandlers();
    const handler = getHandler('bg-spawn-ship');

    await handler({}, { repo: 'owner/repo', issueNumber: 42, merge: true });
    const spawnCall = parseBackgroundSpawnCall();
    const onComplete = getBackgroundOnComplete(spawnCall);

    state.ghMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 9,
          headRefName: 'shipper/42',
          state: 'OPEN',
          mergedAt: null,
        },
      ]),
      stderr: '',
    });
    await expect(onComplete({ spawnedAt: Date.now(), meta: {} })).resolves.toEqual({});

    state.ghMock.mockRejectedValueOnce(new Error('gh failed'));
    await expect(onComplete({ spawnedAt: Date.now(), meta: {} })).resolves.toEqual({});
  });

  it('spawns `unblock` through the background manager in headless mode', async () => {
    await loadHandlers();
    const handler = getHandler('bg-spawn-unblock');

    const result = parseSessionResult(
      await handler(
        {},
        { repo: 'owner/repo', issueNumber: 42, issueTitle: 'Blocked activity title' }
      )
    );
    const spawnCall = parseBackgroundSpawnCall();

    expect(result.sessionId).toEqual(expect.any(String));
    expect(spawnCall.sessionId).toBe(result.sessionId);
    expect(spawnCall.command).toBe('unblock');
    expect(spawnCall.repo).toBe('owner/repo');
    expect(spawnCall.commandName).toBe('shipper');
    expect(spawnCall.cwd).toBe('/tmp/repo');
    expect(spawnCall.args).toEqual(['unblock', '42', '--mode', 'headless']);
    expect(spawnCall.meta).toEqual({ issueNumber: 42, issueTitle: 'Blocked activity title' });
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

  it('lists repositories through GraphQL with owner, organization, and other grouping', async () => {
    await loadHandlers();
    state.ghMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        data: {
          viewer: {
            login: 'OctoCat',
            repositories: {
              nodes: [
                {
                  nameWithOwner: 'octocat/personal-new',
                  owner: { __typename: 'User', login: 'octocat' },
                },
                null,
                {
                  nameWithOwner: 'acme/member-repo',
                  owner: {
                    __typename: 'Organization',
                    login: 'acme',
                    viewerIsAMember: true,
                    viewerCanAdminister: false,
                  },
                },
                {
                  nameWithOwner: 'beta-admin/internal-repo',
                  owner: {
                    __typename: 'Organization',
                    login: 'beta-admin',
                    viewerIsAMember: false,
                    viewerCanAdminister: true,
                  },
                },
                {
                  nameWithOwner: 'outside/private-repo',
                  owner: {
                    __typename: 'Organization',
                    login: 'outside',
                    viewerIsAMember: false,
                    viewerCanAdminister: false,
                  },
                },
                {
                  nameWithOwner: 'someone-else/read-only-repo',
                  owner: { __typename: 'User', login: 'someone-else' },
                },
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
      { nameWithOwner: 'acme/member-repo', group: 'organization', organizationLogin: 'acme' },
      {
        nameWithOwner: 'beta-admin/internal-repo',
        group: 'organization',
        organizationLogin: 'beta-admin',
      },
      { nameWithOwner: 'outside/private-repo', group: 'other' },
      { nameWithOwner: 'someone-else/read-only-repo', group: 'other' },
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
    expect(query).toContain('__typename');
    expect(query).toContain('viewerIsAMember');
    expect(query).toContain('viewerCanAdminister');
  });

  it('surfaces a descriptive error when organization owner flags are malformed', async () => {
    await loadHandlers();
    state.ghMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        data: {
          viewer: {
            login: 'octocat',
            repositories: {
              nodes: [
                {
                  nameWithOwner: 'acme/org-repo',
                  owner: {
                    __typename: 'Organization',
                    login: 'acme',
                    viewerIsAMember: true,
                  },
                },
              ],
            },
          },
        },
      }),
      stderr: '',
    });
    const handler = getHandler('list-repos');

    await expect(handler({}, undefined)).rejects.toThrow(
      /Failed to parse repository list from GitHub CLI: Expected repository list node organization viewer flags./
    );
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
      /Failed to parse repository list from GitHub CLI: GitHub GraphQL returned errors: bad query/
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

  it('searches repositories through relationship-scoped GraphQL and parses paged results', async () => {
    await loadHandlers();
    state.ghMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ data: { viewer: { login: 'OctoCat' } } }),
        stderr: '',
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: {
            viewer: {
              organizations: {
                nodes: [{ login: 'acme' }, { login: 'ACME' }],
                pageInfo: { hasNextPage: true, endCursor: 'org-cursor-1' },
              },
            },
          },
        }),
        stderr: '',
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: {
            viewer: {
              organizations: {
                nodes: [{ login: 'beta' }, null],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        }),
        stderr: '',
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: {
            search: {
              nodes: [
                {
                  nameWithOwner: 'outside/exact-match',
                  isArchived: false,
                  owner: { login: 'outside' },
                },
                null,
                {},
                {
                  nameWithOwner: 'octocat/shipper',
                  isArchived: false,
                  owner: { login: 'octocat' },
                },
                { nameWithOwner: 'acme/shipper', isArchived: false, owner: { login: 'acme' } },
                { nameWithOwner: 'acme/old', isArchived: true, owner: { login: 'acme' } },
              ],
              pageInfo: { hasNextPage: true, endCursor: 'search-cursor-1' },
            },
          },
        }),
        stderr: '',
      });
    const handler = getHandler('search-repos');

    await expect(
      handler({}, { query: 'outside/exact-match user:public archived:true', cursor: null })
    ).resolves.toEqual({
      repositories: [
        { nameWithOwner: 'outside/exact-match', group: 'other' },
        { nameWithOwner: 'octocat/shipper', group: 'owner' },
        { nameWithOwner: 'acme/shipper', group: 'other' },
      ],
      pageInfo: { hasNextPage: true, endCursor: 'search-cursor-1' },
    });

    expect(getGhVariable(1, 'limit')).toBe('limit=100');
    expect(getGhVariable(1, 'cursor')).toBeUndefined();
    expect(getGhVariable(2, 'cursor')).toBe('cursor=org-cursor-1');
    expect(getGhVariable(3, 'limit')).toBe('limit=100');

    const organizationQuery = getGhQuery(1);
    expect(organizationQuery).toContain('viewer');
    expect(organizationQuery).toContain('organizations(first: $limit, after: $cursor)');

    const searchQueryVariable = getGhVariable(3, 'searchQuery');
    expect(searchQueryVariable).toContain('outside exact-match userpublic archivedtrue');
    expect(searchQueryVariable).toContain('in:name');
    expect(searchQueryVariable).toContain('archived:false');
    expect(searchQueryVariable).toContain('fork:true');
    expect(searchQueryVariable).toContain('user:OctoCat');
    expect(searchQueryVariable).toContain('org:acme');
    expect(searchQueryVariable).toContain('org:beta');
    expect(searchQueryVariable).not.toContain('user:public');
    expect(searchQueryVariable).not.toContain('archived:true');
    expect(getGhVariableValue(3, 'searchQuery')?.length).toBeLessThanOrEqual(256);
    expect(getGhVariableFlag(3, 'searchQuery')).toBe('-f');
  });

  it('splits repository search scope into bounded GitHub query chunks', async () => {
    await loadHandlers();
    mockRepoSearchScope({
      organizations: ['a'.repeat(190), 'b'.repeat(190)],
    });
    state.ghMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: {
            search: {
              nodes: [
                {
                  nameWithOwner: 'octocat/shipper',
                  isArchived: false,
                  owner: { login: 'octocat' },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
        stderr: '',
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: {
            search: {
              nodes: [
                {
                  nameWithOwner: `${'b'.repeat(190)}/shipper`,
                  isArchived: false,
                  owner: { login: 'b'.repeat(190) },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
        stderr: '',
      });
    const handler = getHandler('search-repos');

    await expect(handler({}, { query: 'shipper', cursor: null })).resolves.toMatchObject({
      repositories: [
        { nameWithOwner: 'octocat/shipper', group: 'owner' },
        { nameWithOwner: `${'b'.repeat(190)}/shipper`, group: 'other' },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    });

    expect(getGhVariableValue(2, 'searchQuery')?.length).toBeLessThanOrEqual(256);
    expect(getGhVariableValue(3, 'searchQuery')?.length).toBeLessThanOrEqual(256);
  });

  it('merges exact collaborator repository matches only for valid owner/repo queries', async () => {
    await loadHandlers();
    mockRepoSearchScope({ organizations: [] });
    state.ghMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        data: {
          search: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
      stderr: '',
    });
    mockCollaboratorSearchRepositories(['outside/exact-match', 'outside/other']);
    const handler = getHandler('search-repos');

    await expect(handler({}, { query: 'outside/exact-match', cursor: null })).resolves.toEqual({
      repositories: [{ nameWithOwner: 'outside/exact-match', group: 'other' }],
      pageInfo: { hasNextPage: false, endCursor: null },
    });

    const collaboratorQuery = getGhQuery(3);
    expect(collaboratorQuery).toContain('affiliations: [COLLABORATOR]');
    expect(collaboratorQuery).toContain('isArchived: false');
  });

  it('passes load-more cursors to repository search without merging collaborator exact matches', async () => {
    await loadHandlers();
    mockRepoSearchScope();
    state.ghMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        data: {
          search: {
            nodes: [
              { nameWithOwner: 'acme/next-page', isArchived: false, owner: { login: 'acme' } },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
      stderr: '',
    });
    const handler = getHandler('search-repos');

    await expect(
      handler({}, { query: 'outside/exact-match', cursor: 'search-cursor-1' })
    ).resolves.toEqual({
      repositories: [{ nameWithOwner: 'acme/next-page', group: 'other' }],
      pageInfo: { hasNextPage: false, endCursor: null },
    });

    expect(getGhVariable(2, 'cursor')).toBe('cursor=search-cursor-1');
    expect(getGhVariableFlag(2, 'cursor')).toBe('-f');
  });

  it('returns an empty page for blank repository search queries', async () => {
    await loadHandlers();
    const handler = getHandler('search-repos');

    await expect(handler({}, { query: '   ', cursor: null })).resolves.toEqual({
      repositories: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    });
    expect(state.ghMock).not.toHaveBeenCalled();
  });

  it('rejects malformed repository search payloads', async () => {
    await loadHandlers();
    const handler = getHandler('search-repos');

    await expect(handler({}, { query: 'shipper', cursor: 42 })).rejects.toThrow(
      'Invalid repository search payload.'
    );
    await expect(handler({}, { cursor: null })).rejects.toThrow(
      'Invalid repository search payload.'
    );
  });

  it('surfaces descriptive repository search parser errors', async () => {
    await loadHandlers();
    mockRepoSearchScope();
    state.ghMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        data: {
          search: {
            nodes: [{ nameWithOwner: 'octocat/shipper', isArchived: false, owner: null }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
      stderr: '',
    });
    const handler = getHandler('search-repos');

    await expect(handler({}, { query: 'shipper', cursor: null })).rejects.toThrow(
      /Failed to parse repository search result from GitHub CLI: Expected repository search result node owner./
    );
  });

  it('surfaces descriptive repository search scope parser errors', async () => {
    await loadHandlers();
    state.ghMock.mockResolvedValueOnce({
      stdout: JSON.stringify({ data: { viewer: { login: 'octocat' } } }),
      stderr: '',
    });
    state.ghMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        data: {
          viewer: {
            organizations: {
              nodes: [{ login: 42 }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      }),
      stderr: '',
    });
    const handler = getHandler('search-repos');

    await expect(handler({}, { query: 'shipper', cursor: null })).rejects.toThrow(
      /Failed to parse repository search organizations from GitHub CLI: Expected repository search organization login./
    );
  });

  it('resets failed repository search scope initialization so later searches can retry', async () => {
    await loadHandlers();
    state.ghMock.mockRejectedValueOnce(new Error('viewer failed'));
    mockRepoSearchScope();
    state.ghMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        data: {
          search: {
            nodes: [
              { nameWithOwner: 'octocat/shipper', isArchived: false, owner: { login: 'octocat' } },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
      stderr: '',
    });
    const handler = getHandler('search-repos');

    await expect(handler({}, { query: 'shipper', cursor: null })).rejects.toThrow('viewer failed');
    await expect(handler({}, { query: 'shipper', cursor: null })).resolves.toEqual({
      repositories: [{ nameWithOwner: 'octocat/shipper', group: 'owner' }],
      pageInfo: { hasNextPage: false, endCursor: null },
    });

    expect(state.ghMock).toHaveBeenCalledTimes(4);
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

  it('destroys both the PTY and background managers when the window closes with no live workflow sessions', async () => {
    await loadHandlers();

    state.browserWindowEventHandlers.get('close')?.({ preventDefault: vi.fn() });

    expect(state.ptyDestroyAllMock).toHaveBeenCalledTimes(1);
    expect(state.backgroundDestroyAllMock).toHaveBeenCalledTimes(1);
  });

  it('cancels app close when live workflow quit confirmation is canceled', async () => {
    await loadHandlers();
    const preventDefault = vi.fn();
    state.ptyListLiveWorkflowSessionsMock.mockReturnValueOnce([
      { sessionId: 'pty-1', label: 'groom — #42', kind: 'groom', status: 'running' },
    ]);
    state.dialogShowMessageBoxMock.mockResolvedValueOnce({ response: 1 });

    state.browserWindowEventHandlers.get('close')?.({ preventDefault });
    await flushMicrotasks();

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(state.dialogShowMessageBoxMock).toHaveBeenCalledTimes(1);
    expect(state.ptyCloseLiveWorkflowSessionsForQuitMock).not.toHaveBeenCalled();
    expect(state.backgroundDestroyAllMock).not.toHaveBeenCalled();
    expect(state.browserWindowCloseMock).not.toHaveBeenCalled();
  });

  it('drains live workflow sessions and retries close after quit confirmation', async () => {
    await loadHandlers();
    const preventDefault = vi.fn();
    state.ptyListLiveWorkflowSessionsMock.mockReturnValueOnce([
      { sessionId: 'pty-1', label: 'groom — #42', kind: 'groom', status: 'running' },
      { sessionId: 'pty-2', label: 'setup — owner/repo', kind: 'setup', status: 'running' },
    ]);
    state.dialogShowMessageBoxMock.mockResolvedValueOnce({ response: 0 });

    state.browserWindowEventHandlers.get('close')?.({ preventDefault });
    await flushMicrotasks();

    expect(preventDefault).toHaveBeenCalledTimes(1);
    const dialogOptions = state.dialogShowMessageBoxMock.mock.calls[0]?.[1] as
      | { detail?: string }
      | undefined;
    expect(dialogOptions?.detail).toContain('groom — #42');
    expect(dialogOptions?.detail).toContain('setup — owner/repo');
    expect(state.ptyCloseLiveWorkflowSessionsForQuitMock).toHaveBeenCalledTimes(1);
    expect(state.backgroundDestroyAllMock).toHaveBeenCalledTimes(1);
    expect(state.browserWindowCloseMock).toHaveBeenCalledTimes(1);
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

  it('spawns groom through the CLI orchestrator in the cloned repo', async () => {
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
    expect(state.ensureRepoCloneMock).toHaveBeenCalledWith('owner/repo');
    expect(state.ptySpawnMock).toHaveBeenCalledWith(
      expect.any(String),
      'shipper',
      ['groom', '42', '--mode', 'interactive'],
      expect.objectContaining({
        cols: 120,
        rows: 40,
        cwd: '/tmp/repo',
        kind: 'groom',
        label: 'groom — #42',
        repo: 'owner/repo',
        issueNumber: 42,
      })
    );
    const spawnOptions = state.ptySpawnMock.mock.calls[0]?.[3] as
      | { env?: Record<string, string>; controlDir?: string }
      | undefined;
    expect(typeof spawnOptions?.controlDir).toBe('string');
    expect(spawnOptions?.env?.SHIPPER_DESKTOP_CONTROL_DIR).toBe(spawnOptions?.controlDir);
    expect(state.buildPromptCommandMock).not.toHaveBeenCalled();
    expect(state.createDesktopGroomWorktreeMock).not.toHaveBeenCalled();
    expect(state.acquireIssueLockMock).not.toHaveBeenCalled();
    expect(state.releaseIssueLockMock).not.toHaveBeenCalled();
  });

  it('allows different issues in the same repo to spawn groom CLI PTYs in the clone', async () => {
    await loadHandlers();
    const handler = getHandler('pty-spawn-shipper-groom');

    await handler({}, { repo: 'owner/repo', issueNumber: 42, cols: 120, rows: 40 });
    await handler({}, { repo: 'owner/repo', issueNumber: 43, cols: 120, rows: 40 });

    expect(state.ptySpawnMock).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      'shipper',
      ['groom', '42', '--mode', 'interactive'],
      expect.objectContaining({ cwd: '/tmp/repo' })
    );
    expect(state.ptySpawnMock).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      'shipper',
      ['groom', '43', '--mode', 'interactive'],
      expect.objectContaining({ cwd: '/tmp/repo' })
    );
    expect(state.ensureRepoCloneMock).toHaveBeenCalledTimes(2);
    expect(state.ensureRepoCloneForWorktreeMock).not.toHaveBeenCalled();
    expect(getPtySpawnCwds()).toEqual(['/tmp/repo', '/tmp/repo']);
  });

  it('serializes groom clone preparation per repo without blocking active groom sessions', async () => {
    await loadHandlers();
    const firstClone = deferred<string>();
    state.ensureRepoCloneMock
      .mockReturnValueOnce(firstClone.promise)
      .mockResolvedValueOnce('/tmp/repo');
    const handler = getHandler('pty-spawn-shipper-groom');

    const first = handler({}, { repo: 'owner/repo', issueNumber: 42, cols: 120, rows: 40 });
    await flushMicrotasks();
    const second = handler({}, { repo: 'owner/repo', issueNumber: 43, cols: 120, rows: 40 });
    await flushMicrotasks();

    expect(state.ensureRepoCloneMock).toHaveBeenCalledTimes(1);
    firstClone.resolve('/tmp/repo');

    await first;
    await second;

    expect(state.ensureRepoCloneMock).toHaveBeenCalledTimes(2);
    expect(getPtySpawnCwds()).toEqual(['/tmp/repo', '/tmp/repo']);
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
      kind: 'setup',
      label: 'setup — owner/repo',
      repo: 'owner/repo',
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
      kind: 'setup',
      label: 'setup — owner/repo',
      repo: 'owner/repo',
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

  it('allows groom and setup for the same repo to run in the same clone path', async () => {
    await loadHandlers();
    const groomHandler = getHandler('pty-spawn-shipper-groom');
    const setupHandler = getHandler('pty-spawn-shipper-setup');

    await groomHandler({}, { repo: 'owner/repo', issueNumber: 42, cols: 120, rows: 40 });
    await setupHandler({}, { repo: 'owner/repo', cols: 120, rows: 40 });

    expect(state.ensureRepoCloneForWorktreeMock).not.toHaveBeenCalled();
    expect(state.ensureRepoCloneMock).toHaveBeenCalledTimes(2);
    expect(getPtySpawnCwds()).toEqual(['/tmp/repo', '/tmp/repo']);
  });

  it('serializes groom and setup canonical repo preparation for the same repo', async () => {
    await loadHandlers();
    const firstClone = deferred<string>();
    state.ensureRepoCloneMock
      .mockReturnValueOnce(firstClone.promise)
      .mockResolvedValueOnce('/tmp/repo');
    const groomHandler = getHandler('pty-spawn-shipper-groom');
    const setupHandler = getHandler('pty-spawn-shipper-setup');

    const groom = groomHandler({}, { repo: 'owner/repo', issueNumber: 42, cols: 120, rows: 40 });
    await flushMicrotasks();
    const setup = setupHandler({}, { repo: 'owner/repo', cols: 120, rows: 40 });
    await flushMicrotasks();

    expect(state.ensureRepoCloneMock).toHaveBeenCalledTimes(1);
    expect(state.createDesktopGroomWorktreeMock).not.toHaveBeenCalled();
    firstClone.resolve('/tmp/repo');

    await groom;
    await setup;

    expect(state.ensureRepoCloneMock).toHaveBeenCalledTimes(2);
    expect(getPtySpawnCwds()).toEqual(['/tmp/repo', '/tmp/repo']);
  });

  it('does not start groom when clone preparation fails before PTY spawn', async () => {
    await loadHandlers();
    const handler = getHandler('pty-spawn-shipper-groom');
    state.ensureRepoCloneMock.mockRejectedValueOnce(new Error('clone failed'));

    await expect(
      handler({}, { repo: 'owner/repo', issueNumber: 42, cols: 120, rows: 40 })
    ).rejects.toThrow('clone failed');
    expect(state.ensureRepoCloneForWorktreeMock).not.toHaveBeenCalled();
    expect(state.createDesktopGroomWorktreeMock).not.toHaveBeenCalled();
    expect(state.ptySpawnMock).not.toHaveBeenCalled();
  });

  it('forwards explicit PTY lifecycle IPC handlers', async () => {
    await loadHandlers();

    await expect(getHandler('pty-close-state')({}, { sessionId: 'pty-1' })).resolves.toEqual({
      state: 'finalizable',
    });
    await getHandler('pty-finalize')({}, { sessionId: 'pty-1' });
    getHandler('pty-force-kill')({}, { sessionId: 'pty-1' });

    expect(state.ptyGetCloseStateMock).toHaveBeenCalledWith('pty-1');
    expect(state.ptyFinalizeMock).toHaveBeenCalledWith('pty-1');
    expect(state.ptyForceKillMock).toHaveBeenCalledWith('pty-1');
  });

  it('validates explicit PTY lifecycle IPC payloads', async () => {
    await loadHandlers();

    await expect(getHandler('pty-close-state')({}, { sessionId: 1 })).rejects.toThrow(
      'Invalid pty-close-state payload.'
    );
    await expect(getHandler('pty-finalize')({}, null)).rejects.toThrow(
      'Invalid pty-finalize payload.'
    );
    expect(() => getHandler('pty-force-kill')({}, {})).toThrow('Invalid pty-force-kill payload.');
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
        'search-repos',
        'pause-state:list',
        'pause-state:add',
        'pause-state:remove',
        'set-config',
        'pty-spawn-shipper-groom',
        'pty-spawn-shipper-setup',
        'pty-write',
        'pty-resize',
        'pty-close-state',
        'pty-finalize',
        'pty-force-kill',
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
