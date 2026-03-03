import { describe, it, expect, vi, beforeEach } from 'vitest';
import { STAGE_NAME, AUTO_PRIORITY_LABELS, selectNextCandidate } from '../../src/commands/ship.js';

vi.mock('../../src/lib/github.js', () => ({
  getRepoNwo: vi.fn(() => 'owner/repo'),
  selectIssuesForStage: vi.fn(() => []),
}));

import { selectIssuesForStage } from '../../src/lib/github.js';

const mockSelectIssuesForStage = vi.mocked(selectIssuesForStage);

describe('STAGE_NAME', () => {
  it('contains all expected workflow labels', () => {
    const expectedLabels = [
      'shipper:new',
      'shipper:groomed',
      'shipper:designed',
      'shipper:planned',
      'shipper:implemented',
      'shipper:pr-open',
      'shipper:pr-reviewed',
    ];

    expect(Object.keys(STAGE_NAME).sort()).toEqual(expectedLabels.sort());
  });

  it('does not include shipper:ready (terminal state)', () => {
    expect(STAGE_NAME).not.toHaveProperty('shipper:ready');
  });

  it('does not include shipper:blocked (orthogonal modifier, not a stage)', () => {
    expect(STAGE_NAME).not.toHaveProperty('shipper:blocked');
  });

  it('maps each label to a non-empty stage name', () => {
    for (const [label, stage] of Object.entries(STAGE_NAME)) {
      expect(stage, `stage name for ${label}`).toBeTruthy();
      expect(typeof stage).toBe('string');
    }
  });
});

describe('AUTO_PRIORITY_LABELS', () => {
  it('contains all 8 expected labels in priority order', () => {
    expect(AUTO_PRIORITY_LABELS).toEqual([
      'shipper:ready',
      'shipper:pr-reviewed',
      'shipper:pr-open',
      'shipper:implemented',
      'shipper:planned',
      'shipper:designed',
      'shipper:groomed',
      'shipper:new',
    ]);
  });

  it('has shipper:ready as the highest priority', () => {
    expect(AUTO_PRIORITY_LABELS[0]).toBe('shipper:ready');
  });

  it('has shipper:new as the lowest priority', () => {
    expect(AUTO_PRIORITY_LABELS[AUTO_PRIORITY_LABELS.length - 1]).toBe('shipper:new');
  });
});

describe('selectNextCandidate', () => {
  beforeEach(() => {
    mockSelectIssuesForStage.mockReset();
    mockSelectIssuesForStage.mockReturnValue([]);
  });

  it('returns the issue from the highest-priority label', () => {
    mockSelectIssuesForStage.mockImplementation((label: string) => {
      if (label === 'shipper:ready') return [];
      if (label === 'shipper:pr-reviewed') return [];
      if (label === 'shipper:pr-open') return [{ number: 10, title: 'PR open issue' }];
      if (label === 'shipper:groomed') return [{ number: 20, title: 'Groomed issue' }];
      return [];
    });

    const result = selectNextCandidate(new Set());
    expect(result).toEqual({ number: 10, title: 'PR open issue' });
  });

  it('skips issues in the skippedIssues set', () => {
    mockSelectIssuesForStage.mockImplementation((label: string) => {
      if (label === 'shipper:pr-open')
        return [
          { number: 10, title: 'Skipped issue' },
          { number: 11, title: 'Next issue' },
        ];
      return [];
    });

    const result = selectNextCandidate(new Set([10]));
    expect(result).toEqual({ number: 11, title: 'Next issue' });
  });

  it('returns null when no candidates remain', () => {
    mockSelectIssuesForStage.mockReturnValue([]);

    const result = selectNextCandidate(new Set());
    expect(result).toBeNull();
  });

  it('returns null when all candidates are skipped', () => {
    mockSelectIssuesForStage.mockImplementation((label: string) => {
      if (label === 'shipper:planned') return [{ number: 5, title: 'Only issue' }];
      return [];
    });

    const result = selectNextCandidate(new Set([5]));
    expect(result).toBeNull();
  });

  it('returns the first issue within a label (already sorted by time-in-state)', () => {
    mockSelectIssuesForStage.mockImplementation((label: string) => {
      if (label === 'shipper:groomed')
        return [
          { number: 1, title: 'Oldest' },
          { number: 2, title: 'Newer' },
        ];
      return [];
    });

    const result = selectNextCandidate(new Set());
    expect(result).toEqual({ number: 1, title: 'Oldest' });
  });
});
