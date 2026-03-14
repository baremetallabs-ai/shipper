export interface LabelDefinition {
  name: string;
  color: string;
  description: string;
  kind: 'stage' | 'control' | 'priority';
  displayName: string;
  stageName?: string;
}

export const LABELS: readonly LabelDefinition[] = [
  {
    name: 'shipper:new',
    color: 'C2E0C6',
    description: 'New issue from shipper',
    kind: 'stage',
    displayName: 'New',
    stageName: 'groom',
  },
  {
    name: 'shipper:groomed',
    color: 'BFD4F2',
    description: 'Product-groomed',
    kind: 'stage',
    displayName: 'Groomed',
    stageName: 'design',
  },
  {
    name: 'shipper:designed',
    color: 'D4C5F9',
    description: 'Design-reviewed',
    kind: 'stage',
    displayName: 'Designed',
    stageName: 'plan',
  },
  {
    name: 'shipper:planned',
    color: 'FEF2C0',
    description: 'Implementation planned',
    kind: 'stage',
    displayName: 'Planned',
    stageName: 'implement',
  },
  {
    name: 'shipper:implemented',
    color: 'FBCA04',
    description: 'Implementation complete',
    kind: 'stage',
    displayName: 'Implemented',
    stageName: 'pr open',
  },
  {
    name: 'shipper:pr-open',
    color: 'F9D0C4',
    description: 'PR opened',
    kind: 'stage',
    displayName: 'PR Open',
    stageName: 'pr review',
  },
  {
    name: 'shipper:pr-reviewed',
    color: 'E6B8AF',
    description: 'PR reviewed, pending remediation',
    kind: 'stage',
    displayName: 'PR Reviewed',
    stageName: 'pr remediate',
  },
  {
    name: 'shipper:ready',
    color: '0E8A16',
    description: 'Ready for final review and merge',
    kind: 'stage',
    displayName: 'Ready',
    stageName: 'ready',
  },
  {
    name: 'shipper:blocked',
    color: 'E11D48',
    description: 'Blocked by a dependency — run shipper unblock',
    kind: 'control',
    displayName: 'Blocked',
  },
  {
    name: 'shipper:locked',
    color: 'D93F0B',
    description: 'Locked by an active shipper instance',
    kind: 'control',
    displayName: 'Locked',
  },
  {
    name: 'shipper:failed',
    color: 'B60205',
    description: 'Automated processing failed — requires investigation',
    kind: 'control',
    displayName: 'Failed',
  },
  {
    name: 'shipper:priority-high',
    color: 'D93F0B',
    description: 'High-priority issue',
    kind: 'priority',
    displayName: 'High Priority',
  },
  {
    name: 'shipper:priority-low',
    color: '0E8A16',
    description: 'Low-priority issue',
    kind: 'priority',
    displayName: 'Low Priority',
  },
];

export const WORKFLOW_LABELS = LABELS.filter((label) => label.kind === 'stage');
export const CONTROL_LABELS = LABELS.filter((label) => label.kind === 'control');
export const PRIORITY_LABELS = LABELS.filter((label) => label.kind === 'priority');

export const ALL_LABEL_NAMES = LABELS.map((label) => label.name);
export const STAGE_LABEL_NAMES = WORKFLOW_LABELS.map((label) => label.name);
export const CONTROL_LABEL_NAMES = CONTROL_LABELS.map((label) => label.name);
export const PRIORITY_LABEL_NAMES = PRIORITY_LABELS.map((label) => label.name);

export const STAGE_NAME_MAP: Record<string, string> = Object.fromEntries(
  WORKFLOW_LABELS.map((label) => [label.name, label.stageName ?? label.displayName.toLowerCase()])
);

export const DISPLAY_NAME_MAP: Record<string, string> = Object.fromEntries(
  WORKFLOW_LABELS.map((label) => [label.name, label.displayName])
);

function requireLabelName(name: string): string {
  const label = LABELS.find((candidate) => candidate.name === name);
  if (!label) {
    throw new Error(`Missing label definition for ${name}`);
  }

  return label.name;
}

export const NEW_LABEL = requireLabelName('shipper:new');
export const GROOMED_LABEL = requireLabelName('shipper:groomed');
export const DESIGNED_LABEL = requireLabelName('shipper:designed');
export const PLANNED_LABEL = requireLabelName('shipper:planned');
export const IMPLEMENTED_LABEL = requireLabelName('shipper:implemented');
export const PR_OPEN_LABEL = requireLabelName('shipper:pr-open');
export const PR_REVIEWED_LABEL = requireLabelName('shipper:pr-reviewed');
export const READY_LABEL = requireLabelName('shipper:ready');
export const BLOCKED_LABEL = requireLabelName('shipper:blocked');
export const LOCKED_LABEL = requireLabelName('shipper:locked');
export const FAILED_LABEL = requireLabelName('shipper:failed');
export const PRIORITY_HIGH_LABEL = requireLabelName('shipper:priority-high');
export const PRIORITY_LOW_LABEL = requireLabelName('shipper:priority-low');

export function getPriorityTier(labels: string[]): 0 | 1 | 2 {
  if (labels.includes(PRIORITY_HIGH_LABEL)) {
    return 0;
  }

  if (labels.includes(PRIORITY_LOW_LABEL)) {
    return 2;
  }

  return 1;
}
