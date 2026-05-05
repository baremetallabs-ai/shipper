import {
  gh,
  logger,
  parseIssueNumberLabels,
  parseIssueNumberLabelsList,
} from '@baremetallabs-ai/shipper-core';

export async function adoptCommand(issue: string): Promise<void> {
  const cleanRef = issue.replace(/^#/, '');
  if (!/^\d+$/.test(cleanRef)) {
    logger.error('Usage: shipper adopt <issue>');
    throw new Error('Error: Please provide a valid issue number.');
  }

  // Fetch issue data
  let output = '';
  try {
    const { stdout } = await gh(['issue', 'view', cleanRef, '--json', 'number,labels']);
    output = stdout.trim();
  } catch {
    throw new Error(`Error: Issue #${cleanRef} not found.`);
  }
  const issueData = parseIssueNumberLabels(output);

  // Check if it's a PR
  let isPr = false;
  try {
    await gh(['pr', 'view', cleanRef, '--json', 'number,url']);
    isPr = true;
  } catch {
    // Not a PR — continue
  }
  if (isPr) {
    throw new Error(`Error: #${cleanRef} is a pull request, not an issue.`);
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
    throw new Error(`Error: Failed to add 'shipper:new' label to issue #${cleanRef}.`);
  }

  logger.log(`Issue #${cleanRef} adopted into shipper workflow.`);
}

export async function adoptAllCommand(): Promise<void> {
  let output = '';
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
    output = stdout.trim();
  } catch {
    throw new Error('Error: Failed to fetch issues.');
  }
  const issues = parseIssueNumberLabelsList(output);

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
    process.exitCode = 1;
  }
}
