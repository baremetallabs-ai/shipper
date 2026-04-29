import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const shipOneIssueMock =
  vi.fn<
    (options: {
      repo: string;
      issue: string;
      merge: boolean;
      agent?: string;
      model?: string;
      disableMcp?: boolean;
      logFile?: string;
      skipInteractiveStages: boolean;
      collectTokens: boolean;
    }) => Promise<{ success: boolean; error?: string }>
  >();
const processSendMock = vi.fn<
  (message: unknown, callback?: (error: Error | null) => void) => boolean
>((_message, callback) => {
  callback?.(null);
  return true;
});

vi.mock('../src/commands/ship-execute.js', () => ({
  shipOneIssue: shipOneIssueMock,
}));

describe('ship-worker', () => {
  const originalSendDescriptor = Object.getOwnPropertyDescriptor(process, 'send');
  let messageHandler: ((message: unknown) => void) | undefined;
  let processOnMock: ReturnType<typeof vi.spyOn>;
  let processExitMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    messageHandler = undefined;
    processOnMock = vi.spyOn(process, 'on').mockImplementation(((
      event: string,
      listener: (...args: unknown[]) => void
    ) => {
      if (event === 'message') {
        messageHandler = listener;
      }
      return process;
    }) as typeof process.on);
    processExitMock = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null) => code as never);
    Object.defineProperty(process, 'send', {
      configurable: true,
      value: processSendMock,
    });
    shipOneIssueMock.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    processOnMock.mockRestore();
    processExitMock.mockRestore();
    if (originalSendDescriptor) {
      Object.defineProperty(process, 'send', originalSendDescriptor);
    } else {
      delete process.send;
    }
  });

  it('runs shipOneIssue with worker-specific options for valid run payloads', async () => {
    await import('../src/ship-worker.js');
    if (!messageHandler) {
      throw new Error('Expected worker message handler to be registered');
    }

    messageHandler({
      type: 'run',
      repo: 'owner/repo',
      issue: '42',
      agent: 'codex',
      model: 'gpt-5',
      logFile: '/tmp/ship.log',
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(shipOneIssueMock).toHaveBeenCalledWith({
      repo: 'owner/repo',
      issue: '42',
      merge: true,
      agent: 'codex',
      model: 'gpt-5',
      disableMcp: undefined,
      logFile: '/tmp/ship.log',
      skipInteractiveStages: true,
      collectTokens: false,
    });
    expect(processSendMock).toHaveBeenCalledWith(
      {
        type: 'result',
        success: true,
      },
      expect.any(Function)
    );
    expect(processExitMock).toHaveBeenCalledWith(0);
  });

  it('rejects invalid worker payloads without calling shipOneIssue', async () => {
    await import('../src/ship-worker.js');
    if (!messageHandler) {
      throw new Error('Expected worker message handler to be registered');
    }

    messageHandler({ type: 'invalid' });
    await Promise.resolve();
    await Promise.resolve();

    expect(shipOneIssueMock).not.toHaveBeenCalled();
    expect(processSendMock).toHaveBeenCalledWith(
      {
        type: 'result',
        success: false,
        error: 'worker received an invalid run payload',
      },
      expect.any(Function)
    );
    expect(processExitMock).toHaveBeenCalledWith(1);
  });

  it('still exits when sending the IPC result fails', async () => {
    processSendMock.mockImplementationOnce((_message, callback) => {
      callback?.(new Error('ipc failure'));
      return false;
    });

    await import('../src/ship-worker.js');
    if (!messageHandler) {
      throw new Error('Expected worker message handler to be registered');
    }

    messageHandler({
      type: 'run',
      repo: 'owner/repo',
      issue: '42',
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(processExitMock).toHaveBeenCalledWith(0);
  });

  it('forwards disableMcp from worker payloads', async () => {
    await import('../src/ship-worker.js');
    if (!messageHandler) {
      throw new Error('Expected worker message handler to be registered');
    }

    messageHandler({
      type: 'run',
      repo: 'owner/repo',
      issue: '42',
      disableMcp: true,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(shipOneIssueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: 'owner/repo',
        issue: '42',
        disableMcp: true,
      })
    );
  });
});
