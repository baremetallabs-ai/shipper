import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterAll, describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  vi.fn<(repo: string, issue: string, stage: string, detail: string) => Promise<void>>(() =>
    Promise.resolve()
  )
);
const buildReadyCheckMock = vi.hoisted(() =>
  vi.fn<(repo: string, pr: string) => Promise<ReadyCheck>>()
);
const postMergeMock = vi.hoisted(() =>
  vi.fn<
    (_pr: unknown, issueNumber: number | string, repo: string, dryRun: boolean) => Promise<void>
  >(() => Promise.resolve())
);
const isPrMergedMock = vi.hoisted(() =>
  vi.fn<(prNumber: number, repo: string) => Promise<boolean | null>>(() => Promise.resolve(false))
);
const prepareUnblockContextMock = vi.hoisted(() =>
  vi.fn<(repo: string, issue: string, cwd: string) => Promise<void>>(() => Promise.resolve())
);
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
  isPrMerged: (prNumber: number, repo: string) => isPrMergedMock(prNumber, repo),
}));

vi.mock('../../src/commands/unblock.js', () => ({
  prepareUnblockContext: (repo: string, issue: string, cwd: string) =>
    prepareUnblockContextMock(repo, issue, cwd),
}));

import {
  STAGE_NAME,
  AUTO_PRIORITY_LABELS,
  printAutoSummary,
  selectNextCandidate,
  selectBlockedIssues,
  printUnblockSummary,
  shipCommand,
} from '../../src/commands/ship.js';
import type { UnblockAttempt } from '../../src/commands/ship.js';

vi.mock('@dnsquared/shipper-core', () => ({
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
  handleAgentCrash: (repo: string, issue: string, stage: string, detail: string) =>
    handleAgentCrashMock(repo, issue, stage, detail),
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
const mockFetchIssueTimelines = vi.mocked(fetchIssueTimelines);
const mockGh = vi.mocked(gh);
const mockFetchChecks = vi.mocked(fetchChecks);
const mockClassifyChecks = vi.mocked(classifyChecks);
const mockRetryOnInvalidOutput = vi.mocked(retryOnInvalidOutput);
const mockResolveMode = resolveModeMock;
const mockSortIssuesByLabelTime = vi.mocked(sortIssuesByLabelTime);
const mockTotalTokens = vi.mocked(totalTokens);
const mockWithStageHooks = vi.mocked(withStageHooks);
const mockWithIssueLock = vi.mocked(withIssueLock);
const mockReleaseIssueLock = vi.mocked(releaseIssueLock);
const mockRunPrompt = vi.mocked(runPrompt);
const mockHandleAgentCrash = handleAgentCrashMock;
const mockPrepareUnblockContext = prepareUnblockContextMock;
const mockProcessResult = processResultMock;
const mockBuildReadyCheck = buildReadyCheckMock;
const mockSpawn = vi.mocked(spawn);
const mockCreateWriteStream = fsMockState.mockCreateWriteStream;
const mockMkdirSync = fsMockState.mockMkdirSync;
const mockHomedir = osMockState.mockHomedir;
const repo = 'owner/repo';
const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
  return undefined as never;
}) as typeof process.exit);

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

describe('AUTO_PRIORITY_LABELS', () => {
  it('contains all 8 expected labels in priority order', () => {
    expect(AUTO_PRIORITY_LABELS).toEqual([
      'shipper:ready',
      'shipper:pr-reviewed',
      'shipper:pr-open',
      'shipper:implemented',
      'shipper:planned',
      'shipper:designed',
      'shipper:groomed',
      'shipper:new',
    ]);
  });

  it('has shipper:ready as the highest priority', () => {
    expect(AUTO_PRIORITY_LABELS[0]).toBe('shipper:ready');
  });

  it('has shipper:new as the lowest priority', () => {
    expect(AUTO_PRIORITY_LABELS[AUTO_PRIORITY_LABELS.length - 1]).toBe('shipper:new');
  });
});

