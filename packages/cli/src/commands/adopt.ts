import { gh, logger } from '@dnsquared/shipper-core';

interface IssueLabel {
  name: string;
}

interface IssueData {
  number: number;
  labels: IssueLabel[];
}

export async function adoptCommand(issue: string): Promise<void> {
  const cleanRef = issue.replace(/^#/, '');
  if (!/^\d+$/.test(cleanRef)) {
    logger.error('Error: Please provide a valid issue number.');
    logger.error('Usage: shipper adopt <issue>');
    process.exit(1);
  }

  // Fetch issue data
  let issueData: IssueData;
  try {
    const { stdout } = await gh(['issue', 'view', cleanRef, '--json', 'number,labels']);
    const output = stdout.trim();
    issueData = JSON.parse(output) as IssueData;
  } catch {
    logger.error(`Error: Issue #${cleanRef} not found.`);
    process.exit(1);
  }

  // Check if it's a PR
  let isPr = false;
  try {
    await gh(['pr', 'view', cleanRef, '--json', 'number,url']);
    isPr = true;
  } catch {
    // Not a PR — continue
  }
  if (isPr) {
    logger.error(`Error: #${cleanRef} is a pull request, not an issue.`);
    process.exit(1);
  }

  // Check for existing shipper labels
  const shipperLabels = issueData.labels
    .map((l) => l.name)
    .filter((name) => name.startsWith('shipper:'));

  if (shipperLabels.length > 0) {
    logger.warn(
      `Warning: Issue #${cleanRef} already has shipper label(s): ${shipperLabels.join(', ')}. No changes made.`
    );
    return;
  }

  // Add the shipper:new label
  try {
    await gh(['issue', 'edit', cleanRef, '--add-label', 'shipper:new']);
  } catch {
    logger.error(`Error: Failed to add 'shipper:new' label to issue #${cleanRef}.`);
    process.exit(1);
  }

  logger.log(`Issue #${cleanRef} adopted into shipper workflow.`);
}

export async function adoptAllCommand(): Promise<void> {
  let issues: IssueData[];
  try {
    const { stdout } = await gh([
      'issue',
      'list',
      '--state',
      'open',
      '--limit',
      '1000',
      '--json',
      'number,labels',
    ]);
    const output = stdout.trim();
    issues = JSON.parse(output) as IssueData[];
  } catch {
    logger.error('Error: Failed to fetch issues.');
    process.exit(1);
  }

  const eligible = issues.filter(
    (issue) => !issue.labels.some((l) => l.name.startsWith('shipper:'))
  );

  if (eligible.length === 0) {
    logger.log('No eligible issues found.');
    return;
  }

  const adopted: number[] = [];
  const failed: number[] = [];

  for (const issue of eligible) {
    try {
      await gh(['issue', 'edit', String(issue.number), '--add-label', 'shipper:new']);
      adopted.push(issue.number);
    } catch {
      logger.error(`Error: Failed to add 'shipper:new' label to issue #${issue.number}.`);
      failed.push(issue.number);
    }
  }

  if (adopted.length > 0) {
    const nums = adopted.map((n) => `#${n}`).join(', ');
    logger.log(`Adopted ${nums} into shipper workflow.`);
  }

  if (failed.length > 0) {
    process.exit(1);
  }
}
