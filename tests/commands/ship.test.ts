import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterAll, describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  STAGE_NAME,
  AUTO_PRIORITY_LABELS,
  selectNextCandidate,
  selectBlockedIssues,
  printUnblockSummary,
  shipCommand,
} from '../../src/commands/ship.js';
import type { UnblockAttempt } from '../../src/commands/ship.js';

vi.mock('../../src/lib/github.js', () => ({
  selectIssuesForStage: vi.fn(() => []),
  clearStaleLockIfNeeded: vi.fn(),
}));

vi.mock('../../src/lib/repo.js', () => ({
  getRepoNwo: vi.fn(() => 'owner/repo'),
}));

vi.mock('../../src/lib/lock.js', () => ({
  withIssueLock: vi.fn((_issue: string, fn: () => unknown) => fn()),
  releaseIssueLock: vi.fn(),
}));

vi.mock('../../src/lib/prompt-runner.js', () => ({
  runPrompt: vi.fn(() => 0),
}));

vi.mock('../../src/lib/prompts.js', () => ({
  agentPrompts: { claude: {} },
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    execFileSync: vi.fn(),
    spawn: vi.fn(),
    spawnSync: vi.fn(),
  };
});

import { selectIssuesForStage, clearStaleLockIfNeeded } from '../../src/lib/github.js';
import { releaseIssueLock } from '../../src/lib/lock.js';
import { execFileSync, spawn } from 'node:child_process';

const mockSelectIssuesForStage = vi.mocked(selectIssuesForStage);
const mockClearStaleLockIfNeeded = vi.mocked(clearStaleLockIfNeeded);
const mockReleaseIssueLock = vi.mocked(releaseIssueLock);
const mockExecFileSync = vi.mocked(execFileSync);
const mockSpawn = vi.mocked(spawn);

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
  await Promise.resolve();
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
    ];

    expect(Object.keys(STAGE_NAME).sort()).toEqual(expectedLabels.sort());
  });

  it('does not include shipper:ready (terminal state)', () => {
    expect(STAGE_NAME).not.toHaveProperty('shipper:ready');
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
    mockSelectIssuesForStage.mockReturnValue([]);
    mockClearStaleLockIfNeeded.mockReset();
  });

  it('returns the issue from the highest-priority label', () => {
    mockSelectIssuesForStage.mockImplementation((label: string) => {
      if (label === 'shipper:ready') return [];
      if (label === 'shipper:pr-reviewed') return [];
      if (label === 'shipper:pr-open') return [{ number: 10, title: 'PR open issue' }];
      if (label === 'shipper:groomed') return [{ number: 20, title: 'Groomed issue' }];
      return [];
    });

    const result = selectNextCandidate(new Set());
    expect(result).toEqual({ number: 10, title: 'PR open issue' });
  });

  it('skips issues in the skippedIssues set', () => {
    mockSelectIssuesForStage.mockImplementation((label: string) => {
      if (label === 'shipper:pr-open')
        return [
          { number: 10, title: 'Skipped issue' },
          { number: 11, title: 'Next issue' },
        ];
      return [];
    });

    const result = selectNextCandidate(new Set([10]));
    expect(result).toEqual({ number: 11, title: 'Next issue' });
  });

  it('returns null when no candidates remain', () => {
    mockSelectIssuesForStage.mockReturnValue([]);

    const result = selectNextCandidate(new Set());
    expect(result).toBeNull();
  });

  it('returns null when all candidates are skipped', () => {
    mockSelectIssuesForStage.mockImplementation((label: string) => {
      if (label === 'shipper:planned') return [{ number: 5, title: 'Only issue' }];
      return [];
    });

    const result = selectNextCandidate(new Set([5]));
    expect(result).toBeNull();
  });

  it('returns the first issue within a label (already sorted by time-in-state)', () => {
    mockSelectIssuesForStage.mockImplementation((label: string) => {
      if (label === 'shipper:groomed')
        return [
          { number: 1, title: 'Oldest' },
          { number: 2, title: 'Newer' },
        ];
      return [];
    });

    const result = selectNextCandidate(new Set());
    expect(result).toEqual({ number: 1, title: 'Oldest' });
  });

  it('clears stale lock on selected candidate', () => {
    mockSelectIssuesForStage.mockImplementation((label: string, staleLocked?: Set<number>) => {
      if (label === 'shipper:planned') {
        const issues = [{ number: 7, title: 'Stale locked issue' }];
        staleLocked?.add(7);
        return issues;
      }
      return [];
    });

    const result = selectNextCandidate(new Set());
    expect(result).toEqual({ number: 7, title: 'Stale locked issue' });
    expect(mockClearStaleLockIfNeeded).toHaveBeenCalledWith(7, expect.any(Set));
  });

  it('calls clearStaleLockIfNeeded with empty staleLocked set for non-stale candidate', () => {
    mockSelectIssuesForStage.mockImplementation((label: string) => {
      if (label === 'shipper:planned') return [{ number: 7, title: 'Normal issue' }];
      return [];
    });

    const result = selectNextCandidate(new Set());
    expect(result).toEqual({ number: 7, title: 'Normal issue' });
    expect(mockClearStaleLockIfNeeded).toHaveBeenCalledWith(7, new Set());
  });

  it('skips issues already active in parallel slots', () => {
    mockSelectIssuesForStage.mockImplementation((label: string) => {
      if (label === 'shipper:planned')
        return [
          { number: 7, title: 'Active issue' },
          { number: 8, title: 'Available issue' },
        ];
      return [];
    });

    const result = selectNextCandidate(new Set(), new Set([7]));
    expect(result).toEqual({ number: 8, title: 'Available issue' });
  });
});