describe('selectNextCandidate', () => {
  beforeEach(() => {
    mockSelectIssuesForStage.mockReset();
    mockSelectIssuesForStage.mockResolvedValue([]);
    mockClearStaleLockIfNeeded.mockReset();
    mockFetchIssueTimelines.mockReset();
    mockFetchIssueTimelines.mockResolvedValue(new Map());
    mockSortIssuesByLabelTime.mockReset();
    mockSortIssuesByLabelTime.mockImplementation(<T>(issues: T[]) => issues);
  });

  it('returns the issue from the highest-priority stage when priorities are equal', async () => {
    mockSelectIssuesForStage.mockImplementation((_repo: string, label: string) => {
      if (label === 'shipper:ready') return [];
      if (label === 'shipper:pr-reviewed') return [];
      if (label === 'shipper:pr-open') return [{ number: 10, title: 'PR open issue', priority: 1 }];
      if (label === 'shipper:groomed') return [{ number: 20, title: 'Groomed issue', priority: 1 }];
      return [];
    });

    const result = await selectNextCandidate(repo, new Set());
    expect(result).toEqual({ number: 10, title: 'PR open issue' });
    expect(mockSelectIssuesForStage).toHaveBeenCalledWith(
      repo,
      'shipper:ready',
      expect.any(Set),
      expect.objectContaining({ skipTimeline: true })
    );
  });

  it('skips issues in the skippedIssues set', async () => {
    mockSelectIssuesForStage.mockImplementation((_repo: string, label: string) => {
      if (label === 'shipper:pr-open')
        return [
          { number: 10, title: 'Skipped issue', priority: 1 },
          { number: 11, title: 'Next issue', priority: 1 },
        ];
      return [];
    });

    const result = await selectNextCandidate(repo, new Set([10]));
    expect(result).toEqual({ number: 11, title: 'Next issue' });
  });

  it('returns null when no candidates remain', async () => {
    mockSelectIssuesForStage.mockResolvedValue([]);

    const result = await selectNextCandidate(repo, new Set());
    expect(result).toBeNull();
  });

  it('returns null when all candidates are skipped', async () => {
    mockSelectIssuesForStage.mockImplementation((_repo: string, label: string) => {
      if (label === 'shipper:planned') return [{ number: 5, title: 'Only issue', priority: 1 }];
      return [];
    });

    const result = await selectNextCandidate(repo, new Set([5]));
    expect(result).toBeNull();
  });

  it('does not fetch timelines when only one candidate exists across all stages', async () => {
    mockSelectIssuesForStage.mockImplementation((_repo: string, label: string) => {
      if (label === 'shipper:groomed') return [{ number: 1, title: 'Only issue', priority: 1 }];
      return [];
    });

    const result = await selectNextCandidate(repo, new Set());

    expect(result).toEqual({ number: 1, title: 'Only issue' });
    expect(mockFetchIssueTimelines).not.toHaveBeenCalled();
    expect(mockSortIssuesByLabelTime).not.toHaveBeenCalled();
  });

  it('does not fetch timelines when the winning bucket has a single candidate', async () => {
    mockSelectIssuesForStage.mockImplementation((_repo: string, label: string) => {
      if (label === 'shipper:pr-open') {
        return [{ number: 30, title: 'PR open issue', priority: 1 }];
      }

      if (label === 'shipper:groomed') {
        return [
          { number: 40, title: 'High groomed issue', priority: 0 },
          { number: 41, title: 'Normal groomed issue', priority: 1 },
        ];
      }

      return [];
    });

    const result = await selectNextCandidate(repo, new Set());

    expect(result).toEqual({ number: 40, title: 'High groomed issue' });
    expect(mockFetchIssueTimelines).not.toHaveBeenCalled();
    expect(mockSortIssuesByLabelTime).not.toHaveBeenCalled();
  });

  it('fetches timelines only for the winning bucket when tie-breaking is needed', async () => {
    mockSelectIssuesForStage.mockImplementation((_repo: string, label: string) => {
      if (label === 'shipper:pr-open') {
        return [{ number: 30, title: 'Non-winning issue', priority: 2 }];
      }

      if (label === 'shipper:groomed') {
        return [
          { number: 1, title: 'Oldest', priority: 1 },
          { number: 2, title: 'Newer', priority: 1 },
        ];
      }

      return [];
    });
    mockFetchIssueTimelines.mockResolvedValue(
      new Map([
        [1, [{ created_at: '2025-01-01T00:00:00Z' }]],
        [2, [{ created_at: '2025-01-02T00:00:00Z' }]],
      ])
    );
    mockSortIssuesByLabelTime.mockImplementation((issues) => issues.slice().reverse());

    const result = await selectNextCandidate(repo, new Set());

    expect(result).toEqual({ number: 2, title: 'Newer' });
    expect(mockFetchIssueTimelines).toHaveBeenCalledTimes(1);
    expect(mockFetchIssueTimelines).toHaveBeenCalledWith(repo, [1, 2]);
    expect(mockSortIssuesByLabelTime).toHaveBeenCalledWith(
      [
        { number: 1, title: 'Oldest', priority: 1 },
        { number: 2, title: 'Newer', priority: 1 },
      ],
      expect.any(Map),
      'shipper:groomed'
    );
  });

  it('clears stale lock on selected candidate', async () => {
    mockSelectIssuesForStage.mockImplementation(
      (_repo: string, label: string, staleLocked?: Set<number>) => {
        if (label === 'shipper:planned') {
          const issues = [{ number: 7, title: 'Stale locked issue', priority: 1 as const }];
          staleLocked?.add(7);
          return Promise.resolve(issues);
        }
        return Promise.resolve([]);
      }
    );

    const result = await selectNextCandidate(repo, new Set());
    expect(result).toEqual({ number: 7, title: 'Stale locked issue' });
    expect(mockClearStaleLockIfNeeded).toHaveBeenCalledWith(repo, 7, expect.any(Set));
  });

  it('calls clearStaleLockIfNeeded with empty staleLocked set for non-stale candidate', async () => {
    mockSelectIssuesForStage.mockImplementation((_repo: string, label: string) => {
      if (label === 'shipper:planned') return [{ number: 7, title: 'Normal issue', priority: 1 }];
      return [];
    });

    const result = await selectNextCandidate(repo, new Set());
    expect(result).toEqual({ number: 7, title: 'Normal issue' });
    expect(mockClearStaleLockIfNeeded).toHaveBeenCalledWith(repo, 7, new Set());
  });

  it('skips issues already active in parallel slots', async () => {
    mockSelectIssuesForStage.mockImplementation((_repo: string, label: string) => {
      if (label === 'shipper:planned')
        return [
          { number: 7, title: 'Active issue', priority: 1 },
          { number: 8, title: 'Available issue', priority: 1 },
        ];
      return [];
    });

    const result = await selectNextCandidate(repo, new Set(), new Set([7]));
    expect(result).toEqual({ number: 8, title: 'Available issue' });
  });

  it('prefers higher-priority issues over more advanced normal-priority issues', async () => {
    mockSelectIssuesForStage.mockImplementation((_repo: string, label: string) => {
      if (label === 'shipper:pr-open') {
        return [{ number: 30, title: 'Normal PR open issue', priority: 1 }];
      }

      if (label === 'shipper:groomed') {
        return [{ number: 40, title: 'High groomed issue', priority: 0 }];
      }

      return [];
    });

    const result = await selectNextCandidate(repo, new Set());

    expect(result).toEqual({ number: 40, title: 'High groomed issue' });
    expect(mockFetchIssueTimelines).not.toHaveBeenCalled();
  });
});

