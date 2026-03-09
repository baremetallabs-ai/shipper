import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockReleaseIssueLock = vi.fn();
const repo = 'owner/repo';

vi.mock('@dnsquared/shipper-core', () => ({
  releaseIssueLock: (...args: unknown[]) => mockReleaseIssueLock(...args),
}));

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
  throw new Error('process.exit');
}) as never);
vi.spyOn(console, 'error').mockImplementation(() => {});

import { unlockCommand } from '../../src/commands/unlock.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockReleaseIssueLock.mockResolvedValue(undefined);
});

describe('unlockCommand', () => {
  it('calls releaseIssueLock with the repo and issue number', async () => {
    await unlockCommand(repo, '42');
    expect(mockReleaseIssueLock).toHaveBeenCalledWith(repo, '42');
  });

  it('strips # prefix from issue number', async () => {
    await unlockCommand(repo, '#42');
    expect(mockReleaseIssueLock).toHaveBeenCalledWith(repo, '42');
  });

  it('exits with error when no issue provided', async () => {
    await expect(unlockCommand(repo, '')).rejects.toThrow('process.exit');
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
