import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as nodePty from 'node-pty';

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

function createMockPtyProcess(): MockPtyProcess {
  let exitHandler: PtyExitHandler | undefined;

  return {
    pid: 1234,
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

function spawnSession(manager: PtyManager, sessionId = 'session-1'): MockPtyProcess {
  manager.spawn(sessionId, 'bash', [], { cols: 80, rows: 24 });

  const process = spawnedProcesses.at(-1);
  if (!process) {
    throw new Error('Expected node-pty.spawn to create a PTY process.');
  }

  return process;
}

describe('PtyManager.onSessionExit', () => {
  beforeEach(() => {
    spawnedProcesses = [];
    mockSpawn.mockReset();
    mockSpawn.mockImplementation(() => {
      const process = createMockPtyProcess();
      spawnedProcesses.push(process);
      return process as never;
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

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
});
