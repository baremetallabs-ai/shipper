import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakeCore } from '../_harness/fake-core.js';

const {
  forkMock,
  mkdirSyncMock,
  selectNextCandidateMock,
  selectBlockedIssuesMock,
  attemptUnblockMock,
  printUnblockSummaryMock,
  resolveIssueTotalTokensMock,
} = vi.hoisted(() => ({
  forkMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  selectNextCandidateMock: vi.fn(),
  selectBlockedIssuesMock: vi.fn(),
  attemptUnblockMock: vi.fn(),
  printUnblockSummaryMock: vi.fn(),
  resolveIssueTotalTokensMock: vi.fn(),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    fork: forkMock,
    spawn: vi.fn(),
    spawnSync: vi.fn(),
  };
});

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: () => '/mock-home',
  };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    mkdirSync: mkdirSyncMock,
  };
});

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

// fakeCore cannot cross process boundaries, so this narrow fork seam models only the
// documented parent↔child IPC contract without mocking the core package wholesale.
class MockForkChild extends EventEmitter {
  send = vi.fn();
  kill = vi.fn<(signal?: string) => void>();
  exitCode: number | null = null;
  signalCode: string | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

type FakeCore = ReturnType<typeof createFakeCore>;

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('shipAutoParallel', () => {
  let fake: FakeCore;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fake = createFakeCore();
    fake.install();
    vi.clearAllMocks();
    vi.useFakeTimers();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.exitCode = undefined;
    selectBlockedIssuesMock.mockResolvedValue([]);
    selectNextCandidateMock
      .mockResolvedValueOnce({ number: 1, title: 'First issue' })
      .mockResolvedValueOnce({ number: 2, title: 'Second issue' })
      .mockResolvedValue(null);
    attemptUnblockMock.mockResolvedValue(false);
    resolveIssueTotalTokensMock.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    process.exitCode = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
    await fake.dispose();
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

    expect(logSpy).toHaveBeenCalledWith('[shipper] [#1] ✗ fail');
    expect(logSpy).toHaveBeenCalledWith('[shipper] [#2] ✓ pass');
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

    expect(fake.state.labelTransitions).toEqual([]);
    expect(logSpy).toHaveBeenCalledWith('[shipper] [#2] ✓ pass');
  });

  it('kills active workers, releases locks, and exits non-zero on SIGINT', async () => {
    const childOne = new MockForkChild();
    const childTwo = new MockForkChild();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    fake.setIssue('1', { labels: ['shipper:locked'] });
    fake.setIssue('2', { labels: ['shipper:locked'] });

    childOne.kill.mockImplementation((signal?: string) => {
      if (signal === 'SIGKILL') {
        void Promise.resolve().then(() => {
          childOne.signalCode = 'SIGKILL';
          childOne.emit('close', null, 'SIGKILL');
        });
      }
    });
    childTwo.kill.mockImplementation((signal?: string) => {
      if (signal === 'SIGKILL') {
        void Promise.resolve().then(() => {
          childTwo.signalCode = 'SIGKILL';
          childTwo.emit('close', null, 'SIGKILL');
        });
      }
    });
    forkMock.mockReturnValueOnce(childOne).mockReturnValueOnce(childTwo);

    const { shipAutoParallel } = await import('../../src/commands/ship-auto.js');
    const runPromise = shipAutoParallel('owner/repo', 2);

    await flushMicrotasks();
    process.emit('SIGINT');
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3000);
    await flushMicrotasks();
    await runPromise;

    expect(childOne.kill).toHaveBeenCalledWith('SIGINT');
    expect(childTwo.kill).toHaveBeenCalledWith('SIGINT');
    expect(childOne.kill).toHaveBeenCalledWith('SIGKILL');
    expect(childTwo.kill).toHaveBeenCalledWith('SIGKILL');
    expect(fake.state.labelTransitions).toEqual(
      expect.arrayContaining([
        { target: 'issue', number: '1', add: [], remove: ['shipper:locked'] },
        { target: 'issue', number: '2', add: [], remove: ['shipper:locked'] },
      ])
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
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
