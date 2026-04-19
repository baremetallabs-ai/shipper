import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakeCore } from '../_harness/fake-core.js';

const {
  spawnMock,
  forkMock,
  mkdirSyncMock,
  selectNextCandidateMock,
  selectBlockedIssuesMock,
  attemptUnblockMock,
  printUnblockSummaryMock,
  shipOneIssueMock,
} = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  forkMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  selectNextCandidateMock: vi.fn(),
  selectBlockedIssuesMock: vi.fn(),
  attemptUnblockMock: vi.fn(),
  printUnblockSummaryMock: vi.fn(),
  shipOneIssueMock: vi.fn(),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: spawnMock,
    fork: forkMock,
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
  shipOneIssue: shipOneIssueMock,
  formatLogDisplayPath: (logFile: string, homeDir = '/mock-home') =>
    logFile.startsWith(homeDir) ? `~${logFile.slice(homeDir.length)}` : logFile,
  formatLogTimestamp: () => '20260418T120000',
  resolveIssueTotalTokens: vi.fn(),
}));

type FakeCore = ReturnType<typeof createFakeCore>;

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('shipAutoSequential', () => {
  let fake: FakeCore;

  beforeEach(() => {
    fake = createFakeCore();
    fake.install();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    process.exitCode = undefined;
    selectBlockedIssuesMock.mockResolvedValue([]);
    selectNextCandidateMock.mockResolvedValue(null);
    attemptUnblockMock.mockResolvedValue(false);
    shipOneIssueMock.mockResolvedValue({ success: true });
  });

  afterEach(async () => {
    process.exitCode = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
    await fake.dispose();
  });

  it('parks one issue, runs the next issue, and resumes when ready without spawning', async () => {
    const events: string[] = [];
    let parkedReady = false;

    selectNextCandidateMock
      .mockResolvedValueOnce({ number: 1, title: 'First issue' })
      .mockResolvedValueOnce({ number: 2, title: 'Second issue' })
      .mockResolvedValue(null);

    shipOneIssueMock.mockImplementation(async (options: { issue: string; parkHooks?: unknown }) => {
      events.push(`start:${options.issue}`);
      if (options.issue === '1') {
        await new Promise<void>((resolve) => {
          (
            options.parkHooks as
              | {
                  park: (request: {
                    readyCheck: () => Promise<boolean>;
                    resume: () => void;
                  }) => void;
                }
              | undefined
          )?.park({
            readyCheck: () => Promise.resolve(parkedReady),
            resume: () => {
              events.push('resume:1');
              resolve();
            },
          });
        });
      }
      events.push(`finish:${options.issue}`);
      return { success: true };
    });

    const { shipAutoSequential } = await import('../../src/commands/ship-auto.js');
    const runPromise = shipAutoSequential('owner/repo');

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    expect(events).toContain('start:1');
    expect(events).toContain('start:2');
    expect(events).toContain('finish:2');
    expect(spawnMock).not.toHaveBeenCalled();
    expect(forkMock).not.toHaveBeenCalled();

    parkedReady = true;
    await vi.advanceTimersByTimeAsync(20_000);
    await runPromise;

    expect(events).toEqual(['start:1', 'start:2', 'finish:2', 'resume:1', 'finish:1']);
  });

  it('breaks parked waiting promptly on SIGINT and exits non-zero', async () => {
    selectNextCandidateMock
      .mockResolvedValueOnce({ number: 1, title: 'Parked issue' })
      .mockResolvedValue(null);

    shipOneIssueMock.mockImplementation(async (options: { parkHooks?: unknown }) => {
      (
        options.parkHooks as
          | {
              park: (request: { readyCheck: () => Promise<boolean>; resume: () => void }) => void;
            }
          | undefined
      )?.park({
        readyCheck: () => Promise.resolve(false),
        resume: () => undefined,
      });
      return await new Promise(() => undefined);
    });

    const { shipAutoSequential } = await import('../../src/commands/ship-auto.js');
    const runPromise = shipAutoSequential('owner/repo');

    await flushMicrotasks();
    process.emit('SIGINT');
    await runPromise;

    expect(process.exitCode).toBe(1);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(forkMock).not.toHaveBeenCalled();
  });
});
