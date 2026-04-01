import {
  gh,
  logger,
  PRIORITY_HIGH_LABEL,
  PRIORITY_LOW_LABEL,
  STAGE_LABEL_NAMES,
} from '@dnsquared/shipper-core';

interface IssueLabel {
  name: string;
}

interface IssueData {
  number: number;
  state: string;
  labels: IssueLabel[];
}

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
    logger.error('Error: Please provide a valid issue number.');
    printUsage();
    process.exit(1);
  }

  let issueData: IssueData;
  try {
    const { stdout } = await gh([
      'issue',
      'view',
      issueStr,
      '-R',
      repo,
      '--json',
      'number,state,labels',
    ]);
    issueData = JSON.parse(stdout.trim()) as IssueData;
  } catch {
    logger.error(`Error: Issue #${issueStr} not found.`);
    process.exit(1);
  }

  let isPr = false;
  try {
    await gh(['pr', 'view', issueStr, '-R', repo, '--json', 'number,url']);
    isPr = true;
  } catch {
    // Not a PR.
  }

  if (isPr) {
    logger.error(`Error: #${issueStr} is a pull request, not an issue.`);
    process.exit(1);
  }

  if (issueData.state !== 'OPEN') {
    logger.error(`Error: Issue #${issueStr} is not open.`);
    process.exit(1);
  }

  const labels = issueData.labels.map((candidate) => candidate.name);
  const stageLabel = labels.find((label) => STAGE_LABEL_NAMES.includes(label));
  if (!stageLabel) {
    logger.error(`Error: Issue #${issueStr} is not in the shipper workflow.`);
    process.exit(1);
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