describe('selectBlockedIssues', () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
  });

  it('returns empty array when no blocked issues exist', () => {
    mockExecFileSync.mockReturnValue('[]');
    const result = selectBlockedIssues();
    expect(result).toEqual([]);
  });

  it('returns issues sorted by stage priority', () => {
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
    mockExecFileSync.mockReturnValue(JSON.stringify(issues));

    const result = selectBlockedIssues();
    expect(result).toEqual([
      { number: 20, title: 'PR reviewed issue' },
      { number: 30, title: 'Planned issue' },
      { number: 10, title: 'New issue' },
    ]);
  });

  it('returns empty array when execFileSync throws', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('gh CLI error');
    });
    const result = selectBlockedIssues();
    expect(result).toEqual([]);
  });

  it('passes --search flag to exclude shipper:locked issues', () => {
    mockExecFileSync.mockReturnValue('[]');
    selectBlockedIssues();
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['--search', '-label:shipper:locked']),
      expect.any(Object)
    );
  });

  it('sorts issues with no recognized stage label to the end', () => {
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
    mockExecFileSync.mockReturnValue(JSON.stringify(issues));

    const result = selectBlockedIssues();
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

describe('shipCommand parallel auto runner', () => {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
    return undefined as never;
  }) as typeof process.exit);

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(() => {
    exitSpy.mockRestore();
  });

  beforeEach(() => {
    mockSelectIssuesForStage.mockReset();
    mockClearStaleLockIfNeeded.mockReset();
    mockExecFileSync.mockReset();
    mockExecFileSync.mockReturnValue('[]');
    mockSpawn.mockReset();
    mockReleaseIssueLock.mockReset();
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
    mockSelectIssuesForStage.mockImplementation((label: string) => {
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

    const runPromise = shipCommand(undefined, { auto: true, merge: false, parallel: 2 });

    await flushMicrotasks();

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(mockSpawn.mock.calls[0]?.[1]).toEqual([process.argv[1]!, 'ship', '1', '--merge']);
    expect(mockSpawn.mock.calls[1]?.[1]).toEqual([process.argv[1]!, 'ship', '2', '--merge']);

    plannedIssues = plannedIssues.filter((issue) => issue.number !== 1);
    child1.finish(0);
    await flushMicrotasks();

    expect(mockSpawn).toHaveBeenCalledTimes(3);
    expect(mockSpawn.mock.calls[2]?.[1]).toEqual([process.argv[1]!, 'ship', '3', '--merge']);
    expect(
      mockSelectIssuesForStage.mock.calls.filter(([label]) => label === 'shipper:planned').length
    ).toBeGreaterThanOrEqual(3);

    plannedIssues = plannedIssues.filter((issue) => issue.number !== 2);
    child2.finish(0);
    await flushMicrotasks();
    plannedIssues = plannedIssues.filter((issue) => issue.number !== 3);
    child3.finish(0);
    await runPromise;

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('reuses a failed slot for the next candidate and skips the failed issue afterwards', async () => {
    let plannedIssues = [
      { number: 1, title: 'Issue one' },
      { number: 2, title: 'Issue two' },
      { number: 3, title: 'Issue three' },
    ];
    mockSelectIssuesForStage.mockImplementation((label: string) => {
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

    const runPromise = shipCommand(undefined, { auto: true, merge: false, parallel: 2 });

    await flushMicrotasks();
    plannedIssues = plannedIssues.filter((issue) => issue.number !== 1);
    child1.finish(1, null, 'boom');
    await flushMicrotasks();

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
    mockSelectIssuesForStage.mockImplementation((label: string) => {
      if (label === 'shipper:planned') {
        return plannedIssues;
      }
      return [];
    });

    const child1 = new FakeChildProcess();
    const child2 = new FakeChildProcess();
    mockSpawn.mockReturnValueOnce(child1 as never).mockReturnValueOnce(child2 as never);

    const runPromise = shipCommand(undefined, { auto: true, merge: false, parallel: 2 });

    await flushMicrotasks();
    plannedIssues = plannedIssues.filter((issue) => issue.number !== 1);
    child1.finish(0);
    await flushMicrotasks();

    expect(mockExecFileSync).not.toHaveBeenCalled();

    plannedIssues = plannedIssues.filter((issue) => issue.number !== 2);
    child2.finish(0);
    await runPromise;

    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['issue', 'list', '--label', 'shipper:blocked']),
      expect.any(Object)
    );
  });

  it('uses the sequential helper when parallel is not enabled', async () => {
    mockSelectIssuesForStage.mockReturnValue([]);

    await shipCommand(undefined, { auto: true, merge: false, parallel: undefined });

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockSelectIssuesForStage).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
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
      mockSelectIssuesForStage.mockImplementation((label: string) => {
        if (label === 'shipper:planned') {
          return plannedIssues;
        }
        return [];
      });

      const child1 = new FakeChildProcess();
      const child2 = new FakeChildProcess();
      mockSpawn.mockReturnValueOnce(child1 as never).mockReturnValueOnce(child2 as never);

      const runPromise = shipCommand(undefined, { auto: true, merge: false, parallel: 2 });

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
      expect(mockReleaseIssueLock).not.toHaveBeenCalledWith('1');
      expect(mockReleaseIssueLock).toHaveBeenCalledWith('2');
      child2.finish(null, 'SIGKILL');
      await flushMicrotasks();
      await runPromise;
    }
  );
});
