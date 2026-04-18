export { toError, toErrorMessage } from './lib/errors.js';
export { isPlainObject } from './lib/type-guards.js';
export {
  LABELS,
  WORKFLOW_LABELS,
  CONTROL_LABELS,
  PRIORITY_LABELS,
  ALL_LABEL_NAMES,
  STAGE_LABEL_NAMES,
  CONTROL_LABEL_NAMES,
  PRIORITY_LABEL_NAMES,
  STAGE_NAME_MAP,
  DISPLAY_NAME_MAP,
  NEW_LABEL,
  GROOMED_LABEL,
  DESIGNED_LABEL,
  PLANNED_LABEL,
  IMPLEMENTED_LABEL,
  PR_OPEN_LABEL,
  PR_REVIEWED_LABEL,
  READY_LABEL,
  BLOCKED_LABEL,
  LOCKED_LABEL,
  FAILED_LABEL,
  PRIORITY_HIGH_LABEL,
  PRIORITY_LOW_LABEL,
  getPriorityTier,
  type LabelDefinition,
} from './lib/labels.js';

export interface ListIssueItem {
  number: number;
  title: string;
  labels: string[];
  state: string;
  author: string;
  createdAt: string;
  url: string;
}

export type WorkflowStage = 'new' | 'groomed' | 'designed' | 'planned' | 'implemented';
