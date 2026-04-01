import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as childProcess from 'node:child_process';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { BackgroundManager } from '../src/main/background-manager.js';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

beforeEach(() => {
  pid = 1000;
  children = [];
  tempDir = mkdtempSync(join(tmpdir(), 'shipper-bg-manager-'));
  mockSpawn.mockReset();
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
  it('queues same-repo ship sessions and promotes the next one after completion', () => {
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
});
