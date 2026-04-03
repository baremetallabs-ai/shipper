import {
  gh,
  logger,
  STAGE_LABEL_NAMES,
  DISPLAY_NAME_MAP,
  BLOCKED_LABEL,
  FAILED_LABEL,
  LOCKED_LABEL,
} from '@dnsquared/shipper-core';

const VALID_SHORT_NAMES = [
  ...STAGE_LABEL_NAMES.map((label) => label.replace('shipper:', '')),
  'blocked',
  'failed',
];

interface Issue {
  number: number;
  title: string;
  labels: { name: string }[];
}

interface ControlIssue {
  issue: Issue;
  stageLabel: string | undefined;
}

export async function issueListCommand(options: { status?: string }): Promise<void> {
  if (options.status) {
    if (!VALID_SHORT_NAMES.includes(options.status)) {
      throw new Error(
        `Error: Invalid status '${options.status}'. Valid values: ${VALID_SHORT_NAMES.join(', ')}`
      );
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
      `label:${[...STAGE_LABEL_NAMES, BLOCKED_LABEL, FAILED_LABEL].join(',')}`,
      '--limit',
      '1000',
      '--json',
      'number,title,labels',
    ]);
    issues = JSON.parse(output) as Issue[];
  } catch {
    throw new Error('Error: Failed to fetch issues.');
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
      if (!label) {
        throw new Error(`Invariant failed: missing stage label for index ${bestIndex}`);
      }

      const group = groups.get(label);
      if (!group) {
        throw new Error(`Invariant failed: missing issue group for label ${label}`);
      }

      group.push(issue);
    }
  }

  // Sort each group by issue number ascending
  for (const group of groups.values()) {
    group.sort((a, b) => a.number - b.number);
  }

  const blockedIssues: ControlIssue[] = [];
  const failedIssues: ControlIssue[] = [];

  for (const [label, group] of groups) {
    for (let index = group.length - 1; index >= 0; index -= 1) {
      const issue = group[index];
      if (!issue) {
        throw new Error(`Invariant failed: missing issue at index ${index}`);
      }

      const issueLabels = issue.labels.map((l) => l.name);
      const isFailed = issueLabels.includes(FAILED_LABEL);
      const isBlocked = issueLabels.includes(BLOCKED_LABEL);

      if (isFailed) {
        failedIssues.push({ issue, stageLabel: label });
        group.splice(index, 1);
      } else if (isBlocked) {
        blockedIssues.push({ issue, stageLabel: label });
        group.splice(index, 1);
      }
    }
  }

  for (const issue of issues) {
    const issueLabels = issue.labels.map((l) => l.name);
    const hasStageLabel = STAGE_LABEL_NAMES.some((label) => issueLabels.includes(label));
    if (hasStageLabel) continue;

    if (issueLabels.includes(FAILED_LABEL)) {
      failedIssues.push({ issue, stageLabel: undefined });
    } else if (issueLabels.includes(BLOCKED_LABEL)) {
      blockedIssues.push({ issue, stageLabel: undefined });
    }
  }

  blockedIssues.sort((a, b) => a.issue.number - b.issue.number);
  failedIssues.sort((a, b) => a.issue.number - b.issue.number);

  function renderControlSection(
    heading: string,
    items: ControlIssue[],
    stageFilter?: string
  ): boolean {
    const filteredItems = stageFilter
      ? items.filter((controlIssue) => controlIssue.stageLabel === stageFilter)
      : items;

    if (filteredItems.length === 0) {
      return false;
    }

    logger.log(`\n${heading} (${filteredItems.length})`);
    for (const { issue, stageLabel } of filteredItems) {
      const stageSuffix = stageLabel ? ` [${stageLabel.replace('shipper:', '')}]` : '';
      const lockedSuffix = issue.labels.some((label) => label.name === LOCKED_LABEL)
        ? ' [locked]'
        : '';
      logger.log(`  #${issue.number} ${issue.title}${stageSuffix}${lockedSuffix}`);
    }

    return true;
  }

  const isControlFilter = options.status === 'blocked' || options.status === 'failed';
  const stageFilter = options.status && !isControlFilter ? `shipper:${options.status}` : undefined;

  let hasOutput = false;
  if (!isControlFilter) {
    const labelsToShow = stageFilter ? [stageFilter] : [...STAGE_LABEL_NAMES];

    for (const label of labelsToShow) {
      const group = groups.get(label);
      if (!group || group.length === 0) {
        continue;
      }

      hasOutput = true;
      logger.log(`\n${DISPLAY_NAME_MAP[label]} (${group.length})`);

      for (const issue of group) {
        const lockedSuffix = issue.labels.some((label) => label.name === LOCKED_LABEL)
          ? ' [locked]'
          : '';
        logger.log(`  #${issue.number} ${issue.title}${lockedSuffix}`);
      }
    }
  }

  if (options.status !== 'failed') {
    hasOutput = renderControlSection('Blocked', blockedIssues, stageFilter) || hasOutput;
  }

  if (options.status !== 'blocked') {
    hasOutput = renderControlSection('Failed', failedIssues, stageFilter) || hasOutput;
  }

  if (!hasOutput) {
    logger.log('No shipper-managed issues found.');
  }
}
