import { describe, expect, it } from 'vitest';

import {
  getCurrentStage,
  getStageIndex,
  getStageLabel,
  getValidTargets,
  parseStage,
} from '../../src/lib/reset.js';

describe('reset helpers', () => {
  it('parses both bare stage names and shipper-prefixed stage labels', () => {
    expect(parseStage('new')).toBe('new');
    expect(parseStage('shipper:groomed')).toBe('groomed');
    expect(parseStage('shipper:implemented')).toBe('implemented');
  });

  it('rejects non-resettable and invalid stage names', () => {
    expect(parseStage('shipper:blocked')).toBeNull();
    expect(parseStage('ready')).toBeNull();
    expect(parseStage('banana')).toBeNull();
  });

  it('returns canonical workflow labels for reset stages', () => {
    expect(getStageLabel('new')).toBe('shipper:new');
    expect(getStageLabel('planned')).toBe('shipper:planned');
    expect(getStageLabel('implemented')).toBe('shipper:implemented');
  });

  it('keeps reset stage ordering stable', () => {
    expect(getStageIndex('new')).toBe(0);
    expect(getStageIndex('groomed')).toBe(1);
    expect(getStageIndex('designed')).toBe(2);
    expect(getStageIndex('planned')).toBe(3);
    expect(getStageIndex('implemented')).toBe(4);
  });

  it('detects the current workflow stage from stage labels', () => {
    expect(getCurrentStage(['shipper:new'])).toEqual({
      stage: 'new',
      hasPrLabels: false,
    });
    expect(getCurrentStage(['shipper:new', 'shipper:groomed', 'shipper:planned'])).toEqual({
      stage: 'planned',
      hasPrLabels: false,
    });
  });

  it('maps PR-stage labels back to implemented for reset targeting', () => {
    expect(getCurrentStage(['shipper:planned', 'shipper:pr-open'])).toEqual({
      stage: 'implemented',
      hasPrLabels: true,
    });
    expect(getCurrentStage(['shipper:implemented', 'shipper:ready'])).toEqual({
      stage: 'implemented',
      hasPrLabels: true,
    });
  });

  it('lists only earlier reset targets for normal workflow stages', () => {
    expect(getValidTargets({ stage: 'groomed', hasPrLabels: false })).toEqual(['new']);
    expect(getValidTargets({ stage: 'planned', hasPrLabels: false })).toEqual([
      'new',
      'groomed',
      'designed',
    ]);
  });

  it('includes implemented as a valid target for PR-stage issues', () => {
    expect(getValidTargets({ stage: 'implemented', hasPrLabels: true })).toEqual([
      'new',
      'groomed',
      'designed',
      'planned',
      'implemented',
    ]);
  });
});
