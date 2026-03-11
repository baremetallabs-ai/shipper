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
import {
  STAGE_NAME,
  AUTO_PRIORITY_LABELS,
  selectNextCandidate,
  selectBlockedIssues,
  printUnblockSummary,
  shipCommand,
} from '../../src/commands/ship.js';
import type { UnblockAttempt } from '../../src/commands/ship.js';

vi.mock('@dnsquared/shipper-core', () => ({
  selectIssuesForStage: vi.fn(async () => []),
  clearStaleLockIfNeeded: vi.fn(async () => {}),
  gh: vi.fn(),
  fetchChecks: vi.fn(async () => []),
  classifyChecks: vi.fn(() => ({ pending: [], failed: [], passed: [], total: 0 })),
  STAGE_NAME_MAP: labelFixtures.stageNameMap,
  STAGE_LABEL_NAMES: labelFixtures.stageLabelNames,
  NEW_LABEL: 'shipper:new',
  PR_REVIEWED_LABEL: 'shipper:pr-reviewed',
  READY_LABEL: 'shipper:ready',
  BLOCKED_LABEL: 'shipper:blocked',
  LOCKED_LABEL: 'shipper:locked',
  withStageHooks: vi.fn(
    async (_stage: string, _env: unknown, fn: () => Promise<unknown>) => await fn()
  ),
  withIssueLock: vi.fn(
    async (_repo: string, _issue: string, fn: () => Promise<unknown>) => await fn()
  ),
  releaseIssueLock: vi.fn(async () => {}),
  runPrompt: vi.fn(async () => 0),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
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

vi.mock('node:os', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    homedir: osMockState.mockHomedir,
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    spawn: vi.fn(),
    spawnSync: vi.fn(),
  };
});

import {
  selectIssuesForStage,
  clearStaleLockIfNeeded,
  gh,
  fetchChecks,
  classifyChecks,
  withStageHooks,
  withIssueLock,
  releaseIssueLock,
} from '@dnsquared/shipper-core';
import { spawn, spawnSync } from 'node:child_process';

const mockSelectIssuesForStage = vi.mocked(selectIssuesForStage);
const mockClearStaleLockIfNeeded = vi.mocked(clearStaleLockIfNeeded);
const mockGh = vi.mocked(gh);
const mockFetchChecks = vi.mocked(fetchChecks);
const mockClassifyChecks = vi.mocked(classifyChecks);
const mockWithStageHooks = vi.mocked(withStageHooks);
const mockWithIssueLock = vi.mocked(withIssueLock);
const mockReleaseIssueLock = vi.mocked(releaseIssueLock);
const mockSpawn = vi.mocked(spawn);
const mockSpawnSync = vi.mocked(spawnSync);
const mockCreateWriteStream = fsMockState.mockCreateWriteStream;
const mockMkdirSync = fsMockState.mockMkdirSync;
const mockHomedir = osMockState.mockHomedir;
const repo = 'owner/repo';

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
  prNumber?: number;
  issueNumber?: string;
  updateBranchStdout?: string;
  updateBranchError?: Error;
  mergeStdout?: string;
  mergeError?: Error;
}): void {
  const {
    mergeStates = ['CLEAN'],
    prNumber = 456,
    issueNumber = '123',
    updateBranchStdout = '',
    updateBranchError,
    mergeStdout = '',
    mergeError,
  } = options ?? {};

  let mergeStateCall = 0;

  mockGh.mockImplementation(async (args: string[]) => {
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
        stdout: JSON.stringify({ mergeStateStatus }),
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
    .map(([args]) => args as string[])
    .filter((args) => args[0] === command && args[1] === subcommand);
}

const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
  return undefined as never;
}) as typeof process.exit);

