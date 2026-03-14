import { describe, expect, it } from 'vitest';

import {
  LABELS,
  WORKFLOW_LABELS,
  CONTROL_LABELS,
  PRIORITY_LABELS,
  PRIORITY_LABEL_NAMES,
  STAGE_LABEL_NAMES,
  STAGE_NAME_MAP,
  getPriorityTier,
} from '../../src/lib/labels.js';

describe('labels', () => {
  it('defines the canonical set of 13 labels', () => {
    expect(LABELS).toHaveLength(13);
    expect(LABELS.map((label) => label.name)).toEqual([
      'shipper:new',
      'shipper:groomed',
      'shipper:designed',
      'shipper:planned',
      'shipper:implemented',
      'shipper:pr-open',
      'shipper:pr-reviewed',
      'shipper:ready',
      'shipper:blocked',
      'shipper:locked',
      'shipper:failed',
      'shipper:priority-high',
      'shipper:priority-low',
    ]);
  });

  it('splits workflow, control, and priority labels correctly', () => {
    expect(WORKFLOW_LABELS).toHaveLength(8);
    expect(CONTROL_LABELS).toHaveLength(3);
    expect(PRIORITY_LABELS).toHaveLength(2);
    expect(CONTROL_LABELS.map((label) => label.name)).toEqual([
      'shipper:blocked',
      'shipper:locked',
      'shipper:failed',
    ]);
    expect(PRIORITY_LABEL_NAMES).toEqual(['shipper:priority-high', 'shipper:priority-low']);
  });

  it('defines shipper:failed as a generalized control label', () => {
    const failedLabel = LABELS.find((label) => label.name === 'shipper:failed');

    expect(failedLabel).toMatchObject({
      kind: 'control',
      color: 'B60205',
      description: 'Automated processing failed — requires investigation',
    });
  });

  it('keeps workflow labels in stable stage order', () => {
    expect(STAGE_LABEL_NAMES).toEqual([
      'shipper:new',
      'shipper:groomed',
      'shipper:designed',
      'shipper:planned',
      'shipper:implemented',
      'shipper:pr-open',
      'shipper:pr-reviewed',
      'shipper:ready',
    ]);
  });

  it('includes shipper:pr-reviewed in the stage label list', () => {
    expect(STAGE_LABEL_NAMES).toContain('shipper:pr-reviewed');
  });

  it('includes shipper:ready in the stage name map', () => {
    expect(STAGE_NAME_MAP).toMatchObject({
      'shipper:ready': 'ready',
    });
  });

  it('treats unlabeled issues as normal priority', () => {
    expect(getPriorityTier(['shipper:new'])).toBe(1);
    expect(getPriorityTier(['shipper:new', 'shipper:priority-high'])).toBe(0);
    expect(getPriorityTier(['shipper:new', 'shipper:priority-low'])).toBe(2);
  });
});
