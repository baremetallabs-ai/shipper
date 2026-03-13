import {
  gh,
  STAGE_LABEL_NAMES,
  DISPLAY_NAME_MAP,
  CONTROL_LABEL_NAMES,
} from '@dnsquared/shipper-core';

const VALID_SHORT_NAMES = STAGE_LABEL_NAMES.map((label) => label.replace('shipper:', ''));

interface Issue {
  number: number;
  title: string;
  labels: { name: string }[];
}

export async function issueListCommand(options: { status?: string }): Promise<void> {
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
    const { stdout: output } = await gh([
      'issue',
      'list',
      '--state',
      'open',
      '--search',
      `label:${STAGE_LABEL_NAMES.join(',')}`,
      '--limit',
      '1000',
      '--json',
      'number,title,labels',
    ]);
    issues = JSON.parse(output) as Issue[];
  } catch {
    console.error('Error: Failed to fetch issues.');
    process.exit(1);
  }

  // Group issues by their most-advanced status label
  const groups = new Map<string, Issue[]>();
  for (const label of STAGE_LABEL_NAMES) {
    groups.set(label, []);
  }

  for (const issue of issues) {
    const issueLabels = issue.labels.map((l) => l.name);
    const bestIndex = STAGE_LABEL_NAMES.findLastIndex((label) => issueLabels.includes(label));
    if (bestIndex >= 0) {
      const label = STAGE_LABEL_NAMES[bestIndex];
      if (label) {
        groups.get(label)?.push(issue);
      }
    }
  }

  // Sort each group by issue number ascending
  for (const group of groups.values()) {
    group.sort((a, b) => a.number - b.number);
  }

  // Determine which labels to display
  const labelsToShow = options.status ? [`shipper:${options.status}`] : [...STAGE_LABEL_NAMES];

  let hasOutput = false;
  for (const label of labelsToShow) {
    const group = groups.get(label);
    if (!group || group.length === 0) continue;

    hasOutput = true;
    console.log(`\n${DISPLAY_NAME_MAP[label]} (${group.length})`);

    for (const issue of group) {
      const issueLabels = issue.labels.map((l) => l.name);
      let suffixes = '';
      for (const controlLabel of CONTROL_LABEL_NAMES) {
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
