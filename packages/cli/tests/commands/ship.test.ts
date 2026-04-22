import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mkdirSyncMock,
  existsSyncMock,
  shipAutoParallelMock,
  shipAutoSequentialMock,
  shipOneIssueMock,
  loggerLogMock,
} = vi.hoisted(() => ({
  mkdirSyncMock: vi.fn(),
  existsSyncMock: vi.fn(),
  shipAutoParallelMock: vi.fn(),
  shipAutoSequentialMock: vi.fn(),
  shipOneIssueMock:
    vi.fn<
      (options: {
        repo: string;
        issue: string;
        merge: boolean;
        pauseProbe?: () => boolean | Promise<boolean>;
      }) => Promise<{ success: boolean; paused?: boolean; error?: string }>
    >(),
  loggerLogMock: vi.fn(),
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: () => '/mock-home',
  };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: existsSyncMock,
    mkdirSync: mkdirSyncMock,
  };
});

vi.mock('@dnsquared/shipper-core', async () => {
  const actual =
    await vi.importActual<typeof import('@dnsquared/shipper-core')>('@dnsquared/shipper-core');
  return {
    ...actual,
    logger: {
      ...actual.logger,
      log: loggerLogMock,
    },
  };
});

vi.mock('../../src/commands/ship-auto.js', () => ({
  shipAutoParallel: shipAutoParallelMock,
  shipAutoSequential: shipAutoSequentialMock,
}));

vi.mock('../../src/commands/ship-execute.js', () => ({
  formatLogDisplayPath: (logFile: string, homeDir = '/mock-home') =>
    logFile.startsWith(homeDir) ? `~${logFile.slice(homeDir.length)}` : logFile,
  formatLogTimestamp: () => '20260422T120000',
  shipOneIssue: shipOneIssueMock,
}));

describe('shipCommand', () => {
  const originalPauseSentinel = process.env.SHIPPER_PAUSE_SENTINEL_FILE;

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    delete process.env.SHIPPER_PAUSE_SENTINEL_FILE;
    shipOneIssueMock.mockResolvedValue({ success: true });
    shipAutoParallelMock.mockResolvedValue(undefined);
    shipAutoSequentialMock.mockResolvedValue(undefined);
    existsSyncMock.mockReturnValue(false);
  });

  afterEach(() => {
    process.exitCode = undefined;
    if (originalPauseSentinel === undefined) {
      delete process.env.SHIPPER_PAUSE_SENTINEL_FILE;
    } else {
      process.env.SHIPPER_PAUSE_SENTINEL_FILE = originalPauseSentinel;
    }
    vi.restoreAllMocks();
  });

  it('passes a pause probe only when the desktop pause sentinel env var is set', async () => {
    process.env.SHIPPER_PAUSE_SENTINEL_FILE = '/tmp/pause-sentinel';
    const { shipCommand } = await import('../../src/commands/ship.js');

    await shipCommand('owner/repo', '42', { merge: false, auto: false });

    const firstCall = vi.mocked(shipOneIssueMock).mock.calls[0];
    if (!firstCall) {
      throw new Error('Expected shipOneIssue to be called.');
    }

    expect(firstCall[0].repo).toBe('owner/repo');
    expect(firstCall[0].issue).toBe('42');
    expect(firstCall[0].pauseProbe).toBeTypeOf('function');

    const pauseProbe = firstCall[0].pauseProbe;
    expect(await pauseProbe?.()).toBe(false);
    expect(existsSyncMock).toHaveBeenCalledWith('/tmp/pause-sentinel');
  });

  it('does not pass a pause probe when no sentinel env var is present', async () => {
    const { shipCommand } = await import('../../src/commands/ship.js');

    await shipCommand('owner/repo', '42', { merge: false, auto: false });

    expect(shipOneIssueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: 'owner/repo',
        issue: '42',
        pauseProbe: undefined,
      })
    );
    expect(existsSyncMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('maps paused results to the shared paused exit code', async () => {
    shipOneIssueMock.mockResolvedValue({ success: true, paused: true });
    const { shipCommand } = await import('../../src/commands/ship.js');

    await shipCommand('owner/repo', '42', { merge: false, auto: false });

    expect(process.exitCode).toBe(75);
  });

  it('keeps ordinary failures mapped to exit code 1', async () => {
    shipOneIssueMock.mockResolvedValue({ success: false, error: 'boom' });
    const { shipCommand } = await import('../../src/commands/ship.js');

    await shipCommand('owner/repo', '42', { merge: false, auto: false });

    expect(process.exitCode).toBe(1);
  });
});
