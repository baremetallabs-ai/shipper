import { describe, expect, it } from 'vitest';

import {
  LABELS,
  WORKFLOW_LABELS,
  CONTROL_LABELS,
  STAGE_LABEL_NAMES,
  STAGE_NAME_MAP,
} from '../../src/lib/labels.js';

describe('labels', () => {
  it('defines the canonical set of 10 labels', () => {
    expect(LABELS).toHaveLength(10);
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
    ]);
  });

  it('splits workflow and control labels correctly', () => {
    expect(WORKFLOW_LABELS).toHaveLength(8);
    expect(CONTROL_LABELS).toHaveLength(2);
    expect(CONTROL_LABELS.map((label) => label.name)).toEqual([
      'shipper:blocked',
      'shipper:locked',
    ]);
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
});
