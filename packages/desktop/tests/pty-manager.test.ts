import { mkdtemp, rm, writeFile, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as nodePty from 'node-pty';
import {
  DESKTOP_AGENT_GRACE_TIMEOUT_MS,
  DESKTOP_FINALIZE_SENTINEL_FILE,
  writeDesktopControlState,
} from '@dnsquared/shipper-core';

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

import { PtyManager } from '../src/main/pty-manager.js';

type PtyExitHandler = (event: { exitCode: number; signal?: number }) => void;

interface MockPtyProcess {
  pid: number;
  onData: ReturnType<typeof vi.fn>;
  onExit: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  triggerExit: (exitCode: number) => void;
  write: ReturnType<typeof vi.fn>;
}

const mockSpawn = vi.mocked(nodePty.spawn);

let spawnedProcesses: MockPtyProcess[] = [];
let nextPid = 1234;

function createMockPtyProcess(): MockPtyProcess {
  let exitHandler: PtyExitHandler | undefined;
  const pid = nextPid;
  nextPid += 1;

  return {
    pid,
    onData: vi.fn(),
    onExit: vi.fn((handler: PtyExitHandler) => {
      exitHandler = handler;
    }),
    resize: vi.fn(),
    triggerExit: (exitCode: number) => {
      if (!exitHandler) {
        throw new Error('Expected PtyManager to register an exit handler.');
      }
      exitHandler({ exitCode });
    },
    write: vi.fn(),
  };
}

function spawnSession(
  manager: PtyManager,
  sessionId = 'session-1',
  options: Partial<Parameters<PtyManager['spawn']>[3]> = {}
): MockPtyProcess {
  manager.spawn(sessionId, 'bash', [], { cols: 80, rows: 24, ...options });

  const process = spawnedProcesses.at(-1);
  if (!process) {
    throw new Error('Expected node-pty.spawn to create a PTY process.');
  }

  return process;
}

describe('PtyManager.onSessionExit', () => {
  let tempDirs: string[];
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tempDirs = [];
    nextPid = 1234;
    spawnedProcesses = [];
    mockSpawn.mockReset();
    mockSpawn.mockImplementation(() => {
      const process = createMockPtyProcess();
      spawnedProcesses.push(process);
      return process as never;
    });
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  async function createControlDir(hasResult: boolean): Promise<string> {
    const controlDir = await mkdtemp(path.join(tmpdir(), 'shipper-pty-test-'));
    tempDirs.push(controlDir);
    const outputDir = path.join(controlDir, 'output');
    await mkdir(outputDir, { recursive: true });
    await writeDesktopControlState(controlDir, {
      stage: 'groom',
      worktreePath: path.join(controlDir, 'worktree'),
      outputDir,
    });
    if (hasResult) {
      await writeFile(path.join(outputDir, 'result.json'), '{}', 'utf-8');
    }
    return controlDir;
  }

  it('fires the registered callback when the PTY exits', () => {
    const manager = new PtyManager();
    const onExit = vi.fn();
    const process = spawnSession(manager);

    manager.onSessionExit('session-1', onExit);
    process.triggerExit(0);

    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('uses the latest callback when a session callback is replaced', () => {
    const manager = new PtyManager();
    const originalCallback = vi.fn();
    const latestCallback = vi.fn();
    const process = spawnSession(manager);

    manager.onSessionExit('session-1', originalCallback);
    manager.onSessionExit('session-1', latestCallback);
    process.triggerExit(0);

    expect(originalCallback).not.toHaveBeenCalled();
    expect(latestCallback).toHaveBeenCalledTimes(1);
  });

  it('does not error when a session exits without a registered callback', () => {
    const manager = new PtyManager();
    const process = spawnSession(manager);

    expect(() => {
      process.triggerExit(0);
    }).not.toThrow();
  });

  it('writes initial input once after spawn when provided', () => {
    const manager = new PtyManager();
    manager.spawn('session-2', 'bash', [], {
      cols: 80,
      rows: 24,
      initialInput: 'seed prompt',
    });

    const seededProcess = spawnedProcesses.at(-1);
    if (!seededProcess) {
      throw new Error('Expected node-pty.spawn to create a PTY process.');
    }

    expect(seededProcess.write).toHaveBeenCalledTimes(1);
    expect(seededProcess.write).toHaveBeenCalledWith('seed prompt\n');
  });

  it('does not write automatically when initial input is omitted', () => {
    const manager = new PtyManager();
    const process = spawnSession(manager);

    expect(process.write).not.toHaveBeenCalled();
  });

  it('returns close state for setup, groom, finalizing, and missing sessions', async () => {
    const manager = new PtyManager();
    const noResultControlDir = await createControlDir(false);
    const resultControlDir = await createControlDir(true);
    spawnSession(manager, 'setup', { kind: 'setup' });
    spawnSession(manager, 'groom-no-result', { kind: 'groom', controlDir: noResultControlDir });
    spawnSession(manager, 'groom-result', { kind: 'groom', controlDir: resultControlDir });
    spawnSession(manager, 'finalizing', { kind: 'setup' });

    await manager.finalize('finalizing');

    await expect(manager.getCloseState('setup')).resolves.toEqual({ state: 'finalizable' });
    await expect(manager.getCloseState('groom-no-result')).resolves.toEqual({
      state: 'requires-discard-confirmation',
    });
    await expect(manager.getCloseState('groom-result')).resolves.toEqual({ state: 'finalizable' });
    await expect(manager.getCloseState('finalizing')).resolves.toEqual({ state: 'finalizing' });
    await expect(manager.getCloseState('missing')).resolves.toEqual({ state: 'exited' });
  });

  it('finalizes groom by writing the sentinel without signaling the wrapper PTY', async () => {
    const manager = new PtyManager();
    const controlDir = await createControlDir(true);
    spawnSession(manager, 'groom', { kind: 'groom', controlDir });

    await manager.finalize('groom');

    await expect(
      access(path.join(controlDir, DESKTOP_FINALIZE_SENTINEL_FILE))
    ).resolves.toBeUndefined();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('does not publish finalizing when a groom finalize request cannot be written', async () => {
    const manager = new PtyManager();
    const parentDir = await mkdtemp(path.join(tmpdir(), 'shipper-pty-test-'));
    tempDirs.push(parentDir);
    const invalidControlDir = path.join(parentDir, 'not-a-directory');
    await writeFile(invalidControlDir, 'not a directory', 'utf-8');
    spawnSession(manager, 'groom', { kind: 'groom', controlDir: invalidControlDir });

    await expect(manager.finalize('groom')).rejects.toThrow();

    await expect(manager.getCloseState('groom')).resolves.toEqual({
      state: 'requires-discard-confirmation',
    });
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('finalizes setup with SIGTERM and force-kills after the grace timeout', async () => {
    vi.useFakeTimers();
    const manager = new PtyManager();
    const ptyProcess = spawnSession(manager, 'setup', { kind: 'setup' });

    await manager.finalize('setup');

    expect(killSpy).toHaveBeenCalledWith(ptyProcess.pid, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(DESKTOP_AGENT_GRACE_TIMEOUT_MS);
    expect(killSpy).toHaveBeenCalledWith(ptyProcess.pid, 'SIGKILL');
  });

  it('removes a groom control directory when the PTY exits', async () => {
    const manager = new PtyManager();
    const controlDir = await createControlDir(true);
    const ptyProcess = spawnSession(manager, 'groom', { kind: 'groom', controlDir });

    ptyProcess.triggerExit(0);

    await expect(access(controlDir)).rejects.toThrow();
  });

  it('force-kills immediately', () => {
    const manager = new PtyManager();
    const ptyProcess = spawnSession(manager, 'session-1');

    manager.forceKill('session-1');

    expect(killSpy).toHaveBeenCalledWith(ptyProcess.pid, 'SIGKILL');
  });

  it('closes live workflow sessions for quit according to close state', async () => {
    const manager = new PtyManager();
    const resultControlDir = await createControlDir(true);
    const noResultControlDir = await createControlDir(false);
    const resultPty = spawnSession(manager, 'groom-result', {
      kind: 'groom',
      label: 'groom — #1',
      controlDir: resultControlDir,
    });
    const noResultPty = spawnSession(manager, 'groom-no-result', {
      kind: 'groom',
      label: 'groom — #2',
      controlDir: noResultControlDir,
    });

    const closePromise = manager.closeLiveWorkflowSessionsForQuit();
    await vi.waitFor(async () => {
      await expect(
        access(path.join(resultControlDir, DESKTOP_FINALIZE_SENTINEL_FILE))
      ).resolves.toBeUndefined();
    });
    resultPty.triggerExit(0);
    noResultPty.triggerExit(1);
    await closePromise;

    expect(killSpy).toHaveBeenCalledWith(noResultPty.pid, 'SIGKILL');
    expect(killSpy).not.toHaveBeenCalledWith(resultPty.pid, 'SIGKILL');
  });
});
