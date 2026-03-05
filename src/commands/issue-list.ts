import { execFileSync } from 'node:child_process';

const STATUS_LABELS = [
  'shipper:new',
  'shipper:groomed',
  'shipper:designed',
  'shipper:planned',
  'shipper:implemented',
  'shipper:pr-open',
  'shipper:pr-reviewed',
  'shipper:ready',
] as const;

const DISPLAY_NAMES: Record<string, string> = {
  'shipper:new': 'New',
  'shipper:groomed': 'Groomed',
  'shipper:designed': 'Designed',
  'shipper:planned': 'Planned',
  'shipper:implemented': 'Implemented',
  'shipper:pr-open': 'PR Open',
  'shipper:pr-reviewed': 'PR Reviewed',
  'shipper:ready': 'Ready',
};

const CONTROL_LABELS = ['shipper:blocked', 'shipper:locked'] as const;

const VALID_SHORT_NAMES = STATUS_LABELS.map((l) => l.replace('shipper:', ''));

interface Issue {
  number: number;
  title: string;
  labels: { name: string }[];
}

export function issueListCommand(options: { status?: string }): void {
  if (options.status) {
    if (!VALID_SHORT_NAMES.includes(options.status)) {
      console.error(
        `Error: Invalid status '${options.status}'. Valid values: ${VALID_SHORT_NAMES.join(', ')}`
      );
      process.exit(1);
    }
  }

  let issues: Issue[];
  try {
    const output = execFileSync(
      'gh',
      [
        'issue',
        'list',
        '--state',
        'open',
        '--search',
        'label:shipper:new,shipper:groomed,shipper:designed,shipper:planned,shipper:implemented,shipper:pr-open,shipper:pr-reviewed,shipper:ready',
        '--limit',
        '1000',
        '--json',
        'number,title,labels',
      ],
      { encoding: 'utf-8' }
    );
    issues = JSON.parse(output) as Issue[];
  } catch {
    console.error('Error: Failed to fetch issues.');
    process.exit(1);
  }

  // Group issues by their most-advanced status label
  const groups = new Map<string, Issue[]>();
  for (const label of STATUS_LABELS) {
    groups.set(label, []);
  }

  for (const issue of issues) {
    const issueLabels = issue.labels.map((l) => l.name);
    let bestIndex = -1;
    for (let i = 0; i < STATUS_LABELS.length; i++) {
      if (issueLabels.includes(STATUS_LABELS[i]!)) {
        bestIndex = i;
      }
    }
    if (bestIndex >= 0) {
      groups.get(STATUS_LABELS[bestIndex]!)!.push(issue);
    }
  }

  // Sort each group by issue number ascending
  for (const group of groups.values()) {
    group.sort((a, b) => a.number - b.number);
  }

  // Determine which labels to display
  const labelsToShow = options.status ? [`shipper:${options.status}`] : [...STATUS_LABELS];

  let hasOutput = false;
  for (const label of labelsToShow) {
    const group = groups.get(label);
    if (!group || group.length === 0) continue;

    hasOutput = true;
    console.log(`\n${DISPLAY_NAMES[label]} (${group.length})`);

    for (const issue of group) {
      const issueLabels = issue.labels.map((l) => l.name);
      let suffixes = '';
      for (const controlLabel of CONTROL_LABELS) {
        if (issueLabels.includes(controlLabel)) {
          suffixes += ` [${controlLabel.replace('shipper:', '')}]`;
        }
      }
      console.log(`  #${issue.number} ${issue.title}${suffixes}`);
    }
  }

  if (!hasOutput) {
    console.log('No shipper-managed issues found.');
  }
}
