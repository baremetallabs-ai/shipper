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
} from './labels.js';

export type StageName =
  | 'design'
  | 'plan'
  | 'implement'
  | 'pr_open'
  | 'pr_review'
  | 'pr_remediate'
  | 'groom'
  | 'unblock';

export type Verdict = 'accept' | 'reject' | 'fail';

export interface LabelTransition {
  add: string[];
  remove: string[];
}

interface StageTransitionEntry {
  runningAt: string;
  accept: string;
  reject: string;
}

export const STAGE_TRANSITIONS = {
  design: {
    runningAt: GROOMED_LABEL,
    accept: DESIGNED_LABEL,
    reject: NEW_LABEL,
  },
  plan: {
    runningAt: DESIGNED_LABEL,
    accept: PLANNED_LABEL,
    reject: GROOMED_LABEL,
  },
  implement: {
    runningAt: PLANNED_LABEL,
    accept: IMPLEMENTED_LABEL,
    reject: DESIGNED_LABEL,
  },
  pr_open: {
    runningAt: IMPLEMENTED_LABEL,
    accept: PR_OPEN_LABEL,
    reject: PLANNED_LABEL,
  },
  pr_review: {
    runningAt: PR_OPEN_LABEL,
    accept: PR_REVIEWED_LABEL,
    reject: IMPLEMENTED_LABEL,
  },
  pr_remediate: {
    runningAt: PR_REVIEWED_LABEL,
    accept: READY_LABEL,
    reject: PR_OPEN_LABEL,
  },
} as const satisfies Record<Exclude<StageName, 'unblock' | 'groom'>, StageTransitionEntry>;

export function resolveTransition(stage: StageName, verdict: Verdict): LabelTransition {
  if (stage === 'groom') {
    throw new Error('groom results must be processed with processGroomResult');
  }

  if (stage === 'unblock') {
    if (verdict === 'accept') {
      return { add: [], remove: [BLOCKED_LABEL] };
    }

    if (verdict === 'reject') {
      return { add: [], remove: [] };
    }

    return { add: [FAILED_LABEL], remove: [] };
  }

  if (!(stage in STAGE_TRANSITIONS)) {
    throw new Error(`Unknown stage: ${stage}`);
  }

  const entry = STAGE_TRANSITIONS[stage];

  if (verdict === 'accept') {
    return { add: [entry.accept], remove: [entry.runningAt] };
  }

  if (verdict === 'reject') {
    return { add: [entry.reject], remove: [entry.runningAt] };
  }

  return { add: [FAILED_LABEL], remove: [entry.runningAt] };
}