describe('selectBlockedIssues', () => {
  beforeEach(() => {
    mockGh.mockReset();
  });

  it('returns empty array when no blocked issues exist', async () => {
    mockGh.mockResolvedValue({ stdout: '[]', stderr: '' });
    const result = await selectBlockedIssues(repo);
    expect(result).toEqual([]);
  });

  it('returns issues sorted by stage priority', async () => {
    const issues = [
      {
        number: 10,
        title: 'New issue',
        labels: [{ name: 'shipper:new' }, { name: 'shipper:blocked' }],
      },
      {
        number: 20,
        title: 'PR reviewed issue',
        labels: [{ name: 'shipper:pr-reviewed' }, { name: 'shipper:blocked' }],
      },
      {
        number: 30,
        title: 'Planned issue',
        labels: [{ name: 'shipper:planned' }, { name: 'shipper:blocked' }],
      },
    ];
    mockGh.mockResolvedValue({ stdout: JSON.stringify(issues), stderr: '' });

    const result = await selectBlockedIssues(repo);
    expect(result).toEqual([
      { number: 20, title: 'PR reviewed issue' },
      { number: 30, title: 'Planned issue' },
      { number: 10, title: 'New issue' },
    ]);
  });

  it('returns empty array when gh throws', async () => {
    mockGh.mockRejectedValue(new Error('gh CLI error'));
    const result = await selectBlockedIssues(repo);
    expect(result).toEqual([]);
  });

  it('passes --search flag to exclude shipper:locked issues', async () => {
    mockGh.mockResolvedValue({ stdout: '[]', stderr: '' });
    await selectBlockedIssues(repo);
    expect(mockGh).toHaveBeenCalledWith(
      expect.arrayContaining(['-R', repo, '--search', '-label:shipper:locked'])
    );
  });

  it('sorts issues with no recognized stage label to the end', async () => {
    const issues = [
      {
        number: 10,
        title: 'No stage label',
        labels: [{ name: 'shipper:blocked' }, { name: 'bug' }],
      },
      {
        number: 20,
        title: 'Groomed issue',
        labels: [{ name: 'shipper:groomed' }, { name: 'shipper:blocked' }],
      },
    ];
    mockGh.mockResolvedValue({ stdout: JSON.stringify(issues), stderr: '' });

    const result = await selectBlockedIssues(repo);
    expect(result).toEqual([
      { number: 20, title: 'Groomed issue' },
      { number: 10, title: 'No stage label' },
    ]);
  });
});

