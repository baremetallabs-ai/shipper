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
import type { Verdict } from './result-schema.js';

export type WorkflowStage =
  | 'design'
  | 'plan'
  | 'implement'
  | 'pr_open'
  | 'pr_review'
  | 'pr_remediate';
export type StageName = WorkflowStage | 'unblock';

export interface StageConfig {
  runningAt: string;
  acceptLabel: string;
  rejectLabel: string;
}

export interface LabelTransition {
  add: string[];
  remove: string[];
}

export const STAGE_CONFIGS: Record<WorkflowStage, StageConfig> = {
  design: {
    runningAt: GROOMED_LABEL,
    acceptLabel: DESIGNED_LABEL,
    rejectLabel: NEW_LABEL,
  },
  plan: {
    runningAt: DESIGNED_LABEL,
    acceptLabel: PLANNED_LABEL,
    rejectLabel: GROOMED_LABEL,
  },
  implement: {
    runningAt: PLANNED_LABEL,
    acceptLabel: IMPLEMENTED_LABEL,
    rejectLabel: DESIGNED_LABEL,
  },
  pr_open: {
    runningAt: IMPLEMENTED_LABEL,
    acceptLabel: PR_OPEN_LABEL,
    rejectLabel: PLANNED_LABEL,
  },
  pr_review: {
    runningAt: PR_OPEN_LABEL,
    acceptLabel: PR_REVIEWED_LABEL,
    rejectLabel: IMPLEMENTED_LABEL,
  },
  pr_remediate: {
    runningAt: PR_REVIEWED_LABEL,
    acceptLabel: READY_LABEL,
    rejectLabel: PR_OPEN_LABEL,
  },
};

function resolveWorkflowTransition(config: StageConfig, verdict: Verdict): LabelTransition {
  if (verdict === 'accept') {
    return { add: [config.acceptLabel], remove: [config.runningAt] };
  }

  if (verdict === 'reject') {
    return { add: [config.rejectLabel], remove: [config.runningAt] };
  }

  return { add: [FAILED_LABEL], remove: [config.runningAt] };
}

export function resolveTransition(
  stage: StageName,
  verdict: Verdict,
  currentWorkflowLabel?: string
): LabelTransition {
  if (stage === 'unblock') {
    if (verdict === 'accept') {
      return { add: [], remove: [BLOCKED_LABEL] };
    }

    if (verdict === 'reject') {
      return { add: [], remove: [] };
    }

    const remove = [BLOCKED_LABEL];
    if (currentWorkflowLabel) {
      remove.push(currentWorkflowLabel);
    }

    return { add: [FAILED_LABEL], remove };
  }

  const config = STAGE_CONFIGS[stage];
  return resolveWorkflowTransition(config, verdict);
}
