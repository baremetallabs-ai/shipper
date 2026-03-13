import { beforeEach, describe, expect, it, vi } from 'vitest';

type GhModule = typeof import('../../src/lib/gh.js');

const { mockGh } = vi.hoisted(() => ({
  mockGh: vi.fn<GhModule['gh']>(),
}));

vi.mock('../../src/lib/gh.js', () => ({
  gh: mockGh,
}));

const { checkLabels } = await import('../../src/lib/prerequisites.js');

beforeEach(() => {
  mockGh.mockReset();
});

describe('checkLabels', () => {
  it('fails when shipper:pr-reviewed is the only missing workflow label', async () => {
    mockGh.mockResolvedValue({
      stdout: [
        'shipper:new',
        'shipper:groomed',
        'shipper:designed',
        'shipper:planned',
        'shipper:implemented',
        'shipper:pr-open',
        'shipper:ready',
      ].join('\n'),
      stderr: '',
    });

    await expect(checkLabels()).resolves.toEqual({
      ok: false,
      message: 'Missing label(s): shipper:pr-reviewed',
    });
  });

  it('passes when all workflow labels exist', async () => {
    mockGh.mockResolvedValue({
      stdout: [
        'shipper:new',
        'shipper:groomed',
        'shipper:designed',
        'shipper:planned',
        'shipper:implemented',
        'shipper:pr-open',
        'shipper:pr-reviewed',
        'shipper:ready',
      ].join('\n'),
      stderr: '',
    });

    await expect(checkLabels()).resolves.toEqual({
      ok: true,
      message: 'All required labels exist',
    });
  });
});
