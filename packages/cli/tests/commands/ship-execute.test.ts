import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { toError, toErrorMessage } from '../../../core/src/lib/errors.js';
import { parseIssueTitleLabelsList, parseQueuedPrList } from '../../../core/src/lib/gh-schemas.js';

const fsMockState = vi.hoisted(() => ({
  capturedLogs: new Map<string, string>(),
  mockCreateWriteStream: vi.fn(),
  mockMkdirSync: vi.fn(),
}));

const osMockState = vi.hoisted(() => ({
  mockHomedir: vi.fn(() => '/mock-home'),
}));
const lockState = vi.hoisted(() => ({
  lockedIssues: new Set<string>(),
}));
const getSettingsMock = vi.hoisted(() =>
  vi.fn<
    () => {
      prReviewWait:
        | { mode: 'timer'; durationMinutes: number }
        | { mode: 'checks'; minDurationMinutes?: number; maxDurationMinutes?: number };
    }
  >(() => ({
    prReviewWait: { mode: 'checks', maxDurationMinutes: 30 },
  }))
);
const resolveModeMock = vi.hoisted(() =>
  vi.fn<
    (
      step: string,
      override?: 'headless' | 'interactive' | 'default'
    ) => 'headless' | 'interactive' | 'default'
  >((_step: string, override?: 'headless' | 'interactive' | 'default') => override ?? 'default')
);
type MockCheck = { name: string; state: string; bucket: string };
type MockCandidate = { number: number; title: string; priority: 0 | 1 | 2 };
type ReadyCheck = () => Promise<boolean>;

const handleAgentCrashMock = vi.hoisted(() =>
  vi.fn<
    (repo: string, issue: string, stage: string, detail: string, summary?: string) => Promise<void>
  >(() => Promise.resolve())
);
const buildReadyCheckMock = vi.hoisted(() =>
  vi.fn<(repo: string, pr: string) => Promise<ReadyCheck>>()
);
const executeMergeMock = vi.hoisted(() =>
  vi.fn<
    (options: {
      pr: { number: number; title: string; headRefName: string; baseRefName: string };
      issueNumber: number;
      nwo: string;
      treatPendingChecksAsFailure: boolean;
    }) => Promise<boolean>
  >(() => Promise.resolve(true))
);
const postMergeMock = vi.hoisted(() =>
  vi.fn<
    (_pr: unknown, issueNumber: number | string, repo: string, dryRun: boolean) => Promise<void>
  >(() => Promise.resolve())
);
const pollPrMergedMock = vi.hoisted(() =>
  vi.fn<(prNumber: number, repo: string) => Promise<boolean>>(() => Promise.resolve(false))
);
const prepareUnblockContextMock = vi.hoisted(() =>
  vi.fn<(repo: string, issue: string, cwd: string) => Promise<void>>(() => Promise.resolve())
);
const sleepMsMock = vi.hoisted(() => vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve()));
const processResultMock = vi.hoisted(() =>
  vi.fn<
    (result?: {
      issueNumber?: string;
      stage?: string;
    }) => Promise<{ verdict: 'accept'; comment: string }>
  >(() => {
    return Promise.resolve({ verdict: 'accept', comment: '.shipper/output/comment-7.md' });
  })
);
const labelFixtures = vi.hoisted(() => ({
  stageLabelNames: [
    'shipper:new',
    'shipper:groomed',
    'shipper:designed',
    'shipper:planned',
    'shipper:implemented',
    'shipper:pr-open',
    'shipper:pr-reviewed',
    'shipper:ready',
  ],
  stageNameMap: {
    'shipper:new': 'groom',
    'shipper:groomed': 'design',
    'shipper:designed': 'plan',
    'shipper:planned': 'implement',
    'shipper:implemented': 'pr open',
    'shipper:pr-open': 'pr review',
    'shipper:pr-reviewed': 'pr remediate',
    'shipper:ready': 'ready',
  },
}));

vi.mock('../../src/commands/pr-remediate.js', () => ({
  buildReadyCheck: (repo: string, pr: string) => buildReadyCheckMock(repo, pr),
  SKIP_PR_REMEDIATE_WAIT_ENV_VAR: 'SHIPPER_SKIP_PR_REMEDIATE_WAIT',
}));

vi.mock('../../src/commands/merge.js', () => ({
  postMerge: (_pr: unknown, issueNumber: number | string, repo: string, dryRun: boolean) =>
    postMergeMock(_pr, issueNumber, repo, dryRun),
  pollPrMerged: (prNumber: number, repo: string) => pollPrMergedMock(prNumber, repo),
}));

vi.mock('../../src/commands/unblock.js', () => ({
  prepareUnblockContext: (repo: string, issue: string, cwd: string) =>
    prepareUnblockContextMock(repo, issue, cwd),
}));

import { shipCommand } from '../../src/commands/ship.js';
import { STAGE_NAME } from '../../src/commands/ship-execute.js';

