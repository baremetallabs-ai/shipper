import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { toError, toErrorMessage } from '../../../core/src/lib/errors.js';

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
  >((result?: { issueNumber?: string; stage?: string }) => {
    if (result?.stage === 'unblock') {
      const issue = mockIssues.get(Number(result.issueNumber));
      if (issue) {
        issue.labels = issue.labels.filter((label) => label !== 'shipper:blocked');
      }
    }

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
import { printAutoSummary } from '../../src/commands/ship-auto.js';

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
  fetchChecks,
  classifyChecks,
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
const mockSelectIssuesForStage = vi.mocked(selectIssuesForStage);
const mockClearStaleLockIfNeeded = vi.mocked(clearStaleLockIfNeeded);
const _mockFetchIssueTimelines = vi.mocked(fetchIssueTimelines);
const mockGh = vi.mocked(gh);
const _mockFetchChecks = vi.mocked(fetchChecks);
const _mockClassifyChecks = vi.mocked(classifyChecks);
const _mockSleepMs = sleepMsMock;
const _mockRetryOnInvalidOutput = vi.mocked(retryOnInvalidOutput);
const mockResolveMode = resolveModeMock;
const _mockSortIssuesByLabelTime = vi.mocked(sortIssuesByLabelTime);
const mockTotalTokens = vi.mocked(totalTokens);
const mockWithStageHooks = vi.mocked(withStageHooks);
const mockWithIssueLock = vi.mocked(withIssueLock);
const _mockReleaseIssueLock = vi.mocked(releaseIssueLock);
const _mockRunPrompt = vi.mocked(runPrompt);
const _mockHandleAgentCrash = handleAgentCrashMock;
const _mockPrepareUnblockContext = prepareUnblockContextMock;
const _mockProcessResult = processResultMock;
const mockBuildReadyCheck = buildReadyCheckMock;
const mockSpawn = vi.mocked(spawn);
const mockCreateWriteStream = fsMockState.mockCreateWriteStream;
const mockMkdirSync = fsMockState.mockMkdirSync;
const mockHomedir = osMockState.mockHomedir;
const repo = 'owner/repo';
const _UNKNOWN_STATE_POLL_MAX = 5;
const _UNKNOWN_STATE_POLL_DELAY_MS = 3_000;
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

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    process.nextTick(resolve);
  });
  await Promise.resolve();
}

function defaultWithStageHooks<T>(_stage: string, _env: unknown, fn: () => Promise<T>): Promise<T> {
  return fn();
}

function _defaultWithIssueLock<T>(_repo: string, _issue: string, fn: () => Promise<T>): Promise<T> {
  return fn();
}

function _setupReadyMergeFlow(options?: {
  mergeStates?: string[];
  mergeable?: string;
  prNumber?: number;
  issueNumber?: string;
  updateBranchStdout?: string;
  updateBranchError?: Error;
  mergeStdout?: string;
  mergeError?: Error;
}): void {
  const {
    mergeStates = ['CLEAN'],
    mergeable = 'UNKNOWN',
    prNumber = 456,
    issueNumber = '123',
    updateBranchStdout = '',
    updateBranchError,
    mergeStdout = '',
    mergeError,
  } = options ?? {};

  let mergeStateCall = 0;

  mockGh.mockImplementation((args: string[]) => {
    if (args[0] === 'issue' && args[1] === 'list') {
      return { stdout: '[]', stderr: '' };
    }

    if (args[0] === 'issue' && args[1] === 'view') {
      return { stdout: 'shipper:ready', stderr: '' };
    }

    if (args[0] === 'pr' && args[1] === 'list') {
      return {
        stdout: JSON.stringify([
          {
            number: prNumber,
            title: 'Ready PR',
            headRefName: `shipper/${issueNumber}`,
            baseRefName: 'main',
          },
        ]),
        stderr: '',
      };
    }

    if (args[0] === 'pr' && args[1] === 'view') {
      const index = Math.min(mergeStateCall, mergeStates.length - 1);
      const mergeStateStatus = mergeStates[index] ?? mergeStates[mergeStates.length - 1] ?? 'CLEAN';
      mergeStateCall++;
      return {
        stdout: JSON.stringify({ mergeStateStatus, mergeable }),
        stderr: '',
      };
    }

    if (args[0] === 'pr' && args[1] === 'update-branch') {
      if (updateBranchError) throw updateBranchError;
      return { stdout: updateBranchStdout, stderr: '' };
    }

    if (args[0] === 'pr' && args[1] === 'merge') {
      if (mergeError) throw mergeError;
      return { stdout: mergeStdout, stderr: '' };
    }

    if (
      (args[0] === 'pr' && (args[1] === 'edit' || args[1] === 'comment')) ||
      (args[0] === 'issue' && (args[1] === 'edit' || args[1] === 'close'))
    ) {
      return { stdout: '', stderr: '' };
    }

    throw new Error(`Unexpected gh args: ${args.join(' ')}`);
  });
}

