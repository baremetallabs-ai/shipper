import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
const forkMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  fork: forkMock,
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
const shipOneIssueMock =
  vi.fn<
    (options: {
      repo: string;
      issue: string;
      merge: boolean;
      logFile?: string;
      agent?: string;
      model?: string;
      collectTokens?: boolean;
      skipInteractiveStages?: boolean;
      parkHooks?: unknown;
    }) => Promise<{ success: boolean }>
  >();

vi.mock('@dnsquared/shipper-core', () => ({
  logger: {
    log: loggerLogMock,
    warn: vi.fn(),
    error: vi.fn(),
  },
  releaseIssueLock: vi.fn(),
}));

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

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('shipAutoSequential', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    process.exitCode = undefined;
    selectBlockedIssuesMock.mockResolvedValue([]);
    selectNextCandidateMock.mockResolvedValue(null);
    attemptUnblockMock.mockResolvedValue(false);
    shipOneIssueMock.mockResolvedValue({ success: true });
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