vi.mock('@dnsquared/shipper-core', () => ({
  ...(() => {
    const writeToStream = (
      stream:
        | { destroyed?: boolean; writableEnded?: boolean; write?: (chunk: string) => void }
        | undefined,
      line: string
    ) => {
      if (!stream || stream.destroyed || stream.writableEnded) {
        return;
      }
      stream.write?.(`${line}\n`);
    };

    const createMockLogger = (stream?: {
      destroyed?: boolean;
      writableEnded?: boolean;
      write?: (chunk: string) => void;
    }) => ({
      log: (message: string) => {
        const line = `[shipper] ${message}`;
        console.log(line);
        writeToStream(stream, line);
      },
      warn: (message: string) => {
        const line = `[shipper] ${message}`;
        console.warn(line);
        writeToStream(stream, line);
      },
      error: (message: string) => {
        const line = `[shipper] ${message}`;
        console.error(line);
        writeToStream(stream, line);
      },
    });

    return {
      logger: createMockLogger(),
      createLogger: ({ stream }: { stream?: { write?: (chunk: string) => void } } = {}) =>
        createMockLogger(stream),
    };
  })(),
  toError,
  toErrorMessage,
  selectIssuesForStage: vi.fn<
    (
      _repo: string,
      _label: string,
      _staleLocked?: Set<number>,
      _options?: { skipTimeline?: boolean }
    ) => Promise<MockCandidate[]>
  >(() => Promise.resolve([])),
  clearStaleLockIfNeeded: vi.fn<
    (repo: string, issueNumber: string, staleLocked: Set<number>) => Promise<void>
  >(() => Promise.resolve()),
  fetchIssueTimelines: vi.fn<
    (repo: string, issueNumbers: number[]) => Promise<Map<number, { created_at?: string }[]>>
  >(() => Promise.resolve(new Map())),
  aggregateSessionUsage: vi.fn(),
  gh: vi.fn<(args: string[]) => Promise<{ stdout: string; stderr: string }>>(),
  fetchChecks: vi.fn<(repo: string, pr: string) => Promise<MockCheck[]>>(() => Promise.resolve([])),
  classifyChecks: vi.fn(() => ({ pending: [], failed: [], passed: [], total: 0 })),
  sleepMs: (ms: number) => sleepMsMock(ms),
  handleAgentCrash: (
    repo: string,
    issue: string,
    stage: string,
    detail: string,
    summary?: string
  ) => handleAgentCrashMock(repo, issue, stage, detail, summary),
  executeMerge: (options: {
    pr: { number: number; title: string; headRefName: string; baseRefName: string };
    issueNumber: number;
    nwo: string;
    treatPendingChecksAsFailure: boolean;
  }) => executeMergeMock(options),
  STAGE_NAME_MAP: labelFixtures.stageNameMap,
  STAGE_LABEL_NAMES: labelFixtures.stageLabelNames,
  NEW_LABEL: 'shipper:new',
  PR_REVIEWED_LABEL: 'shipper:pr-reviewed',
  PRIORITY_LABEL_NAMES: ['shipper:priority-high', 'shipper:priority-low'],
  READY_LABEL: 'shipper:ready',
  BLOCKED_LABEL: 'shipper:blocked',
  LOCKED_LABEL: 'shipper:locked',
  FAILED_LABEL: 'shipper:failed',
  getSettings: () => getSettingsMock(),
  resolveMode: (step: string, override?: 'headless' | 'interactive' | 'default') =>
    resolveModeMock(step, override),
  processResult: (result?: { issueNumber?: string; stage?: string }) => processResultMock(result),
  scrubOutputDir: vi.fn<(cwd: string) => Promise<void>>(() => Promise.resolve()),
  sortIssuesByLabelTime: vi.fn(<T>(issues: T[]) => issues),
  withStageHooks: vi.fn((_stage: string, _env: unknown, fn: () => Promise<unknown>) => fn()),
  withIssueLock: vi.fn((_repo: string, issue: string, fn: () => Promise<unknown>) => {
    lockState.lockedIssues.add(issue);
    return fn().finally(() => {
      lockState.lockedIssues.delete(issue);
    });
  }),
  retryOnInvalidOutput: vi.fn<
    (opts: { cwd: string; stage: string; retry: (msg: string) => Promise<number> }) => Promise<{
      verdict: 'accept';
      comment: string;
    }>
  >(() => Promise.resolve({ verdict: 'accept', comment: '.shipper/output/comment-7.md' })),
  totalTokens: vi.fn((usage: { inputTokens: number; outputTokens: number }) => {
    return usage.inputTokens + usage.outputTokens;
  }),
  releaseIssueLock: vi.fn<(repo: string, issue: string) => Promise<void>>(() => Promise.resolve()),
  runPrompt: vi.fn<(name: string, opts: unknown) => Promise<number>>(() => Promise.resolve(0)),
  parseIssueTitleLabelsList,
  parseQueuedPrList,
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const { PassThrough } = await import('node:stream');

  fsMockState.mockCreateWriteStream.mockImplementation((filePath: string) => {
    const stream = new PassThrough();
    fsMockState.capturedLogs.set(filePath, '');
    stream.on('data', (chunk: Buffer | string) => {
      fsMockState.capturedLogs.set(
        filePath,
        `${fsMockState.capturedLogs.get(filePath) ?? ''}${chunk.toString()}`
      );
    });
    return stream;
  });

  return {
    ...actual,
    createWriteStream: fsMockState.mockCreateWriteStream,
    mkdirSync: fsMockState.mockMkdirSync,
  };
});

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: osMockState.mockHomedir,
  };
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: vi.fn(),
    spawnSync: vi.fn(),
  };
});