afterAll(() => {
  exitSpy.mockRestore();
});

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
  it('contains all 7 expected labels in priority order', () => {
    expect(AUTO_PRIORITY_LABELS).toEqual([
      'shipper:ready',
      'shipper:pr-reviewed',
      'shipper:pr-open',
      'shipper:implemented',
      'shipper:planned',
      'shipper:designed',
      'shipper:groomed',
    ]);
  });

  it('has shipper:ready as the highest priority', () => {
    expect(AUTO_PRIORITY_LABELS[0]).toBe('shipper:ready');
  });

  it('has shipper:groomed as the lowest priority', () => {
    expect(AUTO_PRIORITY_LABELS[AUTO_PRIORITY_LABELS.length - 1]).toBe('shipper:groomed');
  });
});

describe('selectNextCandidate', () => {
  beforeEach(() => {
    mockSelectIssuesForStage.mockReset();
    mockSelectIssuesForStage.mockResolvedValue([]);
    mockClearStaleLockIfNeeded.mockReset();
  });

  it('returns the issue from the highest-priority label', async () => {
    mockSelectIssuesForStage.mockImplementation(async (_repo: string, label: string) => {
      if (label === 'shipper:ready') return [];
      if (label === 'shipper:pr-reviewed') return [];
      if (label === 'shipper:pr-open') return [{ number: 10, title: 'PR open issue' }];
      if (label === 'shipper:groomed') return [{ number: 20, title: 'Groomed issue' }];
      return [];
    });

    const result = await selectNextCandidate(repo, new Set());
    expect(result).toEqual({ number: 10, title: 'PR open issue' });
  });

  it('skips issues in the skippedIssues set', async () => {
    mockSelectIssuesForStage.mockImplementation(async (_repo: string, label: string) => {
      if (label === 'shipper:pr-open')
        return [
          { number: 10, title: 'Skipped issue' },
          { number: 11, title: 'Next issue' },
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
    mockSelectIssuesForStage.mockImplementation(async (_repo: string, label: string) => {
      if (label === 'shipper:planned') return [{ number: 5, title: 'Only issue' }];
      return [];
    });

    const result = await selectNextCandidate(repo, new Set([5]));
    expect(result).toBeNull();
  });

  it('returns the first issue within a label (already sorted by time-in-state)', async () => {
    mockSelectIssuesForStage.mockImplementation(async (_repo: string, label: string) => {
      if (label === 'shipper:groomed')
        return [
          { number: 1, title: 'Oldest' },
          { number: 2, title: 'Newer' },
        ];
      return [];
    });

    const result = await selectNextCandidate(repo, new Set());
    expect(result).toEqual({ number: 1, title: 'Oldest' });
  });

  it('clears stale lock on selected candidate', async () => {
    mockSelectIssuesForStage.mockImplementation(
      async (_repo: string, label: string, staleLocked?: Set<number>) => {
        if (label === 'shipper:planned') {
          const issues = [{ number: 7, title: 'Stale locked issue' }];
          staleLocked?.add(7);
          return issues;
        }
        return [];
      }
    );

    const result = await selectNextCandidate(repo, new Set());
    expect(result).toEqual({ number: 7, title: 'Stale locked issue' });
    expect(mockClearStaleLockIfNeeded).toHaveBeenCalledWith(repo, 7, expect.any(Set));
  });

  it('calls clearStaleLockIfNeeded with empty staleLocked set for non-stale candidate', async () => {
    mockSelectIssuesForStage.mockImplementation(async (_repo: string, label: string) => {
      if (label === 'shipper:planned') return [{ number: 7, title: 'Normal issue' }];
      return [];
    });

    const result = await selectNextCandidate(repo, new Set());
    expect(result).toEqual({ number: 7, title: 'Normal issue' });
    expect(mockClearStaleLockIfNeeded).toHaveBeenCalledWith(repo, 7, new Set());
  });

  it('skips issues already active in parallel slots', async () => {
    mockSelectIssuesForStage.mockImplementation(async (_repo: string, label: string) => {
      if (label === 'shipper:planned')
        return [
          { number: 7, title: 'Active issue' },
          { number: 8, title: 'Available issue' },
        ];
      return [];
    });

    const result = await selectNextCandidate(repo, new Set(), new Set([7]));
    expect(result).toEqual({ number: 8, title: 'Available issue' });
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
  it('prints each attempt with correct outcome markers', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const attempts: UnblockAttempt[] = [
      { issue: 12, title: 'Fix database migration', outcome: 'unblocked' },
      { issue: 15, title: 'Add OAuth provider', outcome: 'still blocked' },
    ];

    printUnblockSummary(attempts);

    const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('Unblock attempts:');
    expect(output).toContain('12');
    expect(output).toContain('Fix database migration');
    expect(output).toContain('✓ unblocked');
    expect(output).toContain('15');
    expect(output).toContain('Add OAuth provider');
    expect(output).toContain('— still blocked');

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

    const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('This is a very long title that exceeds the...');
    expect(output).not.toContain('forty-five character limit');

    logSpy.mockRestore();
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
    mockSpawnSync.mockReset();
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
    expect(findGhCalls('issue', 'close')).toHaveLength(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('treats a failed behind-state rebase as a remediable merge failure', async () => {
    setupReadyMergeFlow({
      mergeStates: ['BEHIND'],
      updateBranchError: new Error('rebase conflict'),
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await shipCommand(repo, '123', { merge: true, auto: false });

    const stderrOutput = errorSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(stderrOutput).toContain(
      'Merge failed for PR #456: Failed to rebase PR #456 onto its base branch: rebase conflict'
    );
    expect(findGhCalls('pr', 'merge')).toHaveLength(0);
    expect(findGhCalls('pr', 'edit')).toHaveLength(2);
    expect(findGhCalls('issue', 'edit')).toHaveLength(2);
    expect(findGhCalls('pr', 'comment')).toHaveLength(1);
    expect(exitSpy).toHaveBeenCalledWith(1);

    errorSpy.mockRestore();
  });

  it('fails early for DIRTY merge state without attempting gh pr merge', async () => {
    setupReadyMergeFlow({ mergeStates: ['DIRTY'] });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await shipCommand(repo, '123', { merge: true, auto: false });

    const stderrOutput = errorSpy.mock.calls.map((call) => call[0]).join('\n');
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

    const stderrOutput = errorSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(stderrOutput).toContain(expected);
    expect(mockFetchChecks).toHaveBeenCalledWith(repo, '456');
    expect(findGhCalls('pr', 'merge')).toHaveLength(0);
    expect(exitSpy).toHaveBeenCalledWith(1);

    errorSpy.mockRestore();
  });

  it('fails early when GitHub reports UNKNOWN merge state', async () => {
    setupReadyMergeFlow({ mergeStates: ['UNKNOWN'] });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await shipCommand(repo, '123', { merge: true, auto: false });

    const stderrOutput = errorSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(stderrOutput).toContain(
      'Merge failed for PR #456: GitHub has not computed merge state for PR #456 yet. Retry shortly.'
    );
    expect(findGhCalls('pr', 'merge')).toHaveLength(0);
    expect(exitSpy).toHaveBeenCalledWith(1);

    errorSpy.mockRestore();
  });

  it('fails clearly on an unrecognized merge state instead of merging blindly', async () => {
    setupReadyMergeFlow({ mergeStates: ['MERGEABLE_LATER'] });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await shipCommand(repo, '123', { merge: true, auto: false });

    const stderrOutput = errorSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(stderrOutput).toContain(
      "Merge failed for PR #456: Unrecognized merge state 'MERGEABLE_LATER' for PR #456."
    );
    expect(findGhCalls('pr', 'merge')).toHaveLength(0);
    expect(exitSpy).toHaveBeenCalledWith(1);

    errorSpy.mockRestore();
  });

  it('runs the merge post hook only on success', async () => {
    const hookSteps: string[] = [];
    mockWithStageHooks.mockImplementation(async (_stage: string, _env: unknown, fn) => {
      hookSteps.push('pre');
      const result = await fn();
      hookSteps.push('post');
      return result;
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
    mockSpawnSync.mockReset();
    exitSpy.mockClear();
  });

  it('does not blacklist a retriable merge failure in sequential auto mode', async () => {
    let readySelections = 0;
    mockSelectIssuesForStage.mockImplementation(async (_repo: string, label: string) => {
      if (label === 'shipper:ready' && readySelections < 2) {
        readySelections++;
        return [{ number: 123, title: 'Retry merge issue' }];
      }
      return [];
    });
    setupReadyMergeFlow({ mergeStates: ['DIRTY'] });

    await shipCommand(repo, undefined, { auto: true, merge: false, parallel: 1 });

    expect(findGhCalls('pr', 'list')).toHaveLength(2);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('does not blacklist a child-process merge failure in parallel auto mode', async () => {
    let candidateAvailable = true;
    mockSelectIssuesForStage.mockImplementation((_repo: string, label: string) => {
      if (label === 'shipper:ready' && candidateAvailable) {
        return [{ number: 1, title: 'Retry merge issue' }];
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

    expect(mockSpawn.mock.calls.map(([, args]) => (args as string[])[2])).toEqual(['1', '1']);
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
      if (label === 'shipper:planned') return plannedIssues;
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

  it('captures combined child output in per-issue log files and prints prefixed parallel status lines', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-06T02:30:00'));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    let plannedIssues = [
      { number: 1, title: 'Issue one' },
      { number: 2, title: 'Issue two' },
    ];
    mockSelectIssuesForStage.mockImplementation((_repo: string, label: string) => {
      if (label === 'shipper:planned') return plannedIssues;
      return [];
    });
    mockGh.mockImplementation(async (args: string[]) => {
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

    const output = logSpy.mock.calls.map((call) => call[0]).join('\n');

    expect(output).toContain('[#1] Auto: advancing issue #1 — Issue one');
    expect(output).toContain('[#2] Auto: advancing issue #2 — Issue two');
    expect(output).toContain('[#1] ✓ pass');
    expect(output).toContain('[#2] ✗ fail');
    expect(output).toContain('[#7] Auto: attempting unblock of #7 — Blocked issue');
    expect(output).toContain('Auto run complete.');
    expect(output).toContain('  #    Issue                                          Outcome');
    expect(output).toContain('✗ fail — boom');
    expect(output).toContain('  Unblock attempts:');
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

  it('reuses a failed slot for the next candidate and skips the failed issue afterwards', async () => {
    let plannedIssues = [
      { number: 1, title: 'Issue one' },
      { number: 2, title: 'Issue two' },
      { number: 3, title: 'Issue three' },
    ];
    mockSelectIssuesForStage.mockImplementation((_repo: string, label: string) => {
      if (label === 'shipper:planned') return plannedIssues;
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
    expect(mockSpawn.mock.calls.map(([, args]) => (args as string[])[2])).toEqual(['1', '2', '3']);

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
        return plannedIssues;
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
    expect(mockMkdirSync).not.toHaveBeenCalled();
    expect(mockSelectIssuesForStage).toHaveBeenCalled();
    expect(logSpy.mock.calls.map((call) => call[0]).join('\n')).not.toContain('[#');
    expect(exitSpy).toHaveBeenCalledWith(0);

    logSpy.mockRestore();
  });

  it('uses the sequential helper when parallel is 1', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    mockSelectIssuesForStage.mockReturnValue([]);

    await shipCommand(repo, undefined, { auto: true, merge: false, parallel: 1 });

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockCreateWriteStream).not.toHaveBeenCalled();
    expect(mockMkdirSync).not.toHaveBeenCalled();
    expect(mockSelectIssuesForStage).toHaveBeenCalled();
    expect(logSpy.mock.calls.map((call) => call[0]).join('\n')).not.toContain('[#');
    expect(exitSpy).toHaveBeenCalledWith(0);

    logSpy.mockRestore();
  });

  it('fails the issue instead of crashing when the log stream errors before child exit', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockSelectIssuesForStage.mockImplementation((_repo: string, label: string) => {
      if (label === 'shipper:planned') {
        return [{ number: 1, title: 'Issue one' }];
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

    const output = logSpy.mock.calls.map((call) => call[0]).join('\n');
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
          return plannedIssues;
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
