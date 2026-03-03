import { execFileSync } from 'node:child_process';

interface IssueLabel {
  name: string;
}

interface IssueData {
  number: number;
  labels: IssueLabel[];
}

export function adoptCommand(issue: string): void {
  const cleanRef = issue.replace(/^#/, '');
  if (!/^\d+$/.test(cleanRef)) {
    console.error('Error: Please provide a valid issue number.');
    console.error('Usage: shipper adopt <issue>');
    process.exit(1);
  }

  // Fetch issue data
  let issueData: IssueData;
  try {
    const output = execFileSync('gh', ['issue', 'view', cleanRef, '--json', 'number,labels'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    issueData = JSON.parse(output) as IssueData;
  } catch {
    console.error(`Error: Issue #${cleanRef} not found.`);
    process.exit(1);
  }

  // Check if it's a PR
  let isPr = false;
  try {
    execFileSync('gh', ['pr', 'view', cleanRef, '--json', 'number,url'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    isPr = true;
  } catch {
    // Not a PR — continue
  }
  if (isPr) {
    console.error(`Error: #${cleanRef} is a pull request, not an issue.`);
    process.exit(1);
  }

  // Check for existing shipper labels
  const shipperLabels = issueData.labels
    .map((l) => l.name)
    .filter((name) => name.startsWith('shipper:'));

  if (shipperLabels.length > 0) {
    console.warn(
      `Warning: Issue #${cleanRef} already has shipper label(s): ${shipperLabels.join(', ')}. No changes made.`
    );
    return;
  }

  // Add the shipper:new label
  try {
    execFileSync('gh', ['issue', 'edit', cleanRef, '--add-label', 'shipper:new'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch {
    console.error(`Error: Failed to add 'shipper:new' label to issue #${cleanRef}.`);
    process.exit(1);
  }

  console.log(`Issue #${cleanRef} adopted into shipper workflow.`);
}