import {
  aggregateSessionUsage,
  selectIssuesForStage,
  clearStaleLockIfNeeded,
  fetchIssueTimelines,
  gh,
  retryOnInvalidOutput,
  sortIssuesByLabelTime,
  totalTokens,
  withStageHooks,
  withIssueLock,
  releaseIssueLock,
  runPrompt,
} from '@dnsquared/shipper-core';
import { spawn } from 'node:child_process';

const mockAggregateSessionUsage = vi.mocked(aggregateSessionUsage);
const _mockSelectIssuesForStage = vi.mocked(selectIssuesForStage);
const _mockClearStaleLockIfNeeded = vi.mocked(clearStaleLockIfNeeded);
const _mockFetchIssueTimelines = vi.mocked(fetchIssueTimelines);
const mockGh = vi.mocked(gh);
const _mockRetryOnInvalidOutput = vi.mocked(retryOnInvalidOutput);
const mockResolveMode = resolveModeMock;
const _mockSortIssuesByLabelTime = vi.mocked(sortIssuesByLabelTime);
const mockTotalTokens = vi.mocked(totalTokens);
const mockWithStageHooks = vi.mocked(withStageHooks);
const mockWithIssueLock = vi.mocked(withIssueLock);
const _mockReleaseIssueLock = vi.mocked(releaseIssueLock);
const mockRunPrompt = vi.mocked(runPrompt);
const _mockHandleAgentCrash = handleAgentCrashMock;
const _mockPrepareUnblockContext = prepareUnblockContextMock;
const _mockProcessResult = processResultMock;
const _mockBuildReadyCheck = buildReadyCheckMock;
const mockSpawn = vi.mocked(spawn);
const mockCreateWriteStream = fsMockState.mockCreateWriteStream;
const mockMkdirSync = fsMockState.mockMkdirSync;
const mockHomedir = osMockState.mockHomedir;
const repo = 'owner/repo';
const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
  return undefined as never;
}) as typeof process.exit);

beforeEach(() => {
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = undefined;
});

beforeEach(() => {
  mockAggregateSessionUsage.mockReset();
  mockAggregateSessionUsage.mockResolvedValue(undefined);
  mockResolveMode.mockReset();
  mockResolveMode.mockImplementation((_step, override) => override ?? 'default');
  mockTotalTokens.mockReset();
  mockTotalTokens.mockImplementation((usage: { inputTokens: number; outputTokens: number }) => {
    return usage.inputTokens + usage.outputTokens;
  });
});

type ShipSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL';

class FakeChildProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: ShipSignal | null = null;
  kill = vi.fn((_signal?: ShipSignal | number) => true);

  finish(code: number | null, signal: ShipSignal | null = null, stderrText?: string): void {
    if (stderrText) {
      this.stderr.write(stderrText);
    }
    this.stderr.end();
    this.stdout.end();
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
}

async function _flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    process.nextTick(resolve);
  });
  await Promise.resolve();
}

function defaultWithStageHooks<T>(_stage: string, _env: unknown, fn: () => Promise<T>): Promise<T> {
  return fn();
}

function defaultWithIssueLock<T>(_repo: string, _issue: string, fn: () => Promise<T>): Promise<T> {
  return fn();
}

function findGhCalls(command: string, subcommand: string): string[][] {
  return mockGh.mock.calls
    .map(([args]) => args)
    .filter((args) => args[0] === command && args[1] === subcommand);
}

function mockIssueViewSequence(labels: string[]): void {
  let index = 0;
  mockGh.mockImplementation((args: string[]) => {
    if (args[0] === 'issue' && args[1] === 'view') {
      const label = labels[index++];
      return { stdout: label ? `${label}\n` : '', stderr: '' };
    }

    return { stdout: '', stderr: '' };
  });
}

function formatConsoleEntry(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}

function _isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getConsoleEntries(spy: { mock: { calls: readonly unknown[][] } }): string[] {
  return spy.mock.calls.map((call) => formatConsoleEntry(call[0]));
}

function getConsoleOutput(spy: { mock: { calls: readonly unknown[][] } }): string {
  return getConsoleEntries(spy).join('\n');
}

function prefixed(message: string): string {
  return `[shipper] ${message}`;
}

function getCallEnv(
  call: readonly unknown[] | undefined
): Record<string, string | undefined> | undefined {
  const options = call?.[2];
  if (!isUnknownRecord(options)) {
    return undefined;
  }

  const env = options.env;
  if (!isUnknownRecord(env)) {
    return undefined;
  }

  const normalizedEnv: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' || value === undefined) {
      normalizedEnv[key] = value;
    }
  }

  return normalizedEnv;
}

