import { describe, it, expect, vi, beforeEach } from 'vitest';

type ShipperCore = typeof import('@dnsquared/shipper-core');

const { mockListIssues, mockIsLockStale, mockReleaseIssueLock } = vi.hoisted(() => ({
  mockListIssues: vi.fn<ShipperCore['listIssues']>(),
  mockIsLockStale: vi.fn<ShipperCore['isLockStale']>(),
  mockReleaseIssueLock: vi.fn<ShipperCore['releaseIssueLock']>(),
}));
const repo = 'owner/repo';

vi.mock('@dnsquared/shipper-core', () => ({
  listIssues: mockListIssues,
  isLockStale: mockIsLockStale,
  releaseIssueLock: mockReleaseIssueLock,
}));

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
  throw new Error('process.exit');
}) as never);
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

import { unlockCommand } from '../../src/commands/unlock.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockListIssues.mockResolvedValue([]);
  mockIsLockStale.mockResolvedValue(false);
  mockReleaseIssueLock.mockResolvedValue(undefined);
});

describe('unlockCommand', () => {
  it('calls releaseIssueLock with the repo and issue number', async () => {
    await unlockCommand(repo, '42', { stale: false });
    expect(mockReleaseIssueLock).toHaveBeenCalledWith(repo, '42');
    expect(mockListIssues).not.toHaveBeenCalled();
    expect(mockIsLockStale).not.toHaveBeenCalled();
  });

  it('strips # prefix from issue number', async () => {
    await unlockCommand(repo, '#42', { stale: false });
    expect(mockReleaseIssueLock).toHaveBeenCalledWith(repo, '42');
    expect(mockListIssues).not.toHaveBeenCalled();
    expect(mockIsLockStale).not.toHaveBeenCalled();
  });

  it('exits with usage error when no issue and no --stale are provided', async () => {
    await expect(unlockCommand(repo, undefined, { stale: false })).rejects.toThrow('process.exit');
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockConsoleError).toHaveBeenNthCalledWith(
      1,
      'Error: Please provide an issue number or use --stale.'
    );
    expect(mockConsoleError).toHaveBeenNthCalledWith(2, 'Usage: shipper unlock <issue>');
    expect(mockConsoleError).toHaveBeenNthCalledWith(3, '   or: shipper unlock --stale');
    expect(mockListIssues).not.toHaveBeenCalled();
    expect(mockIsLockStale).not.toHaveBeenCalled();
    expect(mockReleaseIssueLock).not.toHaveBeenCalled();
  });

  it('exits with error when an issue and --stale are both provided', async () => {
    await expect(unlockCommand(repo, '42', { stale: true })).rejects.toThrow('process.exit');
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockConsoleError).toHaveBeenNthCalledWith(
      1,
      'Error: --stale cannot be used with an issue number.'
    );
    expect(mockConsoleError).toHaveBeenNthCalledWith(2, 'Usage: shipper unlock <issue>');
    expect(mockConsoleError).toHaveBeenNthCalledWith(3, '   or: shipper unlock --stale');
    expect(mockListIssues).not.toHaveBeenCalled();
    expect(mockIsLockStale).not.toHaveBeenCalled();
    expect(mockReleaseIssueLock).not.toHaveBeenCalled();
  });

  it('prints no-op output when no locked issues are found for --stale', async () => {
    mockListIssues.mockResolvedValue([]);

    await expect(unlockCommand(repo, undefined, { stale: true })).resolves.toBeUndefined();

    expect(mockListIssues).toHaveBeenCalledWith(repo, { label: 'shipper:locked' });
    expect(mockIsLockStale).not.toHaveBeenCalled();
    expect(mockReleaseIssueLock).not.toHaveBeenCalled();
    expect(mockConsoleError).toHaveBeenCalledTimes(1);
    expect(mockConsoleError).toHaveBeenCalledWith('No stale locks found.');
  });

  it('releases only stale locks and prints ordered per-issue status plus summary', async () => {
    mockListIssues.mockResolvedValue([{ number: 42 }, { number: 43 }]);
    mockIsLockStale.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(unlockCommand(repo, undefined, { stale: true })).resolves.toBeUndefined();

    expect(mockListIssues).toHaveBeenCalledWith(repo, { label: 'shipper:locked' });
    expect(mockIsLockStale).toHaveBeenNthCalledWith(1, repo, '42');
    expect(mockIsLockStale).toHaveBeenNthCalledWith(2, repo, '43');
    expect(mockReleaseIssueLock).toHaveBeenCalledTimes(1);
    expect(mockReleaseIssueLock).toHaveBeenCalledWith(repo, '42');
    expect(mockConsoleError).toHaveBeenNthCalledWith(1, '#42: stale — released');
    expect(mockConsoleError).toHaveBeenNthCalledWith(2, '#43: active — skipped');
    expect(mockConsoleError).toHaveBeenNthCalledWith(
      3,
      'Released 1 stale lock(s) (1 active lock(s) skipped).'
    );
  });

  it('prints active lines and no stale summary when all locked issues are active', async () => {
    mockListIssues.mockResolvedValue([{ number: 42 }, { number: 43 }]);
    mockIsLockStale.mockResolvedValue(false);

    await expect(unlockCommand(repo, undefined, { stale: true })).resolves.toBeUndefined();

    expect(mockIsLockStale).toHaveBeenNthCalledWith(1, repo, '42');
    expect(mockIsLockStale).toHaveBeenNthCalledWith(2, repo, '43');
    expect(mockReleaseIssueLock).not.toHaveBeenCalled();
    expect(mockConsoleError).toHaveBeenNthCalledWith(1, '#42: active — skipped');
    expect(mockConsoleError).toHaveBeenNthCalledWith(2, '#43: active — skipped');
    expect(mockConsoleError).toHaveBeenNthCalledWith(3, 'No stale locks found.');
    expect(mockConsoleError).not.toHaveBeenCalledWith(
      'Released 0 stale lock(s) (2 active lock(s) skipped).'
    );
  });
});