describe('printUnblockSummary', () => {
  it('prints one final outcome row per issue in final-attempt order while preserving every unblock log file', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const attempts: UnblockAttempt[] = [
      {
        issue: 12,
        title: 'Fix database migration',
        outcome: 'still blocked',
        logFile: '/mock-home/.shipper/logs/unblock-12-20260318T040000.log',
      },
      {
        issue: 15,
        title: 'Add OAuth provider',
        outcome: 'still blocked',
        logFile: '/mock-home/.shipper/logs/unblock-15-20260318T040000.log',
      },
      {
        issue: 12,
        title: 'Fix database migration',
        outcome: 'unblocked',
        logFile: '/mock-home/.shipper/logs/unblock-12-20260318T050000.log',
      },
    ];

    printUnblockSummary(attempts, '/mock-home');

    const entries = getConsoleEntries(logSpy);
    const output = getConsoleOutput(logSpy);
    const outcomeRows = entries.filter((entry) => entry.includes('unblock #'));
    const retriedIssueRows = entries.filter((entry) => entry.includes('Fix database migration'));
    const singleAttemptIssueRows = entries.filter((entry) => entry.includes('Add OAuth provider'));

    expect(output).toContain('Unblock attempts:');
    expect(outcomeRows[0]).toContain('Add OAuth provider');
    expect(outcomeRows[1]).toContain('Fix database migration');
    expect(retriedIssueRows).toHaveLength(1);
    expect(retriedIssueRows[0]).toContain('unblock #12');
    expect(retriedIssueRows[0]).toContain('✓ unblocked');
    expect(singleAttemptIssueRows).toHaveLength(1);
    expect(singleAttemptIssueRows[0]).toContain('unblock #15');
    expect(singleAttemptIssueRows[0]).toContain('— still blocked');
    expect(output).toContain('Unblock log files:');
    expect(output).toContain('~/.shipper/logs/unblock-12-20260318T040000.log');
    expect(output).toContain('~/.shipper/logs/unblock-12-20260318T050000.log');
    expect(output).toContain('~/.shipper/logs/unblock-15-20260318T040000.log');

    logSpy.mockRestore();
  });

  it('prints one still-blocked outcome row when the same issue remains blocked across attempts', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const attempts: UnblockAttempt[] = [
      {
        issue: 21,
        title: 'Stabilize flaky deployment',
        outcome: 'still blocked',
      },
      {
        issue: 21,
        title: 'Stabilize flaky deployment',
        outcome: 'still blocked',
      },
    ];

    printUnblockSummary(attempts);

    const entries = getConsoleEntries(logSpy);
    const blockedRows = entries.filter((entry) => entry.includes('Stabilize flaky deployment'));

    expect(blockedRows).toHaveLength(1);
    expect(blockedRows[0]).toContain('— still blocked');

    logSpy.mockRestore();
  });

  it('truncates long titles to 42 chars + ellipsis', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const attempts: UnblockAttempt[] = [
      {
        issue: 99,
        title: 'This is a very long title that exceeds the forty-five character limit',
        outcome: 'unblocked',
      },
    ];

    printUnblockSummary(attempts);

    const output = getConsoleOutput(logSpy);
    expect(output).toContain('This is a very long title that exceeds the...');
    expect(output).not.toContain('forty-five character limit');

    logSpy.mockRestore();
  });

  it('does not print unblock log files section when no attempts have log files', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const attempts: UnblockAttempt[] = [
      { issue: 5, title: 'Legacy attempt', outcome: 'unblocked' },
    ];

    printUnblockSummary(attempts);

    const output = getConsoleOutput(logSpy);
    expect(output).not.toContain('Unblock log files:');

    logSpy.mockRestore();
  });
});

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
    expect(exitSpy).toHaveBeenCalledWith(1);

    const capMessage = getConsoleEntries(errorSpy).find((message) =>
      message.includes('hit transition cap')
    );
    expect(capMessage).toBe(`Issue #42 hit transition cap (15): ${labels.join(' → ')}`);

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

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      'Warning: Failed to update labels on issue #42: gh edit failed'
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
    expect(exitSpy).toHaveBeenCalledWith(0);
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
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('was reset to shipper:new'));

    logSpy.mockRestore();
    errorSpy.mockRestore();
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
    expect(exitSpy).toHaveBeenCalledWith(0);
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
        child.stdout.write('agent output\n');
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
    expect(fsMockState.capturedLogs.get(logFile)).toContain('Running stage: implement');
    expect(fsMockState.capturedLogs.get(logFile)).toContain('agent output');
    expect(fsMockState.capturedLogs.get(logFile)).toContain('agent error');

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
    expect(exitSpy).toHaveBeenCalledWith(1);

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

    expect(exitSpy).toHaveBeenCalledWith(0);
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
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('keeps the same-label safeguard when grooming stays on shipper:new', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockIssueViewSequence(['shipper:new', 'shipper:new']);

    await shipCommand(repo, '42', { auto: false, merge: false });

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      'Label did not advance after stage "groom" (still "shipper:new"). Aborting to avoid infinite loop.'
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
    expect(exitSpy).toHaveBeenCalledWith(0);
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
    expect(exitSpy).toHaveBeenCalledWith(0);
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
    expect(exitSpy).toHaveBeenCalledWith(0);
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
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(
        'Issue #42 was reset to shipper:new by stage "implement" - stopping to avoid interactive groom stage.'
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
      expect(exitSpy).toHaveBeenCalledWith(0);
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
      expect(getConsoleOutput(logSpy)).toContain(
        'Skipping issue #42: stage "groom" requires interactive mode.'
      );
      expect(exitSpy).toHaveBeenCalledWith(0);
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
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('was reset to shipper:new'));

    errorSpy.mockRestore();
  });

  it('fails fast with a terminal-state message for shipper:failed issues', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockIssueViewSequence(['shipper:failed']);

    await shipCommand(repo, '42', { auto: false, merge: false });

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      'Issue #42 is marked shipper:failed and requires manual intervention before it can re-enter the pipeline.'
    );

    errorSpy.mockRestore();
  });
});