describe('STAGE_NAME', () => {
  it('contains all expected workflow labels', () => {
    const expectedLabels = [
      'shipper:new',
      'shipper:groomed',
      'shipper:designed',
      'shipper:planned',
      'shipper:implemented',
      'shipper:pr-open',
      'shipper:pr-reviewed',
      'shipper:ready',
    ];

    expect(Object.keys(STAGE_NAME).sort()).toEqual(expectedLabels.sort());
  });

  it('includes shipper:ready with a stage name', () => {
    expect(STAGE_NAME).toHaveProperty('shipper:ready', 'ready');
  });

  it('does not include shipper:blocked (orthogonal modifier, not a stage)', () => {
    expect(STAGE_NAME).not.toHaveProperty('shipper:blocked');
  });

  it('maps each label to a non-empty stage name', () => {
    for (const [label, stage] of Object.entries(STAGE_NAME)) {
      expect(stage, `stage name for ${label}`).toBeTruthy();
      expect(typeof stage).toBe('string');
    }
  });
});

describe('shipCommand single-issue path', () => {
  beforeEach(() => {
    mockGh.mockReset();
    mockSpawn.mockReset();
    mockSpawn.mockImplementation(() => {
      const child = new FakeChildProcess();
      globalThis.queueMicrotask(() => {
        child.finish(0);
      });
      return child as never;
    });
    mockRunPrompt.mockReset();
    mockRunPrompt.mockResolvedValue(0);
    mockCreateWriteStream.mockClear();
    mockMkdirSync.mockClear();
    mockHomedir.mockClear();
    mockHomedir.mockReturnValue('/mock-home');
    fsMockState.capturedLogs.clear();
    exitSpy.mockClear();
  });

  it('fails after the 15th transition, relabels the issue as failed, and logs full history', async () => {
    const labels = [
      'shipper:planned',
      'shipper:implemented',
      'shipper:pr-open',
      'shipper:pr-reviewed',
      'shipper:planned',
      'shipper:implemented',
      'shipper:pr-open',
      'shipper:pr-reviewed',
      'shipper:planned',
      'shipper:implemented',
      'shipper:pr-open',
      'shipper:pr-reviewed',
      'shipper:planned',
      'shipper:implemented',
      'shipper:pr-open',
      'shipper:pr-reviewed',
    ];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockIssueViewSequence(labels);

    await shipCommand(repo, '42', { auto: false, merge: false });

    expect(mockSpawn).toHaveBeenCalledTimes(15);
    expect(mockGh).toHaveBeenCalledWith([
      'issue',
      'edit',
      '42',
      '-R',
      repo,
      '--add-label',
      'shipper:failed',
      '--remove-label',
      'shipper:pr-reviewed',
    ]);
    expect(process.exitCode).toBe(1);

    const capMessage = getConsoleEntries(errorSpy).find((message) =>
      message.includes('hit transition cap')
    );
    expect(capMessage).toBe(prefixed(`Issue #42 hit transition cap (15): ${labels.join(' → ')}`));

    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('logs the relabel error details when applying shipper:failed fails', async () => {
    const labels = [
      'shipper:planned',
      'shipper:implemented',
      'shipper:pr-open',
      'shipper:pr-reviewed',
      'shipper:planned',
      'shipper:implemented',
      'shipper:pr-open',
      'shipper:pr-reviewed',
      'shipper:planned',
      'shipper:implemented',
      'shipper:pr-open',
      'shipper:pr-reviewed',
      'shipper:planned',
      'shipper:implemented',
      'shipper:pr-open',
      'shipper:pr-reviewed',
    ];
    let index = 0;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockGh.mockImplementation((args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view') {
        const label = labels[index++];
        return { stdout: label ? `${label}\n` : '', stderr: '' };
      }

      if (args[0] === 'issue' && args[1] === 'edit') {
        throw new Error('gh edit failed');
      }

      return { stdout: '', stderr: '' };
    });

    await shipCommand(repo, '42', { auto: false, merge: false });

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      prefixed('Warning: Failed to update labels on issue #42: gh edit failed')
    );

    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('keeps the happy path under the cap and does not apply shipper:failed', async () => {
    const labels = [
      'shipper:planned',
      'shipper:implemented',
      'shipper:pr-open',
      'shipper:pr-reviewed',
      'shipper:ready',
    ];
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockIssueViewSequence(labels);

    await shipCommand(repo, '42', { auto: false, merge: false });

    const cliEntrypoint = process.argv[1];
    expect(cliEntrypoint).toBeDefined();
    expect(mockSpawn).toHaveBeenCalledTimes(4);
    const firstCall = mockSpawn.mock.calls[0];
    expect(firstCall).toBeDefined();
    expect(firstCall).toEqual([
      process.execPath,
      [cliEntrypoint, 'next', '42'],
      expect.objectContaining({ stdio: ['inherit', 'pipe', 'pipe'] }),
    ]);
    expect(getCallEnv(firstCall)).toEqual(expect.objectContaining({ SHIPPER_LOCK_HELD: '42' }));
    expect(mockGh).not.toHaveBeenCalledWith(
      expect.arrayContaining(['issue', 'edit', '42', '--add-label', 'shipper:failed'])
    );
    expect(process.exitCode).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('hit transition cap'));

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('allows explicit single-issue runs to start from shipper:new', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockResolveMode.mockImplementation((step, override) =>
      step === 'groom' ? 'interactive' : (override ?? 'default')
    );

    mockIssueViewSequence(['shipper:new', 'shipper:groomed', 'shipper:ready']);

    await shipCommand(repo, '42', { auto: false, merge: false });

    const cliEntrypoint = process.argv[1];
    expect(cliEntrypoint).toBeDefined();
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    const firstCall = mockSpawn.mock.calls[0];
    const secondCall = mockSpawn.mock.calls[1];
    expect(firstCall).toBeDefined();
    expect(firstCall).toEqual([
      process.execPath,
      [cliEntrypoint, 'next', '42', '--mode', 'interactive'],
      expect.objectContaining({ stdio: 'inherit' }),
    ]);
    expect(secondCall).toEqual([
      process.execPath,
      [cliEntrypoint, 'next', '42'],
      expect.objectContaining({ stdio: ['inherit', 'pipe', 'pipe'] }),
    ]);
    expect(getCallEnv(firstCall)).toEqual(expect.objectContaining({ SHIPPER_LOCK_HELD: '42' }));
    expect(process.exitCode).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('was reset to shipper:new'));

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('warns when the issue label fetch fails before reporting the missing-label error', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mockGh.mockImplementation((args: string[]) => {
        if (args[0] === 'issue' && args[1] === 'view') {
          throw new Error('gh view failed');
        }

        return { stdout: '', stderr: '' };
      });

      await shipCommand(repo, '42', { auto: false, merge: false });

      expect(warnSpy).toHaveBeenCalledWith(prefixed('Failed to fetch labels for issue #42'));
      expect(errorSpy).toHaveBeenCalledWith(
        prefixed('Issue #42 has no shipper label. Run `shipper next` or add a label first.')
      );
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('does not force interactive grooming when resolveMode returns default', async () => {
    mockIssueViewSequence(['shipper:new', 'shipper:groomed', 'shipper:ready']);

    await shipCommand(repo, '42', { auto: false, merge: false });

    const cliEntrypoint = process.argv[1];
    expect(cliEntrypoint).toBeDefined();
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(mockSpawn.mock.calls[0]?.[1]).toEqual([cliEntrypoint, 'next', '42']);
    expect(mockSpawn.mock.calls[0]?.[2]).toMatchObject({ stdio: ['inherit', 'pipe', 'pipe'] });
    expect(mockSpawn.mock.calls[1]?.[1]).toEqual([cliEntrypoint, 'next', '42']);
    expect(process.exitCode).toBeUndefined();
  });

  it('uses resolveMode for non-groom stages and preserves the stage log in interactive mode', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-06T02:30:00'));
    mockResolveMode.mockImplementation((step, override) =>
      step === 'implement' ? 'interactive' : (override ?? 'default')
    );

    mockIssueViewSequence(['shipper:planned', 'shipper:ready']);

    await shipCommand(repo, '42', { auto: false, merge: false });

    const cliEntrypoint = process.argv[1];
    expect(cliEntrypoint).toBeDefined();
    expect(mockSpawn.mock.calls[0]).toEqual([
      process.execPath,
      [cliEntrypoint, 'next', '42', '--mode', 'interactive'],
      expect.objectContaining({ stdio: 'inherit' }),
    ]);
    expect(
      fsMockState.capturedLogs.get('/mock-home/.shipper/logs/ship-42-20260306T023000.log')
    ).toContain('Running stage: implement');

    vi.useRealTimers();
  });

  it('normalizes PR stage names before resolving mode', async () => {
    mockResolveMode.mockImplementation((step, override) =>
      step === 'pr_open' ? 'interactive' : (override ?? 'default')
    );

    mockIssueViewSequence(['shipper:implemented', 'shipper:pr-open', 'shipper:ready']);

    await shipCommand(repo, '42', { auto: false, merge: false });

    const cliEntrypoint = process.argv[1];
    expect(cliEntrypoint).toBeDefined();
    expect(mockResolveMode).toHaveBeenCalledWith('pr_open', undefined);
    expect(mockSpawn.mock.calls[0]).toEqual([
      process.execPath,
      [cliEntrypoint, 'next', '42', '--mode', 'interactive'],
      expect.objectContaining({ stdio: 'inherit' }),
    ]);
  });

  it('writes a single-issue ship log, tees child output, and prints the final log path', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-06T02:30:00'));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    mockIssueViewSequence(['shipper:planned', 'shipper:ready']);
    mockSpawn.mockImplementationOnce(() => {
      const child = new FakeChildProcess();
      globalThis.queueMicrotask(() => {
        child.stderr.write('[shipper] ▶ stage:implement #42 starting\n');
        child.stdout.write('agent output\n');
        child.stderr.write('[shipper] ✓ stage:implement #42 complete (45s)\n');
        child.finish(0, null, 'agent error\n');
      });
      return child as never;
    });

    await shipCommand(repo, '42', { auto: false, merge: false });

    const logFile = '/mock-home/.shipper/logs/ship-42-20260306T023000.log';
    expect(mockMkdirSync).toHaveBeenCalledWith('/mock-home/.shipper/logs', {
      recursive: true,
      mode: 0o700,
    });
    expect(mockCreateWriteStream).toHaveBeenCalledWith(logFile);
    expect(mockSpawn.mock.calls[0]?.[2]).toMatchObject({ stdio: ['inherit', 'pipe', 'pipe'] });
    expect(stdoutWriteSpy).toHaveBeenCalledWith(expect.any(Buffer));
    expect(stderrWriteSpy).toHaveBeenCalledWith(expect.any(Buffer));

    const output = getConsoleOutput(logSpy);
    expect(output).toContain('Log file: ~/.shipper/logs/ship-42-20260306T023000.log');
    expect(fsMockState.capturedLogs.get(logFile)).toContain(
      '[shipper] ▶ stage:implement #42 starting'
    );
    expect(fsMockState.capturedLogs.get(logFile)).toContain(
      '[shipper] ✓ stage:implement #42 complete (45s)'
    );
    expect(fsMockState.capturedLogs.get(logFile)).toContain('agent output');
    expect(fsMockState.capturedLogs.get(logFile)).toContain('agent error');
    expect(fsMockState.capturedLogs.get(logFile)).not.toContain('[shipper] agent output');
    expect(fsMockState.capturedLogs.get(logFile)).not.toContain('[shipper] agent error');

    stdoutWriteSpy.mockRestore();
    stderrWriteSpy.mockRestore();
    logSpy.mockRestore();
    vi.useRealTimers();
  });

  it('surfaces the existing groom headless rejection when the resolved mode is headless', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-06T02:30:00'));

    const stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mockIssueViewSequence(['shipper:new']);
    mockSpawn.mockImplementationOnce(() => {
      const child = new FakeChildProcess();
      globalThis.queueMicrotask(() => {
        child.finish(
          1,
          null,
          'Error: groom does not support headless mode. Grooming requires interactive input.\n'
        );
      });
      return child as never;
    });

    await shipCommand(repo, '42', { auto: false, merge: false, mode: 'headless' });

    const logFile = '/mock-home/.shipper/logs/ship-42-20260306T023000.log';
    expect(mockSpawn.mock.calls[0]?.[2]).toMatchObject({ stdio: ['inherit', 'pipe', 'pipe'] });
    expect(fsMockState.capturedLogs.get(logFile)).toContain(
      'Error: groom does not support headless mode. Grooming requires interactive input.'
    );
    expect(stderrWriteSpy).toHaveBeenCalledWith(expect.any(Buffer));
    expect(process.exitCode).toBe(1);

    stderrWriteSpy.mockRestore();
    vi.useRealTimers();
  });

  it('does not let a destroyed log stream hang or override a successful ship result', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockIssueViewSequence(['shipper:planned', 'shipper:ready']);
    mockSpawn.mockImplementationOnce(() => {
      const child = new FakeChildProcess();
      globalThis.queueMicrotask(() => {
        child.stdout.write('agent output\n');
        child.finish(0);
      });
      return child as never;
    });

    mockCreateWriteStream.mockImplementationOnce((filePath: string) => {
      const stream = new PassThrough();
      let failed = false;
      fsMockState.capturedLogs.set(filePath, '');
      stream.on('data', (chunk: Buffer | string) => {
        fsMockState.capturedLogs.set(
          filePath,
          `${fsMockState.capturedLogs.get(filePath) ?? ''}${chunk.toString()}`
        );
        if (!failed) {
          failed = true;
          stream.destroy(new Error('disk full'));
        }
      });
      return stream;
    });

    await shipCommand(repo, '42', { auto: false, merge: false });

    expect(process.exitCode).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('disk full'));

    errorSpy.mockRestore();
  });

  it('keeps prioritized issues shippable in the single-issue path', async () => {
    mockIssueViewSequence([
      'shipper:planned\nshipper:priority-high',
      'shipper:ready\nshipper:priority-high',
    ]);

    await shipCommand(repo, '42', { auto: false, merge: false });

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBeUndefined();
  });

  it('keeps the same-label safeguard when grooming stays on shipper:new', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockIssueViewSequence(['shipper:new', 'shipper:new']);

    await shipCommand(repo, '42', { auto: false, merge: false });

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      prefixed(
        'Label did not advance after stage "groom" (still "shipper:new"). Aborting to avoid infinite loop.'
      )
    );
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('was reset to shipper:new'));

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('forwards explicit mode, agent, and model overrides to shipper next', async () => {
    mockIssueViewSequence(['shipper:planned', 'shipper:ready']);

    await shipCommand(repo, '42', {
      auto: false,
      merge: false,
      mode: 'headless',
      agent: 'codex',
      model: 'sonnet',
    });

    const cliEntrypoint = process.argv[1];
    expect(cliEntrypoint).toBeDefined();
    const expectedCall = mockSpawn.mock.calls.find(
      (call) =>
        call[0] === process.execPath &&
        JSON.stringify(call[1]) ===
          JSON.stringify([
            cliEntrypoint,
            'next',
            '42',
            '--mode',
            'headless',
            '--agent',
            'codex',
            '--model',
            'sonnet',
          ])
    );
    expect(expectedCall).toBeDefined();
    expect(getCallEnv(expectedCall)).toEqual(expect.objectContaining({ SHIPPER_LOCK_HELD: '42' }));
    expect(process.exitCode).toBeUndefined();
  });

  it('does not forward --mode when the explicit mode is default', async () => {
    mockIssueViewSequence(['shipper:planned', 'shipper:ready']);

    await shipCommand(repo, '42', { auto: false, merge: false, mode: 'default' });

    const cliEntrypoint = process.argv[1];
    expect(cliEntrypoint).toBeDefined();
    expect(mockSpawn).toHaveBeenCalledWith(
      process.execPath,
      [cliEntrypoint, 'next', '42'],
      expect.objectContaining({ stdio: ['inherit', 'pipe', 'pipe'] })
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('continues into groom when a default-mode run resets an issue to shipper:new', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockResolveMode.mockImplementation((step, override) =>
      step === 'groom' ? 'interactive' : (override ?? 'default')
    );

    mockIssueViewSequence(['shipper:planned', 'shipper:new', 'shipper:groomed', 'shipper:ready']);

    await shipCommand(repo, '42', { auto: false, merge: false, mode: 'default' });

    const cliEntrypoint = process.argv[1];
    expect(cliEntrypoint).toBeDefined();
    expect(mockSpawn).toHaveBeenCalledTimes(3);
    expect(mockSpawn.mock.calls[0]?.[1]).toEqual([cliEntrypoint, 'next', '42']);
    expect(mockSpawn.mock.calls[1]?.[1]).toEqual([
      cliEntrypoint,
      'next',
      '42',
      '--mode',
      'interactive',
    ]);
    expect(mockSpawn.mock.calls[1]?.[2]).toMatchObject({ stdio: 'inherit' });
    expect(mockSpawn.mock.calls[2]?.[1]).toEqual([cliEntrypoint, 'next', '42']);
    expect(process.exitCode).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('was reset to shipper:new'));

    errorSpy.mockRestore();
  });

  it('stops when an auto-child run resets an issue to shipper:new', async () => {
    const previousAutoChild = process.env.SHIPPER_AUTO_CHILD_RUN;
    process.env.SHIPPER_AUTO_CHILD_RUN = '1';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      mockIssueViewSequence(['shipper:planned', 'shipper:new']);

      await shipCommand(repo, '42', { auto: false, merge: false, mode: 'default' });

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(
        prefixed(
          'Issue #42 was reset to shipper:new by stage "implement" - stopping to avoid interactive groom stage.'
        )
      );
    } finally {
      if (previousAutoChild === undefined) {
        delete process.env.SHIPPER_AUTO_CHILD_RUN;
      } else {
        process.env.SHIPPER_AUTO_CHILD_RUN = previousAutoChild;
      }
      errorSpy.mockRestore();
    }
  });

  it('skips token aggregation inside auto-child ship runs', async () => {
    const previousAutoChild = process.env.SHIPPER_AUTO_CHILD_RUN;
    process.env.SHIPPER_AUTO_CHILD_RUN = '1';

    try {
      mockIssueViewSequence(['shipper:planned', 'shipper:ready']);

      await shipCommand(repo, '42', { auto: false, merge: false });

      expect(mockAggregateSessionUsage).not.toHaveBeenCalled();
      expect(mockTotalTokens).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    } finally {
      if (previousAutoChild === undefined) {
        delete process.env.SHIPPER_AUTO_CHILD_RUN;
      } else {
        process.env.SHIPPER_AUTO_CHILD_RUN = previousAutoChild;
      }
    }
  });

  it('skips interactive stages in auto-child runs before spawning', async () => {
    const previousAutoChild = process.env.SHIPPER_AUTO_CHILD_RUN;
    process.env.SHIPPER_AUTO_CHILD_RUN = '1';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockResolveMode.mockImplementation((step, override) =>
      step === 'groom' ? 'interactive' : (override ?? 'default')
    );

    try {
      mockIssueViewSequence(['shipper:new']);

      await shipCommand(repo, '42', { auto: false, merge: false });

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(mockAggregateSessionUsage).not.toHaveBeenCalled();
      expect(mockTotalTokens).not.toHaveBeenCalled();
      const output = getConsoleOutput(logSpy);
      expect(output).toContain('Skipping issue #42: stage "groom" requires interactive mode.');
      expect(output).not.toContain('Running stage: groom');
      expect(output).not.toContain('Stage summary:');
      expect(process.exitCode).toBeUndefined();
    } finally {
      if (previousAutoChild === undefined) {
        delete process.env.SHIPPER_AUTO_CHILD_RUN;
      } else {
        process.env.SHIPPER_AUTO_CHILD_RUN = previousAutoChild;
      }
      logSpy.mockRestore();
    }
  });

  it('continues into groom when an interactive run resets an issue to shipper:new', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockIssueViewSequence(['shipper:planned', 'shipper:new', 'shipper:groomed', 'shipper:ready']);

    await shipCommand(repo, '42', { auto: false, merge: false, mode: 'interactive' });

    const cliEntrypoint = process.argv[1];
    expect(cliEntrypoint).toBeDefined();
    expect(mockSpawn).toHaveBeenCalledTimes(3);
    expect(mockSpawn.mock.calls[0]?.[1]).toEqual([
      cliEntrypoint,
      'next',
      '42',
      '--mode',
      'interactive',
    ]);
    expect(mockSpawn.mock.calls[1]?.[1]).toEqual([
      cliEntrypoint,
      'next',
      '42',
      '--mode',
      'interactive',
    ]);
    expect(mockSpawn.mock.calls[2]?.[1]).toEqual([
      cliEntrypoint,
      'next',
      '42',
      '--mode',
      'interactive',
    ]);
    expect(mockSpawn.mock.calls[0]?.[2]).toMatchObject({ stdio: 'inherit' });
    expect(mockSpawn.mock.calls[1]?.[2]).toMatchObject({ stdio: 'inherit' });
    expect(mockSpawn.mock.calls[2]?.[2]).toMatchObject({ stdio: 'inherit' });
    expect(process.exitCode).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('was reset to shipper:new'));

    errorSpy.mockRestore();
  });

  it('fails fast with a terminal-state message for shipper:failed issues', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockIssueViewSequence(['shipper:failed']);

    await shipCommand(repo, '42', { auto: false, merge: false });

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      prefixed(
        'Issue #42 is marked shipper:failed and requires manual intervention before it can re-enter the pipeline.'
      )
    );

    errorSpy.mockRestore();
  });
});

