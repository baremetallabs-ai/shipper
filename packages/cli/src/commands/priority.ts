import {
  gh,
  logger,
  parseIssueLabelsState,
  PRIORITY_HIGH_LABEL,
  PRIORITY_LOW_LABEL,
  STAGE_LABEL_NAMES,
} from '@baremetallabs-ai/shipper-core';

function printUsage(): void {
  logger.error('Usage: shipper priority <issue> <high|normal|low>');
}

export async function priorityCommand(
  repo: string,
  issue: string,
  level: 'high' | 'normal' | 'low'
): Promise<void> {
  const issueStr = issue.replace(/^#/, '');
  if (!/^\d+$/.test(issueStr)) {
    printUsage();
    throw new Error('Error: Please provide a valid issue number.');
  }

  let stdout = '';
  try {
    const result = await gh([
      'issue',
      'view',
      issueStr,
      '-R',
      repo,
      '--json',
      'number,state,labels',
    ]);
    stdout = result.stdout.trim();
  } catch {
    throw new Error(`Error: Issue #${issueStr} not found.`);
  }
  const issueData = parseIssueLabelsState(stdout);

  let isPr = false;
  try {
    await gh(['pr', 'view', issueStr, '-R', repo, '--json', 'number,url']);
    isPr = true;
  } catch {
    // Not a PR.
  }

  if (isPr) {
    throw new Error(`Error: #${issueStr} is a pull request, not an issue.`);
  }

  if (issueData.state !== 'OPEN') {
    throw new Error(`Error: Issue #${issueStr} is not open.`);
  }

  const labels = issueData.labels.map((candidate) => candidate.name);
  const stageLabel = labels.find((label) => STAGE_LABEL_NAMES.includes(label));
  if (!stageLabel) {
    throw new Error(`Error: Issue #${issueStr} is not in the shipper workflow.`);
  }

  const hasHigh = labels.includes(PRIORITY_HIGH_LABEL);
  const hasLow = labels.includes(PRIORITY_LOW_LABEL);

  if (level === 'normal' && !hasHigh && !hasLow) {
    logger.log(`Issue #${issueStr} is already at normal priority.`);
    return;
  }

  const args = ['issue', 'edit', issueStr, '-R', repo];
  let message: string;

  if (level === 'high') {
    args.push('--add-label', PRIORITY_HIGH_LABEL, '--remove-label', PRIORITY_LOW_LABEL);
    message = `Issue #${issueStr} priority set to high.`;
  } else if (level === 'low') {
    args.push('--add-label', PRIORITY_LOW_LABEL, '--remove-label', PRIORITY_HIGH_LABEL);
    message = `Issue #${issueStr} priority set to low.`;
  } else {
    args.push('--remove-label', PRIORITY_HIGH_LABEL, '--remove-label', PRIORITY_LOW_LABEL);
    message = `Issue #${issueStr} priority set to normal.`;
  }

  await gh(args);
  logger.log(message);
}
