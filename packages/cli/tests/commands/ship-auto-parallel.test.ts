import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const forkMock = vi.fn();

vi.mock('node:child_process', () => ({
  fork: forkMock,
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock('node:os', () => ({
  homedir: () => '/mock-home',
}));

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
}));

const loggerLogMock = vi.fn<(message: string) => void>();
const selectNextCandidateMock =
  vi.fn<
    (
      repo: string,
      skippedIssues: Set<number>,
      activeIssues?: ReadonlySet<number>
    ) => Promise<{ number: number; title: string } | null>
  >();
const selectBlockedIssuesMock =
  vi.fn<(repo: string) => Promise<Array<{ number: number; title: string }>>>();
const attemptUnblockMock =
  vi.fn<
    (
      repo: string,
      issue: string,
      agent?: string,
      model?: string,
      logFile?: string
    ) => Promise<boolean>
  >();
const printUnblockSummaryMock = vi.fn<(attempts: unknown[], homeDir: string) => void>();
const resolveIssueTotalTokensMock =
  vi.fn<(repo: string, issue: string) => Promise<number | undefined>>();
const releaseIssueLockMock = vi.fn<(repo: string, issue: string) => Promise<void>>();

vi.mock('@dnsquared/shipper-core', () => ({
  logger: {
    log: loggerLogMock,
    warn: vi.fn(),
    error: vi.fn(),
  },
  releaseIssueLock: releaseIssueLockMock,
}));

vi.mock('../../src/commands/ship-candidates.js', () => ({
  selectNextCandidate: selectNextCandidateMock,
  selectBlockedIssues: selectBlockedIssuesMock,
  attemptUnblock: attemptUnblockMock,
  printUnblockSummary: printUnblockSummaryMock,
}));

vi.mock('../../src/commands/ship-execute.js', () => ({
  shipOneIssue: vi.fn(),
  formatLogDisplayPath: (logFile: string, homeDir = '/mock-home') =>
    logFile.startsWith(homeDir) ? `~${logFile.slice(homeDir.length)}` : logFile,
  formatLogTimestamp: () => '20260418T120000',
  resolveIssueTotalTokens: resolveIssueTotalTokensMock,
}));

vi.mock('../../src/commands/ship-merge.js', () => ({
  isRetriableMergeFailure: () => false,
}));

class MockForkChild extends EventEmitter {
  send = vi.fn();
  kill = vi.fn<(signal?: string) => void>();
  exitCode: number | null = null;
  signalCode: string | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('shipAutoParallel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    selectBlockedIssuesMock.mockResolvedValue([]);
    selectNextCandidateMock
      .mockResolvedValueOnce({ number: 1, title: 'First issue' })
      .mockResolvedValueOnce({ number: 2, title: 'Second issue' })
      .mockResolvedValue(null);
    attemptUnblockMock.mockResolvedValue(false);
    resolveIssueTotalTokensMock.mockResolvedValue(undefined);
  });

  it('forks one worker per active issue and exchanges only IPC messages', async () => {
    const childOne = new MockForkChild();
    const childTwo = new MockForkChild();
    forkMock.mockReturnValueOnce(childOne).mockReturnValueOnce(childTwo);

    const { shipAutoParallel } = await import('../../src/commands/ship-auto.js');
    const runPromise = shipAutoParallel('owner/repo', 2, 'codex', 'gpt-5');

    await flushMicrotasks();

    expect(forkMock).toHaveBeenCalledTimes(2);
    const firstForkOptions = forkMock.mock.calls[0]?.[2] as { env?: Record<string, string> };
    expect(firstForkOptions).toEqual(
      expect.objectContaining({
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      })
    );
    expect(firstForkOptions.env).toBeUndefined();
    expect(childOne.send).toHaveBeenCalledWith({
      type: 'run',
      repo: 'owner/repo',
      issue: '1',
      agent: 'codex',
      model: 'gpt-5',
      logFile: '/mock-home/.shipper/logs/ship-1-20260418T120000.log',
    });
    expect(childTwo.send).toHaveBeenCalledWith({
      type: 'run',
      repo: 'owner/repo',
      issue: '2',
      agent: 'codex',
      model: 'gpt-5',
      logFile: '/mock-home/.shipper/logs/ship-2-20260418T120000.log',
    });

    childOne.emit('message', { type: 'result', success: false, error: 'boom' });
    childOne.exitCode = 1;
    childOne.emit('close', 1, null);

    await flushMicrotasks();

    childTwo.emit('message', { type: 'result', success: true });
    childTwo.exitCode = 0;
    childTwo.emit('close', 0, null);

    await runPromise;

    expect(loggerLogMock).toHaveBeenCalledWith('[#1] ✗ fail');
    expect(loggerLogMock).toHaveBeenCalledWith('[#2] ✓ pass');
    expect(process.exitCode).toBe(1);
  });

  it('preserves fault isolation when one parallel slot fails', async () => {
    const childOne = new MockForkChild();
    const childTwo = new MockForkChild();
    forkMock.mockReturnValueOnce(childOne).mockReturnValueOnce(childTwo);

    const { shipAutoParallel } = await import('../../src/commands/ship-auto.js');
    const runPromise = shipAutoParallel('owner/repo', 2);

    await flushMicrotasks();

    childOne.emit('message', { type: 'result', success: false, error: 'slot one failed' });
    childOne.exitCode = 1;
    childOne.emit('close', 1, null);

    await flushMicrotasks();
    expect(childTwo.kill).not.toHaveBeenCalled();

    childTwo.emit('message', { type: 'result', success: true });
    childTwo.exitCode = 0;
    childTwo.emit('close', 0, null);

    await runPromise;

    expect(releaseIssueLockMock).not.toHaveBeenCalled();
    expect(loggerLogMock).toHaveBeenCalledWith('[#2] ✓ pass');
  });

  it('resolves the worker beside the bundled entrypoint', async () => {
    const { resolveWorkerPath } = await import('../../src/commands/ship-auto.js');

    expect(
      resolveWorkerPath(
        '/repo/packages/cli/dist/index.js',
        'file:///repo/packages/cli/dist/index.js'
      )
    ).toBe('/repo/packages/cli/dist/ship-worker.js');
    expect(
      resolveWorkerPath(
        '/repo/packages/cli/src/index.ts',
        'file:///repo/packages/cli/src/commands/ship-auto.ts'
      )
    ).toBe('/repo/packages/cli/src/ship-worker.ts');
  });
});