describe('shipCommand merge path', () => {
  beforeEach(() => {
    mockGh.mockReset();
    executeMergeMock.mockReset();
    executeMergeMock.mockImplementation(async ({ pr, issueNumber, nwo }) => {
      await postMergeMock(pr, issueNumber, nwo, false);
      return true;
    });
    mockWithStageHooks.mockReset();
    mockWithStageHooks.mockImplementation(defaultWithStageHooks);
    mockWithIssueLock.mockReset();
    mockWithIssueLock.mockImplementation(defaultWithIssueLock);
    mockSpawn.mockReset();
    postMergeMock.mockClear();
    postMergeMock.mockResolvedValue(undefined);
    pollPrMergedMock.mockReset();
    pollPrMergedMock.mockResolvedValue(false);
    exitSpy.mockClear();
  });

  it('resolves the PR and delegates merge execution to the shared helper', async () => {
    mockGh.mockImplementation((args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view') {
        return { stdout: 'shipper:ready', stderr: '' };
      }

      if (args[0] === 'pr' && args[1] === 'list') {
        return {
          stdout: JSON.stringify([
            {
              number: 456,
              title: 'Ready PR',
              headRefName: 'shipper/123',
              baseRefName: 'main',
            },
          ]),
          stderr: '',
        };
      }

      throw new Error(`Unexpected gh args: ${args.join(' ')}`);
    });

    await shipCommand(repo, '123', { merge: true, auto: false });

    expect(findGhCalls('pr', 'list')).toHaveLength(1);
    const call = executeMergeMock.mock.calls[0]?.[0];
    expect(call?.pr).toEqual(
      expect.objectContaining({
        number: 456,
        headRefName: 'shipper/123',
        baseRefName: 'main',
      })
    );
    expect(call?.issueNumber).toBe(123);
    expect(call?.nwo).toBe(repo);
    expect(call?.treatPendingChecksAsFailure).toBe(true);
    expect(postMergeMock).toHaveBeenCalledTimes(1);
    expect(mockWithStageHooks).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('keeps helper-raised merge failures retriable', async () => {
    mockGh.mockImplementation((args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view') {
        return { stdout: 'shipper:ready', stderr: '' };
      }

      if (args[0] === 'pr' && args[1] === 'list') {
        return {
          stdout: JSON.stringify([
            {
              number: 456,
              title: 'Ready PR',
              headRefName: 'shipper/123',
              baseRefName: 'main',
            },
          ]),
          stderr: '',
        };
      }

      throw new Error(`Unexpected gh args: ${args.join(' ')}`);
    });
    executeMergeMock.mockRejectedValueOnce(
      new Error('Merge failed for PR #456: pending CI checks are still running.')
    );

    await shipCommand(repo, '123', { merge: true, auto: false });

    expect(executeMergeMock).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  it('does not reclassify non-merge helper failures as retriable', async () => {
    mockGh.mockImplementation((args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view') {
        return { stdout: 'shipper:ready', stderr: '' };
      }

      if (args[0] === 'pr' && args[1] === 'list') {
        return {
          stdout: JSON.stringify([
            {
              number: 456,
              title: 'Ready PR',
              headRefName: 'shipper/123',
              baseRefName: 'main',
            },
          ]),
          stderr: '',
        };
      }

      throw new Error(`Unexpected gh args: ${args.join(' ')}`);
    });
    executeMergeMock.mockRejectedValueOnce(new Error('pre-merge hook exited with code 1'));

    await shipCommand(repo, '123', { merge: true, auto: false });

    expect(executeMergeMock).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  it('fails before delegation when PR resolution finds no matching PR', async () => {
    mockGh.mockImplementation((args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view') {
        return { stdout: 'shipper:ready', stderr: '' };
      }

      if (args[0] === 'pr' && args[1] === 'list') {
        return { stdout: '[]', stderr: '' };
      }

      throw new Error(`Unexpected gh args: ${args.join(' ')}`);
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await shipCommand(repo, '123', { merge: true, auto: false });

    expect(executeMergeMock).not.toHaveBeenCalled();
    expect(getConsoleOutput(errorSpy)).toContain('No open PR found for issue #123.');
    expect(process.exitCode).toBe(1);

    errorSpy.mockRestore();
  });
});
