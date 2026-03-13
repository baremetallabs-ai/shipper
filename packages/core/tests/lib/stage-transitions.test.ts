import { describe, expect, it } from 'vitest';
import {
  DESIGNED_LABEL,
  FAILED_LABEL,
  GROOMED_LABEL,
  IMPLEMENTED_LABEL,
  NEW_LABEL,
  PLANNED_LABEL,
  PR_OPEN_LABEL,
  PR_REVIEWED_LABEL,
  READY_LABEL,
} from '../../src/lib/labels.js';
import { resolveTransition } from '../../src/lib/stage-transitions.js';

describe('resolveTransition', () => {
  it('maps every workflow stage verdict to the expected labels', () => {
    expect(resolveTransition('design', 'accept')).toEqual({
      add: [DESIGNED_LABEL],
      remove: [GROOMED_LABEL],
    });
    expect(resolveTransition('design', 'reject')).toEqual({
      add: [NEW_LABEL],
      remove: [GROOMED_LABEL],
    });
    expect(resolveTransition('design', 'fail')).toEqual({
      add: [FAILED_LABEL],
      remove: [GROOMED_LABEL],
    });

    expect(resolveTransition('plan', 'accept')).toEqual({
      add: [PLANNED_LABEL],
      remove: [DESIGNED_LABEL],
    });
    expect(resolveTransition('plan', 'reject')).toEqual({
      add: [GROOMED_LABEL],
      remove: [DESIGNED_LABEL],
    });
    expect(resolveTransition('plan', 'fail')).toEqual({
      add: [FAILED_LABEL],
      remove: [DESIGNED_LABEL],
    });

    expect(resolveTransition('implement', 'accept')).toEqual({
      add: [IMPLEMENTED_LABEL],
      remove: [PLANNED_LABEL],
    });
    expect(resolveTransition('implement', 'reject')).toEqual({
      add: [DESIGNED_LABEL],
      remove: [PLANNED_LABEL],
    });
    expect(resolveTransition('implement', 'fail')).toEqual({
      add: [FAILED_LABEL],
      remove: [PLANNED_LABEL],
    });

    expect(resolveTransition('pr_open', 'accept')).toEqual({
      add: [PR_OPEN_LABEL],
      remove: [IMPLEMENTED_LABEL],
    });
    expect(resolveTransition('pr_open', 'reject')).toEqual({
      add: [PLANNED_LABEL],
      remove: [IMPLEMENTED_LABEL],
    });
    expect(resolveTransition('pr_open', 'fail')).toEqual({
      add: [FAILED_LABEL],
      remove: [IMPLEMENTED_LABEL],
    });

    expect(resolveTransition('pr_review', 'accept')).toEqual({
      add: [PR_REVIEWED_LABEL],
      remove: [PR_OPEN_LABEL],
    });
    expect(resolveTransition('pr_review', 'reject')).toEqual({
      add: [IMPLEMENTED_LABEL],
      remove: [PR_OPEN_LABEL],
    });
    expect(resolveTransition('pr_review', 'fail')).toEqual({
      add: [FAILED_LABEL],
      remove: [PR_OPEN_LABEL],
    });

    expect(resolveTransition('pr_remediate', 'accept')).toEqual({
      add: [READY_LABEL],
      remove: [PR_REVIEWED_LABEL],
    });
    expect(resolveTransition('pr_remediate', 'reject')).toEqual({
      add: [PR_OPEN_LABEL],
      remove: [PR_REVIEWED_LABEL],
    });
    expect(resolveTransition('pr_remediate', 'fail')).toEqual({
      add: [FAILED_LABEL],
      remove: [PR_REVIEWED_LABEL],
    });
  });

  it('handles unblock verdicts as a special case', () => {
    expect(resolveTransition('unblock', 'accept', PLANNED_LABEL)).toEqual({
      add: [],
      remove: ['shipper:blocked'],
    });
    expect(resolveTransition('unblock', 'reject', PLANNED_LABEL)).toEqual({
      add: [],
      remove: [],
    });
    expect(resolveTransition('unblock', 'fail', PLANNED_LABEL)).toEqual({
      add: [FAILED_LABEL],
      remove: ['shipper:blocked', PLANNED_LABEL],
    });
  });
});