describe('shipCommand merge path', () => {
  beforeEach(() => {
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
    isPrMergedMock.mockReset();
    isPrMergedMock.mockResolvedValue(false);
    exitSpy.mockClear();
  });

  it('rebases a behind PR and merges it in the same invocation', async () => {
    setupReadyMergeFlow({
      mergeStates: ['BEHIND', 'CLEAN'],
      updateBranchStdout: 'rebased\n',
      mergeStdout: 'merged\n',
    });

    await shipCommand(repo, '123', { merge: true, auto: false });

    expect(findGhCalls('pr', 'view')).toHaveLength(2);
    expect(findGhCalls('pr', 'update-branch')).toHaveLength(1);
    expect(findGhCalls('pr', 'merge')).toHaveLength(1);
    expect(postMergeMock).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('treats a failed behind-state rebase as a remediable merge failure', async () => {
    setupReadyMergeFlow({
      mergeStates: ['BEHIND'],
      updateBranchError: new Error('rebase conflict'),
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await shipCommand(repo, '123', { merge: true, auto: false });

    const stderrOutput = getConsoleOutput(errorSpy);
    expect(stderrOutput).toContain(
      'Merge failed for PR #456: Failed to rebase PR #456 onto its base branch: rebase conflict'
    );
    expect(isPrMergedMock).not.toHaveBeenCalled();
    expect(findGhCalls('pr', 'merge')).toHaveLength(0);
    expect(findGhCalls('pr', 'edit')).toHaveLength(1);
    expect(findGhCalls('issue', 'edit')).toHaveLength(1);
    expect(findGhCalls('pr', 'comment')).toHaveLength(1);
    expect(exitSpy).toHaveBeenCalledWith(1);

    errorSpy.mockRestore();
  });

  it('fails early for DIRTY merge state without attempting gh pr merge', async () => {
    setupReadyMergeFlow({ mergeStates: ['DIRTY'] });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await shipCommand(repo, '123', { merge: true, auto: false });

    const stderrOutput = getConsoleOutput(errorSpy);
    expect(stderrOutput).toContain(
      'Merge failed for PR #456: PR #456 has merge conflicts that must be resolved.'
    );
    expect(findGhCalls('pr', 'merge')).toHaveLength(0);
    expect(exitSpy).toHaveBeenCalledWith(1);

    errorSpy.mockRestore();
  });

  it.each([
    {
      name: 'failed checks',
      classification: {
        pending: [],
        failed: [{ name: 'test' }],
        passed: [],
        total: 1,
      },
      expected: 'Merge failed for PR #456: PR #456 is blocked by failed CI checks: test.',
    },
    {
      name: 'pending checks',
      classification: {
        pending: [{ name: 'lint' }],
        failed: [],
        passed: [],
        total: 1,
      },
      expected:
        'Merge failed for PR #456: PR #456 is blocked by pending CI checks: lint. Retry when they complete.',
    },
    {
      name: 'review requirements',
      classification: {
        pending: [],
        failed: [],
        passed: [],
        total: 0,
      },
      expected:
        'Merge failed for PR #456: PR #456 is blocked, likely due to required reviews or branch protection requirements.',
    },
  ])('reports actionable BLOCKED reasons for $name', async ({ classification, expected }) => {
    setupReadyMergeFlow({ mergeStates: ['BLOCKED'] });
    mockFetchChecks.mockResolvedValue([
      { name: 'test', state: 'FAILURE', bucket: 'fail' },
      { name: 'lint', state: 'PENDING', bucket: 'pending' },
    ]);
    mockClassifyChecks.mockReturnValue(classification);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await shipCommand(repo, '123', { merge: true, auto: false });

    const stderrOutput = getConsoleOutput(errorSpy);
    expect(stderrOutput).toContain(expected);
    expect(mockFetchChecks).toHaveBeenCalledWith(repo, '456');
    expect(findGhCalls('pr', 'merge')).toHaveLength(0);
    expect(exitSpy).toHaveBeenCalledWith(1);

    errorSpy.mockRestore();
  });

  it('fails early when GitHub reports UNKNOWN merge state and PR is not mergeable', async () => {
    setupReadyMergeFlow({ mergeStates: ['UNKNOWN'], mergeable: 'UNKNOWN' });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await shipCommand(repo, '123', { merge: true, auto: false });

    const stderrOutput = getConsoleOutput(errorSpy);
    expect(stderrOutput).toContain(
      'Merge failed for PR #456: GitHub has not computed merge state for PR #456 yet. Retry shortly.'
    );
    expect(findGhCalls('pr', 'merge')).toHaveLength(0);
    expect(exitSpy).toHaveBeenCalledWith(1);

    errorSpy.mockRestore();
  });

  it('merges when mergeStateStatus is UNKNOWN but mergeable is MERGEABLE', async () => {
    setupReadyMergeFlow({
      mergeStates: ['UNKNOWN'],
      mergeable: 'MERGEABLE',
      mergeStdout: 'merged\n',
    });

    await shipCommand(repo, '123', { merge: true, auto: false });

    expect(findGhCalls('pr', 'merge')).toHaveLength(1);
    expect(postMergeMock).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('fails clearly on an unrecognized merge state instead of merging blindly', async () => {
    setupReadyMergeFlow({ mergeStates: ['MERGEABLE_LATER'] });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await shipCommand(repo, '123', { merge: true, auto: false });

    const stderrOutput = getConsoleOutput(errorSpy);
    expect(stderrOutput).toContain(
      "Merge failed for PR #456: Unrecognized merge state 'MERGEABLE_LATER' for PR #456."
    );
    expect(findGhCalls('pr', 'merge')).toHaveLength(0);
    expect(exitSpy).toHaveBeenCalledWith(1);

    errorSpy.mockRestore();
  });

  it('runs the merge post hook only on success', async () => {
    const hookSteps: string[] = [];
    mockWithStageHooks.mockImplementation((_stage: string, _env: unknown, fn) => {
      hookSteps.push('pre');
      return fn().then((result) => {
        hookSteps.push('post');
        return result;
      });
    });

    setupReadyMergeFlow({ mergeStates: ['DIRTY'] });
    await shipCommand(repo, '123', { merge: true, auto: false });
    expect(hookSteps).toEqual(['pre']);
    expect(exitSpy).toHaveBeenLastCalledWith(1);

    hookSteps.length = 0;
    exitSpy.mockClear();
    setupReadyMergeFlow({ mergeStates: ['CLEAN'], mergeStdout: 'merged\n' });
    await shipCommand(repo, '123', { merge: true, auto: false });
    expect(hookSteps).toEqual(['pre', 'post']);
    expect(exitSpy).toHaveBeenLastCalledWith(0);
  });

  it('uses post-merge cleanup when gh pr merge errors but verification confirms the merge succeeded', async () => {
    setupReadyMergeFlow({
      mergeStates: ['CLEAN'],
      mergeError: new Error('merge timed out'),
    });
    isPrMergedMock.mockResolvedValue(true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await shipCommand(repo, '123', { merge: true, auto: false });

    expect(isPrMergedMock).toHaveBeenCalledWith(456, repo);
    expect(postMergeMock).toHaveBeenCalledTimes(1);
    expect(findGhCalls('pr', 'edit')).toHaveLength(0);
    expect(findGhCalls('issue', 'edit')).toHaveLength(0);
    expect(findGhCalls('pr', 'comment')).toHaveLength(0);
    expect(getConsoleOutput(logSpy)).toContain(
      'PR #456 merge succeeded despite reported error. Proceeding with post-merge cleanup.'
    );
    expect(exitSpy).toHaveBeenCalledWith(0);

    logSpy.mockRestore();
  });

  it('remediates when gh pr merge errors and verification confirms the merge did not succeed', async () => {
    setupReadyMergeFlow({
      mergeStates: ['CLEAN'],
      mergeError: new Error('merge failed'),
    });
    isPrMergedMock.mockResolvedValue(false);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await shipCommand(repo, '123', { merge: true, auto: false });

    expect(isPrMergedMock).toHaveBeenCalledWith(456, repo);
    expect(postMergeMock).not.toHaveBeenCalled();
    expect(findGhCalls('pr', 'edit')).toHaveLength(1);
    expect(findGhCalls('issue', 'edit')).toHaveLength(1);
    expect(findGhCalls('pr', 'comment')).toHaveLength(1);
    expect(getConsoleOutput(errorSpy)).toContain('Merge failed for PR #456: merge failed');
    expect(exitSpy).toHaveBeenCalledWith(1);

    errorSpy.mockRestore();
  });

  it('remediates when merge verification is inconclusive after a reported merge error', async () => {
    setupReadyMergeFlow({
      mergeStates: ['CLEAN'],
      mergeError: new Error('merge failed'),
    });
    isPrMergedMock.mockResolvedValue(null);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await shipCommand(repo, '123', { merge: true, auto: false });

    expect(isPrMergedMock).toHaveBeenCalledWith(456, repo);
    expect(postMergeMock).not.toHaveBeenCalled();
    expect(findGhCalls('pr', 'edit')).toHaveLength(1);
    expect(findGhCalls('issue', 'edit')).toHaveLength(1);
    expect(findGhCalls('pr', 'comment')).toHaveLength(1);
    expect(getConsoleOutput(errorSpy)).toContain('Merge failed for PR #456: merge failed');
    expect(exitSpy).toHaveBeenCalledWith(1);

    errorSpy.mockRestore();
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
    postMergeMock.mockClear();
    postMergeMock.mockImplementation((_pr: unknown, issueNumber: number | string) => {
      mockIssues.delete(Number(issueNumber));
      return Promise.resolve();
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
    expect(exitSpy).toHaveBeenCalledWith(0);

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
    expect(exitSpy).toHaveBeenCalledWith(0);
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
    expect(exitSpy).toHaveBeenCalledWith(0);
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
    expect(exitSpy).toHaveBeenCalledWith(0);
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
    expect(exitSpy).toHaveBeenCalledWith(0);

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
          ? { stdout: 'first stdout\n', stderr: 'first stderr\n' }
          : { stdout: 'second stdout\n' },
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
    expect(fsMockState.capturedLogs.get(logFile1)).toContain('Running stage: implement');
    expect(fsMockState.capturedLogs.get(logFile1)).toContain('first stdout');
    expect(fsMockState.capturedLogs.get(logFile1)).toContain('first stderr');
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

  it('gives sequential auto groom runs inherited stdio when resolveMode returns interactive', async () => {
    setMockIssues([
      {
        number: 1,
        title: 'Needs grooming',
        labels: ['shipper:new'],
        nextLabels: ['shipper:groomed', 'shipper:ready'],
      },
    ]);
    mockResolveMode.mockImplementation((step, override) =>
      step === 'groom' ? 'interactive' : (override ?? 'default')
    );

    await shipCommand(repo, undefined, { auto: true, merge: false, parallel: 1 });

    const cliEntrypoint = process.argv[1];
    expect(cliEntrypoint).toBeDefined();
    expect(mockSpawn.mock.calls[0]?.[1]).toEqual([
      cliEntrypoint,
      'next',
      '1',
      '--mode',
      'interactive',
    ]);
    expect(mockSpawn.mock.calls[0]?.[2]).toMatchObject({ stdio: 'inherit' });
    expect(exitSpy).toHaveBeenCalledWith(0);
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
    expect(exitSpy).toHaveBeenCalledWith(0);

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

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
    expect(exitSpy).toHaveBeenCalledWith(0);
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
    expect(exitSpy).toHaveBeenCalledWith(0);
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
    expect(exitSpy).toHaveBeenCalledWith(0);
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

    expect(exitSpy).toHaveBeenCalledWith(0);
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

    expect(exitSpy).toHaveBeenCalledWith(0);
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
    expect(exitSpy).toHaveBeenCalledWith(0);
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
    child1.stdout.write('Running stage: implement\n');
    child1.stderr.write('lock acquired\n');
    child1.finish(0);
    await flushMicrotasks();

    plannedIssues = plannedIssues.filter((issue) => issue.number !== 2);
    child2.stdout.write('Running stage: merge\n');
    child2.stderr.write('boom\n');
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

    expect(fsMockState.capturedLogs.get(logFile1)).toContain('Running stage: implement');
    expect(fsMockState.capturedLogs.get(logFile1)).toContain('lock acquired');
    expect(fsMockState.capturedLogs.get(logFile2)).toContain('Running stage: merge');
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
    expect(errorSpy).toHaveBeenCalledWith('Missing result.json');
    expect(mockHandleAgentCrash).toHaveBeenCalledWith(repo, '7', 'unblock', 'Missing result.json');

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
    expect(exitSpy).toHaveBeenCalledWith(0);
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
    expect(exitSpy).toHaveBeenCalledWith(0);

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
    expect(exitSpy).toHaveBeenCalledWith(0);

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
    expect(exitSpy).toHaveBeenCalledWith(0);

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