function _findGhCalls(command: string, subcommand: string): string[][] {
  return mockGh.mock.calls
    .map(([args]) => args)
    .filter((args) => args[0] === command && args[1] === subcommand);
}

function _mockIssueViewSequence(labels: string[]): void {
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

function isUnknownArray(value: unknown): value is unknown[] {
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

function getIssueArg(call: readonly unknown[]): string | undefined {
  const args = call[1];
  if (!isUnknownArray(args)) {
    return undefined;
  }

  const issue = args[2];
  return typeof issue === 'string' ? issue : undefined;
}

function getIssuedCalls(calls: readonly unknown[][]): string[] {
  return calls.flatMap((call) => {
    const issue = getIssueArg(call);
    return issue ? [issue] : [];
  });
}

function findCallForIssue(
  calls: readonly unknown[][],
  issue: string
): readonly unknown[] | undefined {
  return calls.find((call) => getIssueArg(call) === issue);
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

interface MockIssueState {
  number: number;
  title: string;
  labels: string[];
  nextLabels: string[];
  prNumber?: number;
}

let mockIssues = new Map<number, MockIssueState>();

function setMockIssues(issues: MockIssueState[]): void {
  mockIssues = new Map(
    issues.map((issue) => [
      issue.number,
      { ...issue, labels: [...issue.labels], nextLabels: [...issue.nextLabels] },
    ])
  );
}

function getStageLabel(issue: MockIssueState): string | undefined {
  return issue.labels.find(
    (label) =>
      label.startsWith('shipper:') &&
      label !== 'shipper:blocked' &&
      label !== 'shipper:priority-high' &&
      label !== 'shipper:priority-low'
  );
}

function getPriority(issue: MockIssueState): 0 | 1 | 2 {
  if (issue.labels.includes('shipper:priority-high')) {
    return 0;
  }

  if (issue.labels.includes('shipper:priority-low')) {
    return 2;
  }

  return 1;
}

function withDefaultPriority(
  issues: Array<{ number: number; title: string; priority?: 0 | 1 | 2 }>
): MockCandidate[] {
  return issues.map((issue) => ({
    number: issue.number,
    title: issue.title,
    priority: issue.priority ?? 1,
  }));
}

function installSequentialCliMocks(options?: {
  stageOutput?: (
    issueNumber: number,
    args: ReadonlyArray<string>
  ) => { stdout?: string; stderr?: string; code?: number };
}): void {
  mockSelectIssuesForStage.mockImplementation((_repo: string, label: string) => {
    return withDefaultPriority(
      Array.from(mockIssues.values())
        .filter((issue) => getStageLabel(issue) === label)
        .filter((issue) => !issue.labels.includes('shipper:blocked'))
        .filter((issue) => !lockState.lockedIssues.has(String(issue.number)))
        .map((issue) => ({
          number: issue.number,
          title: issue.title,
          priority: getPriority(issue),
        }))
    );
  });

  mockGh.mockImplementation((args: string[]) => {
    if (args[0] === 'issue' && args[1] === 'view') {
      const issue = mockIssues.get(Number(args[2]));
      return {
        stdout: issue ? `${issue.labels.join('\n')}\n` : '',
        stderr: '',
      };
    }

    if (args[0] === 'issue' && args[1] === 'list') {
      const blocked = Array.from(mockIssues.values())
        .filter((issue) => issue.labels.includes('shipper:blocked'))
        .filter((issue) => !lockState.lockedIssues.has(String(issue.number)))
        .map((issue) => ({
          number: issue.number,
          title: issue.title,
          labels: issue.labels.map((name) => ({ name })),
        }));
      return {
        stdout: JSON.stringify(blocked),
        stderr: '',
      };
    }

    if (args[0] === 'pr' && args[1] === 'list') {
      const prs = Array.from(mockIssues.values())
        .filter((issue) => issue.prNumber !== undefined)
        .map((issue) => ({
          number: issue.prNumber,
          title: `PR for ${issue.title}`,
          headRefName: `shipper/${issue.number}`,
          baseRefName: 'main',
        }));
      return {
        stdout: JSON.stringify(prs),
        stderr: '',
      };
    }

    if (args[0] === 'pr' && args[1] === 'view') {
      return {
        stdout: JSON.stringify({ mergeStateStatus: 'CLEAN' }),
        stderr: '',
      };
    }

    if (args[0] === 'pr' && args[1] === 'merge') {
      return {
        stdout: 'merged',
        stderr: '',
      };
    }

    if (
      (args[0] === 'pr' && (args[1] === 'edit' || args[1] === 'comment')) ||
      (args[0] === 'issue' && (args[1] === 'edit' || args[1] === 'close'))
    ) {
      return { stdout: '', stderr: '' };
    }

    throw new Error(`Unexpected gh call: ${args.join(' ')}`);
  });

  mockSpawn.mockImplementation((_command: string, args: ReadonlyArray<string>) => {
    const issueNumber = Number(args[2]);
    const issue = mockIssues.get(issueNumber);
    const child = new FakeChildProcess();
    if (!issue) {
      globalThis.queueMicrotask(() => {
        child.finish(1);
      });
      return child as never;
    }

    const nextLabel = issue.nextLabels.shift();
    const stageResult = options?.stageOutput?.(issueNumber, args) ?? {};

    globalThis.queueMicrotask(() => {
      if (nextLabel) {
        issue.labels = [nextLabel];
      }
      if (stageResult.stdout) {
        child.stdout.write(stageResult.stdout);
      }
      child.finish(stageResult.code ?? 0, null, stageResult.stderr);
    });

    return child as never;
  });
}

describe('printAutoSummary', () => {
  it('renders the Tokens column with formatted totals and an em dash fallback', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    printAutoSummary([
      { issue: 308, title: 'Issue title here', outcome: 'pass', totalTokens: 57_338 },
      { issue: 310, title: 'Another issue', outcome: 'fail', error: 'error' },
    ]);

    const output = getConsoleOutput(logSpy);
    expect(output).toContain('Tokens');
    expect(output).toContain('57,338');
    expect(output).toContain('Another issue');
    expect(output).toContain('—  ✗ fail — error');

    logSpy.mockRestore();
  });
});

describe('shipCommand sequential auto runner parking', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    lockState.lockedIssues.clear();
    mockIssues.clear();
    getSettingsMock.mockReturnValue({
      prReviewWait: { mode: 'checks', maxDurationMinutes: 30 },
    });
    mockBuildReadyCheck.mockReset();
    mockSpawn.mockReset();
    mockGh.mockReset();
    mockSelectIssuesForStage.mockReset();
    mockWithStageHooks.mockReset();
    mockWithStageHooks.mockImplementation(defaultWithStageHooks);
    mockWithIssueLock.mockReset();
    mockWithIssueLock.mockImplementation((_repo: string, issue: string, fn) => {
      lockState.lockedIssues.add(issue);
      return fn().finally(() => {
        lockState.lockedIssues.delete(issue);
      });
    });
    executeMergeMock.mockReset();
    postMergeMock.mockClear();
    postMergeMock.mockImplementation((_pr: unknown, issueNumber: number | string) => {
      mockIssues.delete(Number(issueNumber));
      return Promise.resolve();
    });
    executeMergeMock.mockImplementation(async ({ pr, issueNumber, nwo }) => {
      await postMergeMock(pr, issueNumber, nwo, false);
      return true;
    });
    mockCreateWriteStream.mockClear();
    mockMkdirSync.mockClear();
    mockHomedir.mockClear();
    mockHomedir.mockReturnValue('/mock-home');
    fsMockState.capturedLogs.clear();
    exitSpy.mockClear();
    installSequentialCliMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('parks timer waits and runs the next candidate while the first issue is parked', async () => {
    setMockIssues([
      {
        number: 1,
        title: 'Timer wait issue',
        labels: ['shipper:pr-reviewed'],
        nextLabels: ['shipper:ready'],
        prNumber: 101,
      },
      {
        number: 2,
        title: 'Follow-on issue',
        labels: ['shipper:planned'],
        nextLabels: [
          'shipper:implemented',
          'shipper:pr-open',
          'shipper:pr-reviewed',
          'shipper:ready',
        ],
        prNumber: 102,
      },
    ]);
    getSettingsMock.mockReturnValue({
      prReviewWait: { mode: 'timer', durationMinutes: 15 },
    });

    let timerReady = false;
    mockBuildReadyCheck.mockImplementation((_repo: string, pr: string) => {
      if (pr === '101') {
        return Promise.resolve(() => Promise.resolve(timerReady));
      }
      return Promise.resolve(() => Promise.resolve(true));
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const runPromise = shipCommand(repo, undefined, { auto: true, merge: false });

    await flushMicrotasks();

    expect(mockBuildReadyCheck).toHaveBeenCalledWith(repo, '101');
    expect(getIssuedCalls(mockSpawn.mock.calls).includes('1')).toBe(false);
    expect(getIssuedCalls(mockSpawn.mock.calls).includes('2')).toBe(true);

    timerReady = true;
    await vi.advanceTimersByTimeAsync(20_000);
    await runPromise;

    const resumedCall = findCallForIssue(mockSpawn.mock.calls, '1');
    expect(resumedCall).toBeDefined();
    expect(getCallEnv(resumedCall)).toEqual(
      expect.objectContaining({
        SHIPPER_LOCK_HELD: '1',
        SHIPPER_SKIP_PR_REMEDIATE_WAIT: '1',
      })
    );
    const secondIssueCall = findCallForIssue(mockSpawn.mock.calls, '2');
    expect(secondIssueCall).toBeDefined();
    expect(getCallEnv(secondIssueCall)).toEqual(
      expect.objectContaining({ SHIPPER_LOCK_HELD: '2' })
    );

    const output = getConsoleOutput(logSpy);
    expect(output).toContain('✓ pass');
    expect(output).not.toContain('park');
    expect(output).not.toContain('resume');
    expect(process.exitCode).toBeUndefined();

    logSpy.mockRestore();
  });

  it('parks checks waits and runs the next candidate while the first issue is parked', async () => {
    setMockIssues([
      {
        number: 1,
        title: 'Checks wait issue',
        labels: ['shipper:pr-reviewed'],
        nextLabels: ['shipper:ready'],
        prNumber: 201,
      },
      {
        number: 2,
        title: 'Second issue',
        labels: ['shipper:planned'],
        nextLabels: [
          'shipper:implemented',
          'shipper:pr-open',
          'shipper:pr-reviewed',
          'shipper:ready',
        ],
        prNumber: 202,
      },
    ]);

    let checksReady = false;
    mockBuildReadyCheck.mockImplementation((_repo: string, pr: string) => {
      if (pr === '201') {
        return Promise.resolve(() => Promise.resolve(checksReady));
      }
      return Promise.resolve(() => Promise.resolve(true));
    });

    const runPromise = shipCommand(repo, undefined, { auto: true, merge: false });

    await flushMicrotasks();
    expect(mockBuildReadyCheck).toHaveBeenCalledWith(repo, '201');
    expect(getIssuedCalls(mockSpawn.mock.calls).includes('1')).toBe(false);
    expect(getIssuedCalls(mockSpawn.mock.calls).includes('2')).toBe(true);

    checksReady = true;
    await vi.advanceTimersByTimeAsync(20_000);
    await runPromise;

    const issueOrder = getIssuedCalls(mockSpawn.mock.calls);
    expect(issueOrder.indexOf('2')).toBeLessThan(issueOrder.lastIndexOf('1'));
    expect(process.exitCode).toBeUndefined();
  });

  it('resumes multiple parked issues independently as their readiness changes', async () => {
    setMockIssues([
      {
        number: 1,
        title: 'First parked issue',
        labels: ['shipper:pr-reviewed'],
        nextLabels: ['shipper:ready'],
        prNumber: 301,
      },
      {
        number: 2,
        title: 'Second parked issue',
        labels: ['shipper:pr-reviewed'],
        nextLabels: ['shipper:ready'],
        prNumber: 302,
      },
    ]);

    let firstReady = false;
    let secondReady = false;
    mockBuildReadyCheck.mockImplementation((_repo: string, pr: string) => {
      if (pr === '301') {
        return Promise.resolve(() => Promise.resolve(firstReady));
      }
      if (pr === '302') {
        return Promise.resolve(() => Promise.resolve(secondReady));
      }
      return Promise.resolve(() => Promise.resolve(true));
    });

    const runPromise = shipCommand(repo, undefined, { auto: true, merge: false });

    await flushMicrotasks();
    expect(mockSpawn).not.toHaveBeenCalled();

    secondReady = true;
    await vi.advanceTimersByTimeAsync(20_000);
    await flushMicrotasks();
    expect(getIssuedCalls(mockSpawn.mock.calls)).toEqual(['2']);

    firstReady = true;
    await vi.advanceTimersByTimeAsync(20_000);
    await runPromise;

    expect(getIssuedCalls(mockSpawn.mock.calls)).toEqual(['2', '1']);
    expect(process.exitCode).toBeUndefined();
  });

  it('keeps a successfully merged issue skipped when it reappears mid-run', async () => {
    setMockIssues([
      {
        number: 1,
        title: 'Reopened issue',
        labels: ['shipper:ready'],
        nextLabels: [],
        prNumber: 601,
      },
      {
        number: 2,
        title: 'Next issue',
        labels: ['shipper:ready'],
        nextLabels: [],
        prNumber: 602,
      },
    ]);

    let reopened = false;
    postMergeMock.mockImplementation((_pr: unknown, issueNumber: number | string) => {
      const issue = mockIssues.get(Number(issueNumber));
      if (!issue) {
        return Promise.resolve();
      }

      if (Number(issueNumber) === 1 && !reopened) {
        issue.labels = ['shipper:ready'];
        reopened = true;
        return Promise.resolve();
      }

      mockIssues.delete(Number(issueNumber));
      return Promise.resolve();
    });

    await shipCommand(repo, undefined, { auto: true, merge: false });

    expect(postMergeMock.mock.calls.map(([, issueNumber]) => Number(issueNumber))).toEqual([1, 2]);
    expect(mockIssues.get(1)?.labels).toEqual(['shipper:ready']);
    expect(mockIssues.has(2)).toBe(false);
    expect(process.exitCode).toBeUndefined();
  });

  it('runs the unblock pass before waiting for parked work when the normal queue is empty', async () => {
    setMockIssues([
      {
        number: 1,
        title: 'Parked issue',
        labels: ['shipper:pr-reviewed'],
        nextLabels: ['shipper:ready'],
        prNumber: 401,
      },
      {
        number: 2,
        title: 'Queue issue',
        labels: ['shipper:planned'],
        nextLabels: [
          'shipper:implemented',
          'shipper:pr-open',
          'shipper:pr-reviewed',
          'shipper:ready',
        ],
        prNumber: 402,
      },
      {
        number: 3,
        title: 'Blocked issue',
        labels: ['shipper:planned', 'shipper:blocked'],
        nextLabels: [],
      },
    ]);

    let parkedReady = false;
    mockBuildReadyCheck.mockImplementation((_repo: string, pr: string) => {
      if (pr === '401') {
        return Promise.resolve(() => Promise.resolve(parkedReady));
      }
      return Promise.resolve(() => Promise.resolve(true));
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const runPromise = shipCommand(repo, undefined, { auto: true, merge: false });

    await flushMicrotasks();
    expect(getIssuedCalls(mockSpawn.mock.calls).includes('1')).toBe(false);
    expect(getIssuedCalls(mockSpawn.mock.calls).includes('2')).toBe(true);

    parkedReady = true;
    await vi.advanceTimersByTimeAsync(20_000);
    await runPromise;

    const output = getConsoleOutput(logSpy);
    expect(output).toContain('Auto: attempting unblock of #3');
    expect(output).toContain('✓ pass');
    expect(process.exitCode).toBe(1);

    logSpy.mockRestore();
  });

  it('writes one log file per sequential auto issue and prints the log summary block', async () => {
    vi.setSystemTime(new Date('2026-03-06T02:30:00'));
    setMockIssues([
      {
        number: 1,
        title: 'First issue',
        labels: ['shipper:planned'],
        nextLabels: ['shipper:ready'],
        prNumber: 101,
      },
      {
        number: 2,
        title: 'Second issue',
        labels: ['shipper:planned'],
        nextLabels: ['shipper:ready'],
        prNumber: 102,
      },
    ]);
    installSequentialCliMocks({
      stageOutput: (issueNumber) =>
        issueNumber === 1
          ? {
              stdout: 'first stdout\n',
              stderr:
                '[shipper] ▶ stage:implement #1 starting\n' +
                '[shipper] ✓ stage:implement #1 complete (12s)\n' +
                'first stderr\n',
            }
          : {
              stdout: 'second stdout\n',
              stderr:
                '[shipper] ▶ stage:implement #2 starting\n' +
                '[shipper] ✓ stage:implement #2 complete (8s)\n',
            },
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await shipCommand(repo, undefined, { auto: true, merge: false, parallel: 1 });

    const logFile1 = '/mock-home/.shipper/logs/ship-1-20260306T023000.log';
    const logFile2 = '/mock-home/.shipper/logs/ship-2-20260306T023000.log';
    expect(mockMkdirSync).toHaveBeenCalledWith('/mock-home/.shipper/logs', {
      recursive: true,
      mode: 0o700,
    });
    expect(mockCreateWriteStream).toHaveBeenCalledWith(logFile1);
    expect(mockCreateWriteStream).toHaveBeenCalledWith(logFile2);
    expect(stdoutWriteSpy).toHaveBeenCalledWith(expect.any(Buffer));
    expect(stderrWriteSpy).toHaveBeenCalledWith(expect.any(Buffer));

    const output = getConsoleOutput(logSpy);
    expect(output).toContain('  Log files:');
    expect(output).toContain('  #1   ~/.shipper/logs/ship-1-20260306T023000.log');
    expect(output).toContain('  #2   ~/.shipper/logs/ship-2-20260306T023000.log');
    expect(fsMockState.capturedLogs.get(logFile1)).toContain(
      '[shipper] ▶ stage:implement #1 starting'
    );
    expect(fsMockState.capturedLogs.get(logFile1)).toContain(
      '[shipper] ✓ stage:implement #1 complete (12s)'
    );
    expect(fsMockState.capturedLogs.get(logFile1)).toContain('first stdout');
    expect(fsMockState.capturedLogs.get(logFile1)).toContain('first stderr');
    expect(fsMockState.capturedLogs.get(logFile1)).not.toContain('[shipper] first stdout');
    expect(fsMockState.capturedLogs.get(logFile1)).not.toContain('[shipper] first stderr');
    expect(fsMockState.capturedLogs.get(logFile2)).toContain(
      '[shipper] ▶ stage:implement #2 starting'
    );
    expect(fsMockState.capturedLogs.get(logFile2)).toContain(
      '[shipper] ✓ stage:implement #2 complete (8s)'
    );
    expect(fsMockState.capturedLogs.get(logFile2)).toContain('second stdout');

    stdoutWriteSpy.mockRestore();
    stderrWriteSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('aggregates persisted token totals for sequential auto summary rows', async () => {
    setMockIssues([
      {
        number: 1,
        title: 'Tokenized issue',
        labels: ['shipper:planned'],
        nextLabels: ['shipper:ready'],
        prNumber: 101,
      },
    ]);
    mockAggregateSessionUsage.mockResolvedValueOnce({
      inputTokens: 10,
      outputTokens: 3,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await shipCommand(repo, undefined, { auto: true, merge: false, parallel: 1 });

    expect(mockAggregateSessionUsage).toHaveBeenCalledWith(repo, '1', expect.any(Date));
    expect(mockTotalTokens).toHaveBeenCalledWith({
      inputTokens: 10,
      outputTokens: 3,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
    });
    expect(getConsoleOutput(logSpy)).toContain('13');

    logSpy.mockRestore();
  });

  it('aggregates persisted token totals for sequential auto summary rows in headless mode', async () => {
    mockResolveMode.mockImplementation((_step, override) => override ?? 'headless');
    setMockIssues([
      {
        number: 1,
        title: 'Tokenized issue',
        labels: ['shipper:planned'],
        nextLabels: ['shipper:ready'],
        prNumber: 101,
      },
    ]);
    mockAggregateSessionUsage.mockResolvedValueOnce({
      inputTokens: 10,
      outputTokens: 3,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await shipCommand(repo, undefined, { auto: true, merge: false, parallel: 1 });

    expect(mockAggregateSessionUsage).toHaveBeenCalledWith(repo, '1', expect.any(Date));
    expect(mockTotalTokens).toHaveBeenCalledWith({
      inputTokens: 10,
      outputTokens: 3,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
    });
    expect(getConsoleOutput(logSpy)).toContain('13');

    logSpy.mockRestore();
  });

  it('shows an em dash for auto summary rows when issue usage is missing', async () => {
    setMockIssues([
      {
        number: 1,
        title: 'Missing usage',
        labels: ['shipper:planned'],
        nextLabels: ['shipper:ready'],
        prNumber: 101,
      },
    ]);
    mockAggregateSessionUsage.mockResolvedValueOnce(undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await shipCommand(repo, undefined, { auto: true, merge: false, parallel: 1 });

    expect(mockAggregateSessionUsage).toHaveBeenCalledWith(repo, '1', expect.any(Date));
    expect(mockTotalTokens).not.toHaveBeenCalled();
    expect(getConsoleOutput(logSpy)).toMatch(/Missing usage.*—\s+✓ pass/s);

    logSpy.mockRestore();
  });

  it('warns and omits total tokens when usage aggregation fails', async () => {
    setMockIssues([
      {
        number: 1,
        title: 'Usage failure',
        labels: ['shipper:planned'],
        nextLabels: ['shipper:ready'],
        prNumber: 101,
      },
    ]);
    mockAggregateSessionUsage.mockRejectedValueOnce(new Error('session read failed'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await shipCommand(repo, undefined, { auto: true, merge: false, parallel: 1 });

      expect(warnSpy).toHaveBeenCalledWith(prefixed('Failed to resolve total tokens for issue #1'));
      expect(mockTotalTokens).not.toHaveBeenCalled();
      expect(getConsoleOutput(logSpy)).toMatch(/Usage failure.*—\s+✓ pass/s);
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('does not enable parking for non-auto ship runs', async () => {
    setMockIssues([
      {
        number: 1,
        title: 'Single issue',
        labels: ['shipper:planned'],
        nextLabels: [
          'shipper:implemented',
          'shipper:pr-open',
          'shipper:pr-reviewed',
          'shipper:ready',
        ],
        prNumber: 501,
      },
    ]);

    await shipCommand(repo, '1', { auto: false, merge: true });

    expect(mockBuildReadyCheck).not.toHaveBeenCalled();
    expect(getIssuedCalls(mockSpawn.mock.calls)).toEqual(['1', '1', '1', '1']);
  });

  it('silently excludes shipper:new issues from sequential auto selection and summary', async () => {
    setMockIssues([
      {
        number: 1,
        title: 'Needs grooming',
        labels: ['shipper:new'],
        nextLabels: ['shipper:groomed'],
      },
      {
        number: 2,
        title: 'Eligible issue',
        labels: ['shipper:planned'],
        nextLabels: ['shipper:ready'],
        prNumber: 102,
      },
    ]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await shipCommand(repo, undefined, { auto: true, merge: false, parallel: 1 });

    expect(getIssuedCalls(mockSpawn.mock.calls)).toEqual(['2']);
    const output = getConsoleOutput(logSpy);
    expect(output).toContain('Auto run complete.');
    expect(output).toContain('Eligible issue');
    expect(output).not.toContain('Needs grooming');
    expect(output).not.toContain('shipper:new');

    logSpy.mockRestore();
  });

  it('reports no eligible issues when shipper:new is the only workflow issue', async () => {
    setMockIssues([
      {
        number: 1,
        title: 'Needs grooming',
        labels: ['shipper:new'],
        nextLabels: ['shipper:groomed'],
      },
    ]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await shipCommand(repo, undefined, { auto: true, merge: false, parallel: 1 });

    expect(mockSpawn).not.toHaveBeenCalled();
    const output = getConsoleOutput(logSpy);
    expect(output).toContain('Auto run complete. No eligible issues found.');
    expect(output).not.toContain('Needs grooming');
    expect(output).not.toContain('#1');

    logSpy.mockRestore();
  });
});

describe('shipCommand auto skip handling', () => {
  beforeEach(() => {
    mockSelectIssuesForStage.mockReset();
    mockClearStaleLockIfNeeded.mockReset();
    mockGh.mockReset();
    mockSpawn.mockReset();
    mockSpawn.mockImplementation(() => {
      const child = new FakeChildProcess();
      globalThis.queueMicrotask(() => {
        child.finish(0);
      });
      return child as never;
    });
    exitSpy.mockClear();
  });

  it('stops and skips an issue when a stage resets it to shipper:new', async () => {
    let plannedSelections = 0;
    mockSelectIssuesForStage.mockImplementation((_repo: string, label: string) => {
      if (label === 'shipper:planned') {
        plannedSelections++;
        return withDefaultPriority([{ number: 42, title: 'Reset issue' }]);
      }
      return [];
    });

    let viewCount = 0;
    mockGh.mockImplementation((args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view') {
        viewCount++;
        return {
          stdout: `${viewCount === 1 ? 'shipper:planned' : 'shipper:new'}\n`,
          stderr: '',
        };
      }

      if (args[0] === 'issue' && args[1] === 'list') {
        return { stdout: '[]', stderr: '' };
      }

      throw new Error(`Unexpected gh args: ${args.join(' ')}`);
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await shipCommand(repo, undefined, { auto: true, merge: false, parallel: 1 });

    const message =
      'Issue #42 was reset to shipper:new by stage "implement" - stopping to avoid interactive groom stage.';
    const logOutput = getConsoleOutput(logSpy);
    const errorOutput = getConsoleOutput(errorSpy);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(plannedSelections).toBeGreaterThanOrEqual(2);
    expect(
      getConsoleEntries(logSpy).filter((entry) => entry.includes('Auto: advancing issue #42'))
    ).toHaveLength(1);
    expect(errorOutput).toContain(message);
    expect(logOutput).toContain(`✗ fail — ${message}`);
    expect(process.exitCode).toBe(1);

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
