import { describe, it, expect } from 'vitest';
import { STAGE_NAME } from '../../src/commands/ship.js';

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

  it('maps each label to a non-empty stage name', () => {
    for (const [label, stage] of Object.entries(STAGE_NAME)) {
      expect(stage, `stage name for ${label}`).toBeTruthy();
      expect(typeof stage).toBe('string');
    }
  });
});
