import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockReleaseIssueLock = vi.fn();

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
});

describe('unlockCommand', () => {
  it('calls releaseIssueLock with the issue number', () => {
    unlockCommand('42');
    expect(mockReleaseIssueLock).toHaveBeenCalledWith('42');
  });

  it('strips # prefix from issue number', () => {
    unlockCommand('#42');
    expect(mockReleaseIssueLock).toHaveBeenCalledWith('42');
  });

  it('exits with error when no issue provided', () => {
    expect(() => unlockCommand('')).toThrow('process.exit');
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
