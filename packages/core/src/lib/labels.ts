export interface LabelDefinition {
  name: string;
  color: string;
  description: string;
  kind: 'stage' | 'control';
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
];

export const WORKFLOW_LABELS = LABELS.filter((label) => label.kind === 'stage');
export const CONTROL_LABELS = LABELS.filter((label) => label.kind === 'control');

export const ALL_LABEL_NAMES = LABELS.map((label) => label.name);
export const STAGE_LABEL_NAMES = WORKFLOW_LABELS.map((label) => label.name);
export const CONTROL_LABEL_NAMES = CONTROL_LABELS.map((label) => label.name);

export const STAGE_NAME_MAP: Record<string, string> = Object.fromEntries(
  WORKFLOW_LABELS.map((label) => [label.name, label.stageName ?? label.displayName.toLowerCase()])
);

export const DISPLAY_NAME_MAP: Record<string, string> = Object.fromEntries(
  WORKFLOW_LABELS.map((label) => [label.name, label.displayName])
);

export const NEW_LABEL = LABELS[0]!.name;
export const GROOMED_LABEL = LABELS[1]!.name;
export const DESIGNED_LABEL = LABELS[2]!.name;
export const PLANNED_LABEL = LABELS[3]!.name;
export const IMPLEMENTED_LABEL = LABELS[4]!.name;
export const PR_OPEN_LABEL = LABELS[5]!.name;
export const PR_REVIEWED_LABEL = LABELS[6]!.name;
export const READY_LABEL = LABELS[7]!.name;
export const BLOCKED_LABEL = LABELS[8]!.name;
export const LOCKED_LABEL = LABELS[9]!.name;
