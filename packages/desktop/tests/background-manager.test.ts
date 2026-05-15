import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as childProcess from 'node:child_process';

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFile: execFileMock,
    spawn: vi.fn(),
  };
});

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name !== 'userData') {
        throw new Error(`Unexpected app.getPath(${name}) in test.`);
      }

      return tempDir;
    },
  },
}));

import { BackgroundManager } from '../src/main/background-manager.js';
import {
  LOCKED_LABEL,
  PAUSED_EXIT_CODE,
  RETRIABLE_FAILURE_EXIT_CODE,
} from '@baremetallabs-ai/shipper-core';

class MockStream extends EventEmitter {
  emitData(chunk: string): void {
    this.emit('data', Buffer.from(chunk, 'utf8'));
  }
}

class MockChildProcess extends EventEmitter {
  pid: number;
  stdout = new MockStream();
  stderr = new MockStream();

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  close(exitCode: number | null): void {
    this.emit('close', exitCode);
  }
}

const mockSpawn = vi.mocked(childProcess.spawn);
type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

function getExecFileCallback(
  optionsOrCallback: unknown,
  callback: unknown
): ExecFileCallback | undefined {
  if (typeof optionsOrCallback === 'function') {
    return optionsOrCallback as ExecFileCallback;
  }

  if (typeof callback === 'function') {
    return callback as ExecFileCallback;
  }

  return undefined;
}

function ghCommandCalls(): string[][] {
  return execFileMock.mock.calls
    .filter(([file]) => file === 'gh')
    .map(([, args]) => args as string[]);
}

function expectRemoveLabelCall(issueNumber: string, repo: string): void {
  expect(ghCommandCalls()).toContainEqual([
    'issue',
    'edit',
    issueNumber,
    '-R',
    repo,
    '--remove-label',
    LOCKED_LABEL,
  ]);
}

let pid = 1000;
let children: MockChildProcess[] = [];
let windowSend: ReturnType<typeof vi.fn>;
let tempDir: string;

function createManager(): BackgroundManager {
  const manager = new BackgroundManager();
  windowSend = vi.fn();
  manager.setWindow({
    webContents: {
      send: windowSend,
    },
  } as never);
  return manager;
}

function latestChild(): MockChildProcess {
  const child = children.at(-1);
  if (!child) {
    throw new Error('Expected a spawned child process.');
  }

  return child;
}

function statusEvents(): Array<Record<string, unknown>> {
  return windowSend.mock.calls
    .filter(([channel]) => channel === 'bg-status')
    .map(([, payload]) => payload as Record<string, unknown>);
}

