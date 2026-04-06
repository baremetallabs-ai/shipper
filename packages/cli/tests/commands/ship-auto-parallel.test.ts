import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterAll, describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
const handleAgentCrashMock = vi.hoisted(() =>
  vi.fn<
    (repo: string, issue: string, stage: string, detail: string, summary?: string) => Promise<void>
  >(() => Promise.resolve())
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
  buildReadyCheck: vi.fn(),
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
  gh,
  fetchChecks,
  classifyChecks,
  retryOnInvalidOutput,
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
const mockGh = vi.mocked(gh);
const mockFetchChecks = vi.mocked(fetchChecks);
const mockClassifyChecks = vi.mocked(classifyChecks);
const mockRetryOnInvalidOutput = vi.mocked(retryOnInvalidOutput);
const mockResolveMode = resolveModeMock;
const mockTotalTokens = vi.mocked(totalTokens);
const mockWithStageHooks = vi.mocked(withStageHooks);
const mockWithIssueLock = vi.mocked(withIssueLock);
const mockReleaseIssueLock = vi.mocked(releaseIssueLock);
const mockRunPrompt = vi.mocked(runPrompt);
const mockHandleAgentCrash = handleAgentCrashMock;
const mockPrepareUnblockContext = prepareUnblockContextMock;
const mockProcessResult = processResultMock;
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
function defaultWithIssueLock<T>(_repo: string, _issue: string, fn: () => Promise<T>): Promise<T> {
  return fn();
}
function setupReadyMergeFlow(options?: {
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
function findGhCalls(command: string, subcommand: string): string[][] {
  return mockGh.mock.calls
    .map(([args]) => args)
    .filter((args) => args[0] === command && args[1] === subcommand);
}
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}
function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
function getConsoleOutput(spy: { mock: { calls: readonly unknown[][] } }): string {
  return spy.mock.calls.map((call) => String(call[0])).join('\n');
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
function _setMockIssues(issues: MockIssueState[]): void {
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
function _installSequentialCliMocks(options?: {
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
describe('shipCommand auto merge-failure retry handling', () => {
  beforeEach(() => {
    mockSelectIssuesForStage.mockReset();
    mockClearStaleLockIfNeeded.mockReset();
    mockGh.mockReset();
    mockFetchChecks.mockReset();
    mockFetchChecks.mockResolvedValue([]);
    mockClassifyChecks.mockReset();
    mockClassifyChecks.mockReturnValue({ pending: [], failed: [], passed: [], total: 0 });
    mockWithStageHooks.mockReset();
    mockWithStageHooks.mockImplementation(defaultWithStageHooks);
    mockWithIssueLock.mockReset();
    mockWithIssueLock.mockImplementation(defaultWithIssueLock);
    mockSpawn.mockReset();
    postMergeMock.mockClear();
    postMergeMock.mockResolvedValue(undefined);
    exitSpy.mockClear();
  });

  it('does not blacklist a retriable merge failure in sequential auto mode', async () => {
    let readySelections = 0;
    mockSelectIssuesForStage.mockImplementation((_repo: string, label: string) => {
      if (label === 'shipper:ready' && readySelections < 2) {
        readySelections++;
        return withDefaultPriority([{ number: 123, title: 'Retry merge issue' }]);
      }
      return [];
    });
    setupReadyMergeFlow({ mergeStates: ['DIRTY'] });

    await shipCommand(repo, undefined, { auto: true, merge: false, parallel: 1 });

    expect(findGhCalls('pr', 'list')).toHaveLength(2);
    expect(process.exitCode).toBe(1);
  });

  it('blacklists a non-merge hook failure in sequential auto mode', async () => {
    let readySelections = 0;
    mockSelectIssuesForStage.mockImplementation((_repo: string, label: string) => {
      if (label === 'shipper:ready' && readySelections < 2) {
        readySelections++;
        return withDefaultPriority([{ number: 123, title: 'Hook failure issue' }]);
      }
      return [];
    });
    setupReadyMergeFlow({ mergeStates: ['CLEAN'] });
    mockWithStageHooks.mockImplementation(() => {
      throw new Error('pre-merge hook exited with code 1');
    });

    await shipCommand(repo, undefined, { auto: true, merge: false, parallel: 1 });

    expect(findGhCalls('pr', 'list')).toHaveLength(1);
    expect(process.exitCode).toBe(1);
  });

  it('does not blacklist a child-process merge failure in parallel auto mode', async () => {
    let candidateAvailable = true;
    mockSelectIssuesForStage.mockImplementation((_repo: string, label: string) => {
      if (label === 'shipper:ready' && candidateAvailable) {
        return withDefaultPriority([{ number: 1, title: 'Retry merge issue' }]);
      }
      return [];
    });
    mockGh.mockResolvedValue({ stdout: '[]', stderr: '' });

    const child1 = new FakeChildProcess();
    const child2 = new FakeChildProcess();
    mockSpawn.mockReturnValueOnce(child1 as never).mockImplementationOnce(() => {
      candidateAvailable = false;
      return child2 as never;
    });

    const runPromise = shipCommand(repo, undefined, { auto: true, merge: false, parallel: 2 });

    await flushMicrotasks();
    child1.finish(
      1,
      null,
      'Merge failed for PR #456: PR #456 has merge conflicts that must be resolved.'
    );
    await flushMicrotasks();
    await new Promise<void>((resolve) => {
      process.nextTick(resolve);
    });

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    child2.finish(0);
    await runPromise;

    expect(getIssuedCalls(mockSpawn.mock.calls)).toEqual(['1', '1']);
    expect(process.exitCode).toBe(1);
  });
});
describe('shipCommand parallel auto runner', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    mockSelectIssuesForStage.mockReset();
    mockClearStaleLockIfNeeded.mockReset();
    mockGh.mockReset();
    mockGh.mockResolvedValue({ stdout: '[]', stderr: '' });
    mockRetryOnInvalidOutput.mockReset();
    mockRetryOnInvalidOutput.mockResolvedValue({
      verdict: 'accept',
      comment: '.shipper/output/comment-7.md',
    });
    mockRunPrompt.mockReset();
    mockRunPrompt.mockResolvedValue(0);
    mockHandleAgentCrash.mockReset();
    mockHandleAgentCrash.mockResolvedValue(undefined);
    mockPrepareUnblockContext.mockReset();
    mockPrepareUnblockContext.mockResolvedValue(undefined);
    mockProcessResult.mockReset();
    mockProcessResult.mockImplementation((result?: { issueNumber?: string; stage?: string }) => {
      if (result?.stage === 'unblock') {
        const issue = mockIssues.get(Number(result.issueNumber));
        if (issue) {
          issue.labels = issue.labels.filter((label) => label !== 'shipper:blocked');
        }
      }

      return Promise.resolve({
        verdict: 'accept',
        comment: '.shipper/output/comment-7.md',
      });
    });
    mockSpawn.mockReset();
    mockReleaseIssueLock.mockReset();
    mockCreateWriteStream.mockClear();
    mockMkdirSync.mockClear();
    mockHomedir.mockClear();
    mockHomedir.mockReturnValue('/mock-home');
    fsMockState.capturedLogs.clear();
    exitSpy.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fills slots immediately and refills on the first completion', async () => {
    let plannedIssues = [
      { number: 1, title: 'Issue one' },
      { number: 2, title: 'Issue two' },
      { number: 3, title: 'Issue three' },
    ];
    mockSelectIssuesForStage.mockImplementation((_repo: string, label: string) => {
      if (label === 'shipper:planned') return withDefaultPriority(plannedIssues);
      return [];
    });

    const child1 = new FakeChildProcess();
    const child2 = new FakeChildProcess();
    const child3 = new FakeChildProcess();
    mockSpawn
      .mockReturnValueOnce(child1 as never)
      .mockReturnValueOnce(child2 as never)
      .mockReturnValueOnce(child3 as never);

    const runPromise = shipCommand(repo, undefined, { auto: true, merge: false, parallel: 2 });

    await flushMicrotasks();
    const cliEntrypoint = process.argv[1];
    expect(cliEntrypoint).toBeDefined();

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(mockSpawn.mock.calls[0]?.[1]).toEqual([cliEntrypoint, 'ship', '1', '--merge']);
    expect(mockSpawn.mock.calls[1]?.[1]).toEqual([cliEntrypoint, 'ship', '2', '--merge']);

    plannedIssues = plannedIssues.filter((issue) => issue.number !== 1);
    child1.finish(0);
    await flushMicrotasks();
    await new Promise<void>((resolve) => {
      process.nextTick(resolve);
    });

    expect(mockSpawn).toHaveBeenCalledTimes(3);
    expect(mockSpawn.mock.calls[2]?.[1]).toEqual([cliEntrypoint, 'ship', '3', '--merge']);
    expect(
      mockSelectIssuesForStage.mock.calls.filter(([, label]) => label === 'shipper:planned').length
    ).toBeGreaterThanOrEqual(3);

    plannedIssues = plannedIssues.filter((issue) => issue.number !== 2);
    child2.finish(0);
    await flushMicrotasks();
    plannedIssues = plannedIssues.filter((issue) => issue.number !== 3);
    child3.finish(0);
    await runPromise;

    expect(process.exitCode).toBeUndefined();
  });

  it('marks parallel ship children as auto-child runs', async () => {
    let plannedIssues = [{ number: 1, title: 'Issue one' }];
    mockSelectIssuesForStage.mockImplementation((_repo: string, label: string) => {
      if (label === 'shipper:planned') return withDefaultPriority(plannedIssues);
      return [];
    });

    const child = new FakeChildProcess();
    mockSpawn.mockReturnValueOnce(child as never);

    const runPromise = shipCommand(repo, undefined, { auto: true, merge: false, parallel: 2 });

    await flushMicrotasks();

    expect(getCallEnv(mockSpawn.mock.calls[0])).toEqual(
      expect.objectContaining({ SHIPPER_AUTO_CHILD_RUN: '1' })
    );

    plannedIssues = [];
    child.finish(0);
    await runPromise;

    expect(process.exitCode).toBeUndefined();
  });

  it('skips a successful completion when the same issue is still returned on refill', async () => {
    const plannedIssues = [
      { number: 1, title: 'Issue one' },
      { number: 2, title: 'Issue two' },
      { number: 3, title: 'Issue three' },
    ];
    mockSelectIssuesForStage.mockImplementation((_repo: string, label: string) => {
      if (label === 'shipper:planned') return withDefaultPriority(plannedIssues);
      return [];
    });

    const child1 = new FakeChildProcess();
    const child2 = new FakeChildProcess();
    const child3 = new FakeChildProcess();
    mockSpawn
      .mockReturnValueOnce(child1 as never)
      .mockReturnValueOnce(child2 as never)
      .mockReturnValueOnce(child3 as never);

    const runPromise = shipCommand(repo, undefined, { auto: true, merge: false, parallel: 2 });

    await flushMicrotasks();
    child1.finish(0);
    await flushMicrotasks();
    await new Promise<void>((resolve) => {
      process.nextTick(resolve);
    });

    const cliEntrypoint = process.argv[1];
    expect(cliEntrypoint).toBeDefined();
    expect(mockSpawn).toHaveBeenCalledTimes(3);
    expect(mockSpawn.mock.calls[2]?.[1]).toEqual([cliEntrypoint, 'ship', '3', '--merge']);

    child2.finish(0);
    await flushMicrotasks();
    child3.finish(0);
    await runPromise;

    expect(getIssuedCalls(mockSpawn.mock.calls)).toEqual(['1', '2', '3']);
    expect(process.exitCode).toBeUndefined();
  });

  it('forwards an explicit model override to child ship processes', async () => {
    let plannedIssues = [{ number: 1, title: 'Issue one' }];
    mockSelectIssuesForStage.mockImplementation((_repo: string, label: string) => {
      if (label === 'shipper:planned') return withDefaultPriority(plannedIssues);
      return [];
    });

    const child = new FakeChildProcess();
    mockSpawn.mockReturnValueOnce(child as never);

    const runPromise = shipCommand(repo, undefined, {
      auto: true,
      merge: false,
      parallel: 2,
      model: 'gpt-5',
    });

    await flushMicrotasks();

    const cliEntrypoint = process.argv[1];
    expect(cliEntrypoint).toBeDefined();
    const firstCall = mockSpawn.mock.calls[0];
    expect(firstCall?.[0]).toBe(process.execPath);
    expect(firstCall?.[1]).toEqual([cliEntrypoint, 'ship', '1', '--merge', '--model', 'gpt-5']);
    expect(getCallEnv(firstCall)).toEqual(expect.objectContaining({ SHIPPER_AUTO_CHILD_RUN: '1' }));

    plannedIssues = [];
    child.finish(0);
    await runPromise;
  });

  it('forwards model overrides through unblock attempts in auto mode', async () => {
    let readyReturned = false;
    let blockedReturned = false;

    mockSelectIssuesForStage.mockImplementation((_repo: string, label: string) => {
      if (label === 'shipper:ready' && !readyReturned) {
        readyReturned = true;
        return [];
      }
      return [];
    });

    mockGh.mockImplementation((args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list' && !blockedReturned) {
        blockedReturned = true;
        return {
          stdout: JSON.stringify([
            {
              number: 7,
              title: 'Blocked issue',
              labels: [{ name: 'shipper:planned' }, { name: 'shipper:blocked' }],
            },
          ]),
          stderr: '',
        };
      }

      if (args[0] === 'issue' && args[1] === 'list') {
        return { stdout: '[]', stderr: '' };
      }

      if (args[0] === 'issue' && args[1] === 'view') {
        return { stdout: 'shipper:planned\n', stderr: '' };
      }

      return { stdout: '[]', stderr: '' };
    });

    await shipCommand(repo, undefined, {
      auto: true,
      merge: false,
      parallel: 1,
      model: 'haiku',
    });

    expect(mockRunPrompt).toHaveBeenCalledWith(
      'unblock',
      expect.objectContaining({
        repo,
        issueRef: '7',
        agent: undefined,
        model: 'haiku',
      })
    );
    const unblockCall = mockRunPrompt.mock.calls.find(([name]) => name === 'unblock');
    const unblockOpts = unblockCall?.[1] as Record<string, unknown> | undefined;
    expect(unblockOpts).toBeDefined();
    expect(String(unblockOpts?.logFile)).toMatch(/unblock-7-\d{8}T\d{6}\.log$/);
    expect(mockRetryOnInvalidOutput).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: process.cwd(), stage: 'unblock' })
    );
    expect(mockPrepareUnblockContext).toHaveBeenCalledWith(repo, '7', process.cwd());
    expect(mockProcessResult).toHaveBeenCalledWith({
      repo,
      issueNumber: '7',
      stage: 'unblock',
      cwd: process.cwd(),
      result: { verdict: 'accept', comment: '.shipper/output/comment-7.md' },
    });
  });

  it('captures combined child output in per-issue log files and prints prefixed parallel status lines', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-06T02:30:00'));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    let plannedIssues = [
      { number: 1, title: 'Issue one' },
      { number: 2, title: 'Issue two' },
    ];
    mockSelectIssuesForStage.mockImplementation((_repo: string, label: string) => {
      if (label === 'shipper:planned') return withDefaultPriority(plannedIssues);
      return [];
    });
    mockGh.mockImplementation((args: string[]) => {
      if (args.includes('list')) {
        return {
          stdout: JSON.stringify([
            {
              number: 7,
              title: 'Blocked issue',
              labels: [{ name: 'shipper:planned' }, { name: 'shipper:blocked' }],
            },
          ]),
          stderr: '',
        };
      }

      if (args.includes('view')) {
        return { stdout: 'shipper:planned\nshipper:blocked', stderr: '' };
      }

      return { stdout: '[]', stderr: '' };
    });
    mockProcessResult.mockResolvedValue({
      verdict: 'reject',
      comment: '.shipper/output/comment-7.md',
    });

    const child1 = new FakeChildProcess();
    const child2 = new FakeChildProcess();
    mockSpawn.mockReturnValueOnce(child1 as never).mockReturnValueOnce(child2 as never);

    const runPromise = shipCommand(repo, undefined, { auto: true, merge: false, parallel: 2 });

    await flushMicrotasks();

    const logFile1 = '/mock-home/.shipper/logs/ship-1-20260306T023000.log';
    const logFile2 = '/mock-home/.shipper/logs/ship-2-20260306T023000.log';

    expect(mockMkdirSync).toHaveBeenCalledWith('/mock-home/.shipper/logs', {
      recursive: true,
      mode: 0o700,
    });
    expect(mockSpawn.mock.calls[0]?.[2]).toMatchObject({ stdio: ['ignore', 'pipe', 'pipe'] });
    expect(mockSpawn.mock.calls[1]?.[2]).toMatchObject({ stdio: ['ignore', 'pipe', 'pipe'] });
    expect(mockCreateWriteStream).toHaveBeenCalledWith(logFile1);
    expect(mockCreateWriteStream).toHaveBeenCalledWith(logFile2);

    plannedIssues = plannedIssues.filter((issue) => issue.number !== 1);
    child1.stderr.write('[shipper] ▶ stage:implement #1 starting\n');
    child1.stderr.write('lock acquired\n');
    child1.stderr.write('[shipper] ✓ stage:implement #1 complete (12s)\n');
    child1.finish(0);
    await flushMicrotasks();

    plannedIssues = plannedIssues.filter((issue) => issue.number !== 2);
    child2.stderr.write('[shipper] ▶ stage:merge #2 starting\n');
    child2.stderr.write('boom\n');
    child2.stderr.write('[shipper] ✗ stage:merge #2 failed (5s)\n');
    child2.finish(1);
    await runPromise;

    const output = getConsoleOutput(logSpy);

    expect(output).toContain('[#1] Auto: advancing issue #1 — Issue one');
    expect(output).toContain('[#2] Auto: advancing issue #2 — Issue two');
    expect(output).toContain('[#1] ✓ pass');
    expect(output).toContain('[#2] ✗ fail');
    expect(output).toContain('[#7] Auto: attempting unblock of #7 — Blocked issue');
    expect(output).toContain('Auto run complete.');
    expect(output).toContain(
      '  Ref              Issue                                          Outcome'
    );
    expect(output).toContain('✗ fail — boom');
    expect(output).toContain('  Unblock attempts:');
    expect(output).toContain('unblock #7');
    expect(output).toContain('Unblock log files:');
    expect(output).toContain('~/.shipper/logs/unblock-7-20260306T023000.log');
    expect(output).toContain('  Log files:');
    expect(output).toContain('  #1   ~/.shipper/logs/ship-1-20260306T023000.log');
    expect(output).toContain('  #2   ~/.shipper/logs/ship-2-20260306T023000.log');
    expect(output).not.toContain('[#1] Auto run complete.');
    expect(output).not.toContain('[#7] Unblock attempts:');
    expect(output).not.toContain('lock acquired');

    expect(fsMockState.capturedLogs.get(logFile1)).toContain(
      '[shipper] ▶ stage:implement #1 starting'
    );
    expect(fsMockState.capturedLogs.get(logFile1)).toContain(
      '[shipper] ✓ stage:implement #1 complete (12s)'
    );
    expect(fsMockState.capturedLogs.get(logFile1)).toContain('lock acquired');
    expect(fsMockState.capturedLogs.get(logFile2)).toContain('[shipper] ▶ stage:merge #2 starting');
    expect(fsMockState.capturedLogs.get(logFile2)).toContain(
      '[shipper] ✗ stage:merge #2 failed (5s)'
    );
    expect(fsMockState.capturedLogs.get(logFile2)).toContain('boom');

    logSpy.mockRestore();
  });

  it('aggregates token totals for both passing and failing parallel rows', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    let plannedIssues = [
      { number: 1, title: 'Issue one' },
      { number: 2, title: 'Issue two' },
    ];
    mockSelectIssuesForStage.mockImplementation((_repo: string, label: string) => {
      if (label === 'shipper:planned') return withDefaultPriority(plannedIssues);
      return [];
    });
    mockAggregateSessionUsage
      .mockResolvedValueOnce({
        inputTokens: 8,
        outputTokens: 5,
        cacheReadTokens: 2,
        cacheWriteTokens: 0,
      })
      .mockResolvedValueOnce({
        inputTokens: 7,
        outputTokens: 2,
        cacheReadTokens: 1,
        cacheWriteTokens: 0,
      });

    const child1 = new FakeChildProcess();
    const child2 = new FakeChildProcess();
    mockSpawn.mockReturnValueOnce(child1 as never).mockReturnValueOnce(child2 as never);

    const runPromise = shipCommand(repo, undefined, { auto: true, merge: false, parallel: 2 });

    await flushMicrotasks();
    plannedIssues = plannedIssues.filter((issue) => issue.number !== 1);
    child1.finish(0);
    await flushMicrotasks();
    plannedIssues = plannedIssues.filter((issue) => issue.number !== 2);
    child2.finish(1, null, 'boom');
    await runPromise;

    expect(mockAggregateSessionUsage).toHaveBeenCalledWith(repo, '1', expect.any(Date));
    expect(mockAggregateSessionUsage).toHaveBeenCalledWith(repo, '2', expect.any(Date));
    const output = getConsoleOutput(logSpy);
    expect(output).toContain('13');
    expect(output).toContain('9');

    logSpy.mockRestore();
  });

  it('treats unblock protocol crashes as still blocked in auto mode', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    let blockedReturned = false;
    mockSelectIssuesForStage.mockImplementation(() => []);
    mockGh.mockImplementation((args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list' && !blockedReturned) {
        blockedReturned = true;
        return {
          stdout: JSON.stringify([
            {
              number: 7,
              title: 'Blocked issue',
              labels: [{ name: 'shipper:planned' }, { name: 'shipper:blocked' }],
            },
          ]),
          stderr: '',
        };
      }

      if (args[0] === 'issue' && args[1] === 'list') {
        return { stdout: '[]', stderr: '' };
      }

      return { stdout: '[]', stderr: '' };
    });
    mockProcessResult.mockRejectedValueOnce(new Error('Missing result.json'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await shipCommand(repo, undefined, { auto: true, merge: false, parallel: 1 });

    // retryOnInvalidOutput should be called before processResult
    expect(mockRetryOnInvalidOutput).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: process.cwd(), stage: 'unblock' })
    );

    const output = getConsoleOutput(logSpy);
    expect(output).toContain('still blocked');
    expect(errorSpy).toHaveBeenCalledWith(prefixed('Missing result.json'));
    expect(mockHandleAgentCrash).toHaveBeenCalledWith(
      repo,
      '7',
      'unblock',
      'Missing result.json',
      undefined
    );

    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('treats initial non-zero unblock exits as still blocked in auto mode', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    let blockedReturned = false;
    mockSelectIssuesForStage.mockImplementation(() => []);
    mockGh.mockImplementation((args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list' && !blockedReturned) {
        blockedReturned = true;
        return {
          stdout: JSON.stringify([
            {
              number: 7,
              title: 'Blocked issue',
              labels: [{ name: 'shipper:planned' }, { name: 'shipper:blocked' }],
            },
          ]),
          stderr: '',
        };
      }

      if (args[0] === 'issue' && args[1] === 'list') {
        return { stdout: '[]', stderr: '' };
      }

      return { stdout: '[]', stderr: '' };
    });
    mockRunPrompt.mockResolvedValueOnce(17);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await shipCommand(repo, undefined, { auto: true, merge: false, parallel: 1 });

    expect(mockRetryOnInvalidOutput).not.toHaveBeenCalled();
    expect(mockProcessResult).not.toHaveBeenCalled();
    const output = getConsoleOutput(logSpy);
    expect(output).toContain('still blocked');
    expect(errorSpy).toHaveBeenCalledWith(prefixed('Agent exited with code 17'));
    expect(mockHandleAgentCrash).toHaveBeenCalledWith(
      repo,
      '7',
      'unblock',
      'Agent exited with code 17',
      'The `unblock` agent run exited with code 17.'
    );

    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('invokes the retry callback with correction text and the same logFile on invalid unblock output', async () => {
    let blockedReturned = false;
    mockSelectIssuesForStage.mockImplementation(() => []);
    mockGh.mockImplementation((args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list' && !blockedReturned) {
        blockedReturned = true;
        return {
          stdout: JSON.stringify([
            {
              number: 23,
              title: 'Retry target',
              labels: [{ name: 'shipper:planned' }, { name: 'shipper:blocked' }],
            },
          ]),
          stderr: '',
        };
      }
      if (args[0] === 'issue' && args[1] === 'list') {
        return { stdout: '[]', stderr: '' };
      }
      return { stdout: '[]', stderr: '' };
    });

    // Simulate retryOnInvalidOutput invoking the retry callback
    mockRetryOnInvalidOutput.mockImplementationOnce(async (opts) => {
      await opts.retry('Fix: missing comment field in result.json');
      return { verdict: 'accept', comment: '.shipper/output/comment-7.md' };
    });

    await shipCommand(repo, undefined, { auto: true, merge: false, parallel: 1 });

    // First call is the initial runPrompt
    expect(mockRunPrompt).toHaveBeenCalledWith(
      'unblock',
      expect.objectContaining({
        repo,
        issueRef: '23',
        agent: undefined,
        model: undefined,
      })
    );
    const firstOpts = mockRunPrompt.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(firstOpts).toBeDefined();
    expect(String(firstOpts?.logFile)).toMatch(/unblock-23-\d{8}T\d{6}\.log$/);

    // Second call is the retry with userInput and the same logFile
    const secondOpts = mockRunPrompt.mock.calls[1]?.[1] as Record<string, unknown> | undefined;
    expect(secondOpts).toBeDefined();
    expect(secondOpts?.logFile).toBe(firstOpts?.logFile);
    expect(secondOpts?.userInput).toBe('Fix: missing comment field in result.json');
    expect(secondOpts?.issueRef).toBe('23');
  });

  it('reuses a failed slot for the next candidate and skips the failed issue afterwards', async () => {
    let plannedIssues = [
      { number: 1, title: 'Issue one' },
      { number: 2, title: 'Issue two' },
      { number: 3, title: 'Issue three' },
    ];
    mockSelectIssuesForStage.mockImplementation((_repo: string, label: string) => {
      if (label === 'shipper:planned') return withDefaultPriority(plannedIssues);
      return [];
    });

    const child1 = new FakeChildProcess();
    const child2 = new FakeChildProcess();
    const child3 = new FakeChildProcess();
    mockSpawn
      .mockReturnValueOnce(child1 as never)
      .mockReturnValueOnce(child2 as never)
      .mockReturnValueOnce(child3 as never);

    const runPromise = shipCommand(repo, undefined, { auto: true, merge: false, parallel: 2 });

    await flushMicrotasks();
    plannedIssues = plannedIssues.filter((issue) => issue.number !== 1);
    child1.finish(1, null, 'boom');
    await flushMicrotasks();
    await new Promise<void>((resolve) => {
      process.nextTick(resolve);
    });

    expect(mockSpawn).toHaveBeenCalledTimes(3);
    expect(getIssuedCalls(mockSpawn.mock.calls)).toEqual(['1', '2', '3']);

    plannedIssues = plannedIssues.filter((issue) => issue.number !== 2);
    child2.finish(0);
    await flushMicrotasks();
    plannedIssues = plannedIssues.filter((issue) => issue.number !== 3);
    child3.finish(0);
    await runPromise;
    expect(process.exitCode).toBe(1);
  });

  it('waits for all active slots to drain before running the unblock pass', async () => {
    let plannedIssues = [
      { number: 1, title: 'Issue one' },
      { number: 2, title: 'Issue two' },
    ];
    mockSelectIssuesForStage.mockImplementation((_repo: string, label: string) => {
      if (label === 'shipper:planned') {
        return withDefaultPriority(plannedIssues);
      }
      return [];
    });

    const child1 = new FakeChildProcess();
    const child2 = new FakeChildProcess();
    mockSpawn.mockReturnValueOnce(child1 as never).mockReturnValueOnce(child2 as never);

    const runPromise = shipCommand(repo, undefined, { auto: true, merge: false, parallel: 2 });

    await flushMicrotasks();
    plannedIssues = plannedIssues.filter((issue) => issue.number !== 1);
    child1.finish(0);
    await flushMicrotasks();

    expect(mockGh).not.toHaveBeenCalled();

    plannedIssues = plannedIssues.filter((issue) => issue.number !== 2);
    child2.finish(0);
    await runPromise;

    expect(mockGh).toHaveBeenCalledTimes(1);
    expect(mockGh).toHaveBeenCalledWith(
      expect.arrayContaining(['issue', 'list', '-R', repo, '--label', 'shipper:blocked'])
    );
  });

  it('uses the sequential helper when parallel is not enabled', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    mockSelectIssuesForStage.mockReturnValue([]);

    await shipCommand(repo, undefined, { auto: true, merge: false, parallel: undefined });

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockCreateWriteStream).not.toHaveBeenCalled();
    expect(mockMkdirSync).toHaveBeenCalledWith('/mock-home/.shipper/logs', {
      recursive: true,
      mode: 0o700,
    });
    expect(mockSelectIssuesForStage).toHaveBeenCalled();
    expect(getConsoleOutput(logSpy)).not.toContain('[#');
    expect(process.exitCode).toBeUndefined();

    logSpy.mockRestore();
  });

  it('uses the sequential helper when parallel is 1', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    mockSelectIssuesForStage.mockReturnValue([]);

    await shipCommand(repo, undefined, { auto: true, merge: false, parallel: 1 });

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockCreateWriteStream).not.toHaveBeenCalled();
    expect(mockMkdirSync).toHaveBeenCalledWith('/mock-home/.shipper/logs', {
      recursive: true,
      mode: 0o700,
    });
    expect(mockSelectIssuesForStage).toHaveBeenCalled();
    expect(getConsoleOutput(logSpy)).not.toContain('[#');
    expect(process.exitCode).toBeUndefined();

    logSpy.mockRestore();
  });

  it('fails the issue instead of crashing when the log stream errors before child exit', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockSelectIssuesForStage.mockImplementation((_repo: string, label: string) => {
      if (label === 'shipper:planned') {
        return withDefaultPriority([{ number: 1, title: 'Issue one' }]);
      }
      return [];
    });

    const child = new FakeChildProcess();
    mockSpawn.mockReturnValueOnce(child as never);
    mockCreateWriteStream.mockImplementationOnce((filePath: string) => {
      const stream = new PassThrough();
      fsMockState.capturedLogs.set(filePath, '');
      stream.on('data', (chunk: Buffer | string) => {
        fsMockState.capturedLogs.set(
          filePath,
          `${fsMockState.capturedLogs.get(filePath) ?? ''}${chunk.toString()}`
        );
      });
      process.nextTick(() => {
        stream.emit('error', new Error('disk full'));
      });
      return stream;
    });

    const runPromise = shipCommand(repo, undefined, { auto: true, merge: false, parallel: 2 });

    await flushMicrotasks();
    expect(child.kill).toHaveBeenCalled();

    child.finish(null, 'SIGTERM');
    await runPromise;

    const output = getConsoleOutput(logSpy);
    expect(output).toContain('✗ fail — failed to write log file');
    expect(output).toContain('disk full');
    expect(process.exitCode).toBe(1);

    logSpy.mockRestore();
  });

  it.each(['SIGINT', 'SIGTERM'] as const)(
    'forwards %s to active children and releases locks for survivors',
    async (signal) => {
      vi.useFakeTimers();

      let plannedIssues = [
        { number: 1, title: 'Issue one' },
        { number: 2, title: 'Issue two' },
        { number: 3, title: 'Issue three' },
      ];
      mockSelectIssuesForStage.mockImplementation((_repo: string, label: string) => {
        if (label === 'shipper:planned') {
          return withDefaultPriority(plannedIssues);
        }
        return [];
      });

      const child1 = new FakeChildProcess();
      const child2 = new FakeChildProcess();
      mockSpawn.mockReturnValueOnce(child1 as never).mockReturnValueOnce(child2 as never);

      const runPromise = shipCommand(repo, undefined, { auto: true, merge: false, parallel: 2 });

      await flushMicrotasks();
      process.emit(signal, signal);
      plannedIssues = plannedIssues.filter((issue) => issue.number !== 1);
      child1.finish(null, signal);
      await flushMicrotasks();

      expect(mockSpawn).toHaveBeenCalledTimes(2);

      plannedIssues = plannedIssues.filter((issue) => issue.number !== 2);
      await vi.advanceTimersByTimeAsync(3000);

      expect(child1.kill).toHaveBeenCalledWith(signal);
      expect(child2.kill).toHaveBeenCalledWith(signal);
      expect(child1.kill).not.toHaveBeenCalledWith('SIGKILL');
      expect(child2.kill).toHaveBeenCalledWith('SIGKILL');
      expect(mockReleaseIssueLock).not.toHaveBeenCalledWith(repo, '1');
      expect(mockReleaseIssueLock).toHaveBeenCalledWith(repo, '2');
      child2.finish(null, 'SIGKILL');
      await flushMicrotasks();
      await runPromise;
    }
  );
});

afterAll(() => {
  exitSpy.mockRestore();
});
