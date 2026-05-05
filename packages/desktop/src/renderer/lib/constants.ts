import {
  DESIGNED_LABEL,
  GROOMED_LABEL,
  IMPLEMENTED_LABEL,
  NEW_LABEL,
  PLANNED_LABEL,
  PR_OPEN_LABEL,
  PR_REVIEWED_LABEL,
  READY_LABEL,
  type WorkflowStage,
} from '@baremetallabs-ai/shipper-core';

export const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export const PIPELINE_COLUMNS = [
  GROOMED_LABEL,
  DESIGNED_LABEL,
  PLANNED_LABEL,
  IMPLEMENTED_LABEL,
  PR_OPEN_LABEL,
  PR_REVIEWED_LABEL,
  READY_LABEL,
] as const;

export const RESET_STAGE_ORDER: ReadonlyArray<{ stage: WorkflowStage; label: string }> = [
  { stage: 'new', label: NEW_LABEL },
  { stage: 'groomed', label: GROOMED_LABEL },
  { stage: 'designed', label: DESIGNED_LABEL },
  { stage: 'planned', label: PLANNED_LABEL },
  { stage: 'implemented', label: IMPLEMENTED_LABEL },
];

export const RESET_STAGE_LABELS: Record<WorkflowStage, string> = Object.fromEntries(
  RESET_STAGE_ORDER.map(({ stage, label }) => [stage, label])
) as Record<WorkflowStage, string>;

export const POST_IMPLEMENTATION_LABELS = [PR_OPEN_LABEL, PR_REVIEWED_LABEL, READY_LABEL] as const;

export const MAX_AUTO_SHIP_CONSECUTIVE_FAILURES = 3;

export const AUTO_SHIP_PRIORITY_LABELS = [
  PR_REVIEWED_LABEL,
  PR_OPEN_LABEL,
  IMPLEMENTED_LABEL,
  PLANNED_LABEL,
  DESIGNED_LABEL,
  GROOMED_LABEL,
] as const;

export type PipelineColumnLabel = (typeof PIPELINE_COLUMNS)[number];

export const COLUMN_RESET_STAGE: Partial<Record<PipelineColumnLabel, WorkflowStage>> = {
  [GROOMED_LABEL]: 'groomed',
  [DESIGNED_LABEL]: 'designed',
  [PLANNED_LABEL]: 'planned',
  [IMPLEMENTED_LABEL]: 'implemented',
};
