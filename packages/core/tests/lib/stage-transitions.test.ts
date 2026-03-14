import { describe, expect, it } from 'vitest';

import {
  BLOCKED_LABEL,
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
import {
  resolveTransition,
  type LabelTransition,
  type StageName,
  type Verdict,
} from '../../src/lib/stage-transitions.js';

interface TransitionCase {
  stage: StageName;
  verdict: Verdict;
  expected: LabelTransition;
}

const CASES: TransitionCase[] = [
  {
    stage: 'design',
    verdict: 'accept',
    expected: { add: [DESIGNED_LABEL], remove: [GROOMED_LABEL] },
  },
  {
    stage: 'design',
    verdict: 'reject',
    expected: { add: [NEW_LABEL], remove: [GROOMED_LABEL] },
  },
  {
    stage: 'design',
    verdict: 'fail',
    expected: { add: [FAILED_LABEL], remove: [GROOMED_LABEL] },
  },
  {
    stage: 'plan',
    verdict: 'accept',
    expected: { add: [PLANNED_LABEL], remove: [DESIGNED_LABEL] },
  },
  {
    stage: 'plan',
    verdict: 'reject',
    expected: { add: [GROOMED_LABEL], remove: [DESIGNED_LABEL] },
  },
  {
    stage: 'plan',
    verdict: 'fail',
    expected: { add: [FAILED_LABEL], remove: [DESIGNED_LABEL] },
  },
  {
    stage: 'implement',
    verdict: 'accept',
    expected: { add: [IMPLEMENTED_LABEL], remove: [PLANNED_LABEL] },
  },
  {
    stage: 'implement',
    verdict: 'reject',
    expected: { add: [DESIGNED_LABEL], remove: [PLANNED_LABEL] },
  },
  {
    stage: 'implement',
    verdict: 'fail',
    expected: { add: [FAILED_LABEL], remove: [PLANNED_LABEL] },
  },
  {
    stage: 'pr_open',
    verdict: 'accept',
    expected: { add: [PR_OPEN_LABEL], remove: [IMPLEMENTED_LABEL] },
  },
  {
    stage: 'pr_open',
    verdict: 'reject',
    expected: { add: [PLANNED_LABEL], remove: [IMPLEMENTED_LABEL] },
  },
  {
    stage: 'pr_open',
    verdict: 'fail',
    expected: { add: [FAILED_LABEL], remove: [IMPLEMENTED_LABEL] },
  },
  {
    stage: 'pr_review',
    verdict: 'accept',
    expected: { add: [PR_REVIEWED_LABEL], remove: [PR_OPEN_LABEL] },
  },
  {
    stage: 'pr_review',
    verdict: 'reject',
    expected: { add: [IMPLEMENTED_LABEL], remove: [PR_OPEN_LABEL] },
  },
  {
    stage: 'pr_review',
    verdict: 'fail',
    expected: { add: [FAILED_LABEL], remove: [PR_OPEN_LABEL] },
  },
  {
    stage: 'pr_remediate',
    verdict: 'accept',
    expected: { add: [READY_LABEL], remove: [PR_REVIEWED_LABEL] },
  },
  {
    stage: 'pr_remediate',
    verdict: 'reject',
    expected: { add: [PR_OPEN_LABEL], remove: [PR_REVIEWED_LABEL] },
  },
  {
    stage: 'pr_remediate',
    verdict: 'fail',
    expected: { add: [FAILED_LABEL], remove: [PR_REVIEWED_LABEL] },
  },
  {
    stage: 'unblock',
    verdict: 'accept',
    expected: { add: [], remove: [BLOCKED_LABEL] },
  },
  {
    stage: 'unblock',
    verdict: 'reject',
    expected: { add: [], remove: [] },
  },
  {
    stage: 'unblock',
    verdict: 'fail',
    expected: { add: [FAILED_LABEL], remove: [] },
  },
];

describe('resolveTransition', () => {
  it.each(CASES)('returns the expected transition for $stage / $verdict', (testCase) => {
    expect(resolveTransition(testCase.stage, testCase.verdict)).toEqual(testCase.expected);
  });

  it('throws on an unknown stage', () => {
    expect(() => resolveTransition('unknown' as StageName, 'accept')).toThrow(
      'Unknown stage: unknown'
    );
  });
});