async function flushBackgroundCleanup(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

beforeEach(() => {
  pid = 1000;
  children = [];
  tempDir = mkdtempSync(join(tmpdir(), 'shipper-bg-manager-'));
  mockSpawn.mockReset();
  execFileMock.mockReset();
  execFileMock.mockImplementation((_file, _args, optionsOrCallback, callback) => {
    getExecFileCallback(optionsOrCallback, callback)?.(null, '', '');
    return {} as never;
  });
  mockSpawn.mockImplementation(() => {
    const child = new MockChildProcess((pid += 1));
    children.push(child);
    return child as never;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('BackgroundManager', () => {
  it('queues same-repo ship sessions and promotes the next one after completion', async () => {
    const manager = createManager();

    manager.spawn({
      sessionId: 'ship-1',
      command: 'ship',
      repo: 'owner/repo',
      commandName: 'shipper',
      args: ['ship', '41', '--mode', 'headless'],
      cwd: '/tmp/repo',
      meta: { issueNumber: 41 },
    });
    manager.spawn({
      sessionId: 'ship-2',
      command: 'ship',
      repo: 'owner/repo',
      commandName: 'shipper',
      args: ['ship', '42', '--mode', 'headless'],
      cwd: '/tmp/repo',
      meta: { issueNumber: 42 },
    });

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(
      statusEvents().some(
        (event) =>
          event.sessionId === 'ship-2' &&
          event.status === 'queued' &&
          isRecord(event.meta) &&
          event.meta.issueNumber === 42
      )
    ).toBe(true);

    latestChild().close(0);
    await flushBackgroundCleanup();

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(statusEvents()).toContainEqual(
      expect.objectContaining({
        sessionId: 'ship-2',
        status: 'running',
      })
    );
  });

  it('allows new and init commands to run concurrently', () => {
    const manager = createManager();

    manager.spawn({
      sessionId: 'new-1',
      command: 'new',
      repo: 'owner/repo',
      commandName: 'shipper',
      args: ['new', 'idea', '--mode', 'headless'],
      cwd: '/tmp/repo',
      logFile: '/tmp/new-1.jsonl',
      meta: { request: 'idea', logFile: '/tmp/new-1.jsonl' },
    });
    manager.spawn({
      sessionId: 'init-1',
      command: 'init',
      repo: 'owner/repo',
      commandName: 'shipper',
      args: ['init', '--agent', 'claude'],
      cwd: '/tmp/repo',
    });

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(statusEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: 'new-1', status: 'running' }),
        expect.objectContaining({ sessionId: 'init-1', status: 'running' }),
      ])
    );
  });

  it('starts unblock immediately even when a same-repo ship is already running', () => {
    const manager = createManager();

    manager.spawn({
      sessionId: 'ship-1',
      command: 'ship',
      repo: 'owner/repo',
      commandName: 'shipper',
      args: ['ship', '41', '--mode', 'headless'],
      cwd: '/tmp/repo',
      meta: { issueNumber: 41 },
    });
    manager.spawn({
      sessionId: 'unblock-1',
      command: 'unblock',
      repo: 'owner/repo',
      commandName: 'shipper',
      args: ['unblock', '42', '--mode', 'headless'],
      cwd: '/tmp/repo',
      meta: { issueNumber: 42 },
    });

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(statusEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: 'ship-1', status: 'running' }),
        expect.objectContaining({ sessionId: 'unblock-1', status: 'running' }),
      ])
    );
    expect(
      statusEvents().some((event) => event.sessionId === 'unblock-1' && event.status === 'queued')
    ).toBe(false);
  });

  it('captures buffered output for ship and init sessions', () => {
    const manager = createManager();

    manager.spawn({
      sessionId: 'ship-1',
      command: 'ship',
      repo: 'owner/repo',
      commandName: 'shipper',
      args: ['ship', '41', '--mode', 'headless'],
      cwd: '/tmp/repo',
    });

    const child = latestChild();
    child.stdout.emitData('running stage: design\n');
    child.stderr.emitData('warning text\n');

    expect(manager.getOutput('ship-1')).toBe('running stage: design\nwarning text\n');
    expect(windowSend).toHaveBeenCalledWith('bg-output', {
      sessionId: 'ship-1',
      data: 'running stage: design\n',
    });
    expect(windowSend).toHaveBeenCalledWith('bg-output', {
      sessionId: 'ship-1',
      data: 'warning text\n',
    });
  });

  it('reads new-session output from the known log file path', () => {
    const manager = createManager();
    const logFile = join(tempDir, 'sessions', 'desktop-run.jsonl');
    mkdirSync(join(tempDir, 'sessions'), { recursive: true });

    manager.spawn({
      sessionId: 'new-1',
      command: 'new',
      repo: 'owner/repo',
      commandName: 'shipper',
      args: ['new', 'idea', '--mode', 'headless', '--log-file', logFile],
      cwd: '/tmp/repo',
      logFile,
      meta: { request: 'idea', logFile },
    });

    writeFileSync(logFile, '{"type":"log","message":"hello"}\n', 'utf8');

    expect(manager.getOutput('new-1')).toBe('{"type":"log","message":"hello"}\n');
  });

  it('returns an empty string without warning when the new-session log file is not created yet', () => {
    const manager = createManager();
    const logFile = join(tempDir, 'sessions', 'missing-desktop-run.jsonl');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      manager.spawn({
        sessionId: 'new-1',
        command: 'new',
        repo: 'owner/repo',
        commandName: 'shipper',
        args: ['new', 'idea', '--mode', 'headless', '--log-file', logFile],
        cwd: '/tmp/repo',
        logFile,
        meta: { request: 'idea', logFile },
      });

      expect(manager.getOutput('new-1')).toBe('');
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('warns and returns an empty string when the new-session log file read fails for another reason', () => {
    const manager = createManager();
    const logFile = join(tempDir, 'sessions', 'not-a-file');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mkdirSync(logFile, { recursive: true });

    try {
      manager.spawn({
        sessionId: 'new-1',
        command: 'new',
        repo: 'owner/repo',
        commandName: 'shipper',
        args: ['new', 'idea', '--mode', 'headless', '--log-file', logFile],
        cwd: '/tmp/repo',
        logFile,
        meta: { request: 'idea', logFile },
      });

      expect(manager.getOutput('new-1')).toBe('');
      expect(warnSpy).toHaveBeenCalledWith(`[shipper] Failed to read session log file ${logFile}`);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('kills a running child with SIGTERM and escalates to SIGKILL after the grace period', () => {
    vi.useFakeTimers();
    const manager = createManager();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    manager.spawn({
      sessionId: 'ship-1',
      command: 'ship',
      repo: 'owner/repo',
      commandName: 'shipper',
      args: ['ship', '41', '--mode', 'headless'],
      cwd: '/tmp/repo',
    });

    manager.kill('ship-1');

    expect(killSpy).toHaveBeenCalledWith(latestChild().pid, 'SIGTERM');

    vi.advanceTimersByTime(5_000);

    expect(killSpy).toHaveBeenCalledWith(latestChild().pid, 'SIGKILL');
  });

  it('passes a per-session pause sentinel path into spawned ship environments', () => {
    const manager = createManager();

    manager.spawn({
      sessionId: 'ship-1',
      command: 'ship',
      repo: 'owner/repo',
      commandName: 'shipper',
      args: ['ship', '41', '--mode', 'headless'],
      cwd: '/tmp/repo',
      meta: { issueNumber: 41 },
    });

    const spawnOptions = mockSpawn.mock.calls[0]?.[2];
    if (!spawnOptions || typeof spawnOptions !== 'object' || !('env' in spawnOptions)) {
      throw new Error('Expected spawn options with an env object.');
    }

    expect(spawnOptions.env).toEqual(
      expect.objectContaining({
        SHIPPER_PAUSE_SENTINEL_FILE: join(tempDir, 'pause-sentinels', 'ship-1'),
      })
    );
  });

  it('writes the pause sentinel and emits pausePending for a running ship session', () => {
    const manager = createManager();

    manager.spawn({
      sessionId: 'ship-1',
      command: 'ship',
      repo: 'owner/repo',
      commandName: 'shipper',
      args: ['ship', '41', '--mode', 'headless'],
      cwd: '/tmp/repo',
      meta: { issueNumber: 41 },
    });

    manager.requestPause('ship-1');

    const pauseSentinelPath = join(tempDir, 'pause-sentinels', 'ship-1');
    expect(existsSync(pauseSentinelPath)).toBe(true);
    expect(readFileSync(pauseSentinelPath, 'utf8')).toBe('');
    const pendingEvent = statusEvents().find(
      (event) =>
        event.sessionId === 'ship-1' &&
        event.status === 'running' &&
        isRecord(event.meta) &&
        event.meta.pausePending === true
    );
    expect(pendingEvent).toEqual(
      expect.objectContaining({
        sessionId: 'ship-1',
        status: 'running',
      })
    );
    expect(pendingEvent?.meta).toEqual(
      expect.objectContaining({
        issueNumber: 41,
        pausePending: true,
      })
    );
  });

  it('halts only running auto-origin ship sessions for the requested repo', () => {
    const manager = createManager();

    manager.spawn({
      sessionId: 'ship-auto',
      command: 'ship',
      repo: 'owner/repo',
      commandName: 'shipper',
      args: ['ship', '41', '--mode', 'headless'],
      cwd: '/tmp/repo',
      meta: { issueNumber: 41, origin: 'auto' },
    });
    manager.spawn({
      sessionId: 'ship-manual',
      command: 'ship',
      repo: 'other/repo',
      commandName: 'shipper',
      args: ['ship', '42', '--mode', 'headless'],
      cwd: '/tmp/repo',
      meta: { issueNumber: 42, origin: 'manual' },
    });

    expect(manager.requestAutoShipHalt('owner/repo')).toBe(1);

    expect(existsSync(join(tempDir, 'pause-sentinels', 'ship-auto'))).toBe(true);
    expect(existsSync(join(tempDir, 'pause-sentinels', 'ship-manual'))).toBe(false);
  });

  it('ignores queued, manual, and already-halted ship sessions when auto-ship halt is requested', () => {
    const manager = createManager();

    manager.spawn({
      sessionId: 'ship-auto-running',
      command: 'ship',
      repo: 'owner/repo',
      commandName: 'shipper',
      args: ['ship', '41', '--mode', 'headless'],
      cwd: '/tmp/repo',
      meta: { issueNumber: 41, origin: 'auto' },
    });
    manager.spawn({
      sessionId: 'ship-auto-queued',
      command: 'ship',
      repo: 'owner/repo',
      commandName: 'shipper',
      args: ['ship', '42', '--mode', 'headless'],
      cwd: '/tmp/repo',
      meta: { issueNumber: 42, origin: 'auto' },
    });
    manager.spawn({
      sessionId: 'ship-manual-running',
      command: 'ship',
      repo: 'owner/repo',
      commandName: 'shipper',
      args: ['ship', '43', '--mode', 'headless'],
      cwd: '/tmp/repo',
      meta: { issueNumber: 43, origin: 'manual' },
    });

    expect(manager.requestAutoShipHalt('owner/repo')).toBe(1);
    expect(manager.requestAutoShipHalt('owner/repo')).toBe(0);

    expect(existsSync(join(tempDir, 'pause-sentinels', 'ship-auto-running'))).toBe(true);
    expect(existsSync(join(tempDir, 'pause-sentinels', 'ship-auto-queued'))).toBe(false);
    expect(existsSync(join(tempDir, 'pause-sentinels', 'ship-manual-running'))).toBe(false);
  });

  it('marks a queued ship session as paused without setting cancelled metadata', () => {
    const manager = createManager();

    manager.spawn({
      sessionId: 'ship-1',
      command: 'ship',
      repo: 'owner/repo',
      commandName: 'shipper',
      args: ['ship', '41', '--mode', 'headless'],
      cwd: '/tmp/repo',
      meta: { issueNumber: 41 },
    });
    manager.spawn({
      sessionId: 'ship-2',
      command: 'ship',
      repo: 'owner/repo',
      commandName: 'shipper',
      args: ['ship', '42', '--mode', 'headless'],
      cwd: '/tmp/repo',
      meta: { issueNumber: 42 },
    });

    expect(manager.removeQueuedSession('ship-2')).toBe('paused');
    latestChild().close(0);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const pausedEvent = statusEvents().find(
      (event) => event.sessionId === 'ship-2' && event.status === 'paused'
    );
    expect(pausedEvent).toEqual(
      expect.objectContaining({
        sessionId: 'ship-2',
        status: 'paused',
      })
    );
    expect(pausedEvent?.meta).toEqual(
      expect.objectContaining({
        issueNumber: 42,
      })
    );
    expect(
      statusEvents().some(
        (event) =>
          event.sessionId === 'ship-2' && isRecord(event.meta) && event.meta.cancelled === true
      )
    ).toBe(false);
  });

  it('converts a queued pause request into a running pause request if the session already advanced', () => {
    const manager = createManager();

    manager.spawn({
      sessionId: 'ship-1',
      command: 'ship',
      repo: 'owner/repo',
      commandName: 'shipper',
      args: ['ship', '41', '--mode', 'headless'],
      cwd: '/tmp/repo',
      meta: { issueNumber: 41 },
    });
    manager.spawn({
      sessionId: 'ship-2',
      command: 'ship',
      repo: 'owner/repo',
      commandName: 'shipper',
      args: ['ship', '42', '--mode', 'headless'],
      cwd: '/tmp/repo',
      meta: { issueNumber: 42 },
    });

    children[0]?.close(0);

    expect(manager.removeQueuedSession('ship-2')).toBe('pause-requested');

    const pauseSentinelPath = join(tempDir, 'pause-sentinels', 'ship-2');
    expect(existsSync(pauseSentinelPath)).toBe(true);
    expect(
      statusEvents().some(
        (event) =>
          event.sessionId === 'ship-2' &&
          event.status === 'running' &&
          isRecord(event.meta) &&
          event.meta.pausePending === true
      )
    ).toBe(true);
  });

  it('classifies paused exit codes as paused and removes the sentinel file', () => {
    const manager = createManager();

    manager.spawn({
      sessionId: 'ship-1',
      command: 'ship',
      repo: 'owner/repo',
      commandName: 'shipper',
      args: ['ship', '41', '--mode', 'headless'],
      cwd: '/tmp/repo',
      meta: { issueNumber: 41 },
    });
    manager.requestPause('ship-1');

    const pauseSentinelPath = join(tempDir, 'pause-sentinels', 'ship-1');
    latestChild().close(PAUSED_EXIT_CODE);

    expect(statusEvents()).toContainEqual(
      expect.objectContaining({
        sessionId: 'ship-1',
        status: 'paused',
        exitCode: PAUSED_EXIT_CODE,
      })
    );
    expect(existsSync(pauseSentinelPath)).toBe(false);
  });

  it('maps retriable failure exit codes to failed status with retriable metadata and releases the lock', async () => {
    const manager = createManager();

    manager.spawn({
      sessionId: 'ship-retriable',
      command: 'ship',
      repo: 'owner/repo',
      commandName: 'shipper',
      args: ['ship', '41', '--mode', 'headless'],
      cwd: '/tmp/repo',
      meta: { issueNumber: 41, issueUrl: 'https://example.com/issues/41' },
    });

    latestChild().close(RETRIABLE_FAILURE_EXIT_CODE);
    await flushBackgroundCleanup();

    const retriableEvent = statusEvents().find(
      (event) => event.sessionId === 'ship-retriable' && event.status === 'failed'
    );

    expect(retriableEvent).toEqual(
      expect.objectContaining({
        sessionId: 'ship-retriable',
        status: 'failed',
        exitCode: RETRIABLE_FAILURE_EXIT_CODE,
      })
    );
    expect(isRecord(retriableEvent?.meta) ? retriableEvent.meta : undefined).toEqual(
      expect.objectContaining({
        issueNumber: 41,
        issueUrl: 'https://example.com/issues/41',
        retriable: true,
      })
    );
    expect(ghCommandCalls()).toHaveLength(1);
    expectRemoveLabelCall('41', 'owner/repo');
  });

  it('emits completion metadata returned by onComplete', async () => {
    const manager = createManager();

    manager.spawn({
      sessionId: 'ship-complete-meta',
      command: 'ship',
      repo: 'owner/repo',
      commandName: 'shipper',
      args: ['ship', '41', '--mode', 'headless'],
      cwd: '/tmp/repo',
      meta: { issueNumber: 41 },
      onComplete: () => ({ issueTitle: 'Resolved title', prMerged: true }),
    });

    latestChild().close(0);
    await flushBackgroundCleanup();

    const completeEvent = statusEvents().find(
      (event) => event.sessionId === 'ship-complete-meta' && event.status === 'complete'
    );
    expect(completeEvent).toEqual(
      expect.objectContaining({
        sessionId: 'ship-complete-meta',
        status: 'complete',
        exitCode: 0,
      })
    );
    expect(isRecord(completeEvent?.meta) ? completeEvent.meta : undefined).toEqual(
      expect.objectContaining({
        issueNumber: 41,
        issueTitle: 'Resolved title',
        prMerged: true,
      })
    );
  });

  it('maps auto-ship halts to complete while preserving paused status for user pauses', () => {
    const autoHaltManager = createManager();

    autoHaltManager.spawn({
      sessionId: 'ship-auto-halt',
      command: 'ship',
      repo: 'owner/repo',
      commandName: 'shipper',
      args: ['ship', '41', '--mode', 'headless'],
      cwd: '/tmp/repo',
      meta: { issueNumber: 41, origin: 'auto' },
    });
    autoHaltManager.requestAutoShipHalt('owner/repo');
    latestChild().close(PAUSED_EXIT_CODE);

    const autoHaltEvent = statusEvents().find(
      (event) => event.sessionId === 'ship-auto-halt' && event.status === 'complete'
    );
    expect(autoHaltEvent).toEqual(
      expect.objectContaining({
        sessionId: 'ship-auto-halt',
        status: 'complete',
        exitCode: PAUSED_EXIT_CODE,
      })
    );
    expect(autoHaltEvent?.meta).toEqual(
      expect.objectContaining({
        issueNumber: 41,
        autoShipHalted: true,
      })
    );

    const userPauseManager = createManager();
    userPauseManager.spawn({
      sessionId: 'ship-user-pause',
      command: 'ship',
      repo: 'owner/repo',
      commandName: 'shipper',
      args: ['ship', '42', '--mode', 'headless'],
      cwd: '/tmp/repo',
      meta: { issueNumber: 42, origin: 'auto' },
    });
    userPauseManager.requestPause('ship-user-pause');
    latestChild().close(PAUSED_EXIT_CODE);

    expect(statusEvents()).toContainEqual(
      expect.objectContaining({
        sessionId: 'ship-user-pause',
        status: 'paused',
        exitCode: PAUSED_EXIT_CODE,
      })
    );
  });

  it('keeps cancelled failure semantics when stop wins during a pending pause', async () => {
    const manager = createManager();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    manager.spawn({
      sessionId: 'ship-1',
      command: 'ship',
      repo: 'owner/repo',
      commandName: 'shipper',
      args: ['ship', '41', '--mode', 'headless'],
      cwd: '/tmp/repo',
      meta: { issueNumber: 41 },
    });
    manager.requestPause('ship-1');
    manager.kill('ship-1');
    latestChild().close(PAUSED_EXIT_CODE);
    await flushBackgroundCleanup();

    expect(killSpy).toHaveBeenCalledWith(latestChild().pid, 'SIGTERM');
    const failedEvent = statusEvents().find(
      (event) => event.sessionId === 'ship-1' && event.status === 'failed'
    );
    expect(failedEvent).toEqual(
      expect.objectContaining({
        sessionId: 'ship-1',
        status: 'failed',
        exitCode: PAUSED_EXIT_CODE,
      })
    );
    expect(failedEvent?.meta).toEqual(
      expect.objectContaining({
        cancelled: true,
      })
    );
  });

  it('cleans up pause sentinels on complete, failed, and destroyAll', () => {
    const completedManager = createManager();
    completedManager.spawn({
      sessionId: 'ship-complete',
      command: 'ship',
      repo: 'owner/repo',
      commandName: 'shipper',
      args: ['ship', '41', '--mode', 'headless'],
      cwd: '/tmp/repo',
    });
    completedManager.requestPause('ship-complete');
    const completePath = join(tempDir, 'pause-sentinels', 'ship-complete');
    latestChild().close(0);
    expect(existsSync(completePath)).toBe(false);

    const failedManager = createManager();
    failedManager.spawn({
      sessionId: 'ship-failed',
      command: 'ship',
      repo: 'owner/repo',
      commandName: 'shipper',
      args: ['ship', '42', '--mode', 'headless'],
      cwd: '/tmp/repo',
    });
    failedManager.requestPause('ship-failed');
    const failedPath = join(tempDir, 'pause-sentinels', 'ship-failed');
    latestChild().close(1);
    expect(existsSync(failedPath)).toBe(false);

    const destroyManager = createManager();
    destroyManager.spawn({
      sessionId: 'ship-destroy',
      command: 'ship',
      repo: 'owner/repo',
      commandName: 'shipper',
      args: ['ship', '43', '--mode', 'headless'],
      cwd: '/tmp/repo',
    });
    destroyManager.requestPause('ship-destroy');
    const destroyPath = join(tempDir, 'pause-sentinels', 'ship-destroy');
    expect(existsSync(destroyPath)).toBe(true);

    destroyManager.destroyAll();

    expect(existsSync(destroyPath)).toBe(false);
    expect(existsSync(join(tempDir, 'pause-sentinels'))).toBe(false);
  });

  it('removes a queued ship session without spawning it when cancelled', () => {
    const manager = createManager();

    manager.spawn({
      sessionId: 'ship-1',
      command: 'ship',
      repo: 'owner/repo',
      commandName: 'shipper',
      args: ['ship', '41', '--mode', 'headless'],
      cwd: '/tmp/repo',
      meta: { issueNumber: 41 },
    });
    manager.spawn({
      sessionId: 'ship-2',
      command: 'ship',
      repo: 'owner/repo',
      commandName: 'shipper',
      args: ['ship', '42', '--mode', 'headless'],
      cwd: '/tmp/repo',
      meta: { issueNumber: 42 },
    });

    manager.kill('ship-2');
    latestChild().close(0);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(ghCommandCalls()).toHaveLength(0);
    expect(
      statusEvents().some(
        (event) =>
          event.sessionId === 'ship-2' &&
          event.status === 'failed' &&
          isRecord(event.meta) &&
          event.meta.cancelled === true
      )
    ).toBe(true);
  });

  it('releases the ship lock when a running ship exits non-zero', async () => {
    const manager = createManager();

    manager.spawn({
      sessionId: 'ship-failed',
      command: 'ship',
      repo: 'owner/repo',
      commandName: 'shipper',
      args: ['ship', '41', '--mode', 'headless'],
      cwd: '/tmp/repo',
      meta: { issueNumber: 41 },
    });

    latestChild().close(1);
    await flushBackgroundCleanup();

    expect(ghCommandCalls()).toHaveLength(1);
    expectRemoveLabelCall('41', 'owner/repo');
  });

  it('releases the ship lock when a running ship is cancelled', async () => {
    const manager = createManager();

    manager.spawn({
      sessionId: 'ship-cancelled',
      command: 'ship',
      repo: 'owner/repo',
      commandName: 'shipper',
      args: ['ship', '41', '--mode', 'headless'],
      cwd: '/tmp/repo',
      meta: { issueNumber: 41 },
    });

    manager.kill('ship-cancelled');
    latestChild().close(0);
    await flushBackgroundCleanup();

    expect(ghCommandCalls()).toHaveLength(1);
    expectRemoveLabelCall('41', 'owner/repo');
  });

  it('does not release the ship lock after a successful ship exit', async () => {
    const manager = createManager();

    manager.spawn({
      sessionId: 'ship-success',
      command: 'ship',
      repo: 'owner/repo',
      commandName: 'shipper',
      args: ['ship', '41', '--mode', 'headless'],
      cwd: '/tmp/repo',
      meta: { issueNumber: 41 },
    });

    latestChild().close(0);
    await flushBackgroundCleanup();

    expect(ghCommandCalls()).toHaveLength(0);
  });

  it('does not release the ship lock after a user pause', async () => {
    const manager = createManager();

    manager.spawn({
      sessionId: 'ship-paused',
      command: 'ship',
      repo: 'owner/repo',
      commandName: 'shipper',
      args: ['ship', '41', '--mode', 'headless'],
      cwd: '/tmp/repo',
      meta: { issueNumber: 41 },
    });
    manager.requestPause('ship-paused');

    latestChild().close(PAUSED_EXIT_CODE);
    await flushBackgroundCleanup();

    expect(ghCommandCalls()).toHaveLength(0);
  });

  it('does not release the ship lock when the failed session lacks an issue number', async () => {
    const manager = createManager();

    manager.spawn({
      sessionId: 'ship-no-issue',
      command: 'ship',
      repo: 'owner/repo',
      commandName: 'shipper',
      args: ['ship', '--mode', 'headless'],
      cwd: '/tmp/repo',
    });

    latestChild().close(1);
    await flushBackgroundCleanup();

    expect(ghCommandCalls()).toHaveLength(0);
  });

  it('retries lock release failures, warns once, and still settles the session', async () => {
    vi.useFakeTimers();
    execFileMock.mockImplementation((file, args, optionsOrCallback, callback) => {
      const cb = getExecFileCallback(optionsOrCallback, callback);
      if (file !== 'gh') {
        cb?.(null, '', '');
        return {} as never;
      }

      if (Array.isArray(args) && args[0] === 'issue' && args[1] === 'view' && args[2] === '41') {
        cb?.(null, `${LOCKED_LABEL}\n`, '');
        return {} as never;
      }

      cb?.(new Error('remove-label failed'), '', 'remove-label failed');
      return {} as never;
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = createManager();

    manager.spawn({
      sessionId: 'ship-retry-warning',
      command: 'ship',
      repo: 'owner/repo',
      commandName: 'shipper',
      args: ['ship', '41', '--mode', 'headless'],
      cwd: '/tmp/repo',
      meta: { issueNumber: 41 },
    });

    latestChild().close(1);
    await flushBackgroundCleanup();
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);
    await flushBackgroundCleanup();

    expect(
      ghCommandCalls().filter(
        (args) => args[0] === 'issue' && args[1] === 'edit' && args[2] === '41'
      )
    ).toHaveLength(3);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      '[shipper] Failed to release lock for owner/repo#41 after 3 attempts; stale-lock self-heal will clear it.'
    );
    expect(
      statusEvents().filter(
        (event) => event.sessionId === 'ship-retry-warning' && event.status === 'failed'
      )
    ).toHaveLength(1);
  });

  it('emits failed status only after the lock release attempt completes', async () => {
    let releaseCallback:
      | ((error: Error | null, stdout: string, stderr: string) => void)
      | undefined;
    execFileMock.mockImplementation((file, args, optionsOrCallback, callback) => {
      const cb = getExecFileCallback(optionsOrCallback, callback);
      if (
        file === 'gh' &&
        Array.isArray(args) &&
        args[0] === 'issue' &&
        args[1] === 'edit' &&
        args[2] === '41'
      ) {
        releaseCallback = cb;
        return {} as never;
      }

      cb?.(null, '', '');
      return {} as never;
    });
    const manager = createManager();

    manager.spawn({
      sessionId: 'ship-ordered-failure',
      command: 'ship',
      repo: 'owner/repo',
      commandName: 'shipper',
      args: ['ship', '41', '--mode', 'headless'],
      cwd: '/tmp/repo',
      meta: { issueNumber: 41 },
    });

    latestChild().close(1);
    await flushBackgroundCleanup();

    expect(
      statusEvents().some(
        (event) => event.sessionId === 'ship-ordered-failure' && event.status === 'failed'
      )
    ).toBe(false);

    releaseCallback?.(null, '', '');
    await flushBackgroundCleanup();

    expect(
      statusEvents().some(
        (event) => event.sessionId === 'ship-ordered-failure' && event.status === 'failed'
      )
    ).toBe(true);
  });

  it('treats an already-cleared lock as a no-op without retries or warnings', async () => {
    execFileMock.mockImplementation((file, args, optionsOrCallback, callback) => {
      const cb = getExecFileCallback(optionsOrCallback, callback);
      if (
        file === 'gh' &&
        Array.isArray(args) &&
        args[0] === 'issue' &&
        args[1] === 'edit' &&
        args[2] === '41'
      ) {
        cb?.(new Error('remove-label failed'), '', 'remove-label failed');
        return {} as never;
      }

      if (
        file === 'gh' &&
        Array.isArray(args) &&
        args[0] === 'issue' &&
        args[1] === 'view' &&
        args[2] === '41'
      ) {
        cb?.(null, '', '');
        return {} as never;
      }

      cb?.(null, '', '');
      return {} as never;
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = createManager();

    manager.spawn({
      sessionId: 'ship-lock-already-cleared',
      command: 'ship',
      repo: 'owner/repo',
      commandName: 'shipper',
      args: ['ship', '41', '--mode', 'headless'],
      cwd: '/tmp/repo',
      meta: { issueNumber: 41 },
    });

    latestChild().close(1);
    await flushBackgroundCleanup();

    expect(ghCommandCalls()).toEqual([
      ['issue', 'edit', '41', '-R', 'owner/repo', '--remove-label', LOCKED_LABEL],
      ['issue', 'view', '41', '-R', 'owner/repo', '--json', 'labels', '--jq', '.labels[].name'],
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
