import { execFileSync } from 'node:child_process';
import { confirm } from '../lib/confirm.js';
import { getRepoNwo } from '../lib/github.js';

interface IssueViewData {
  number: number;
  state: string;
  labels: { name: string }[];
}

interface PREntry {
  number: number;
  headRefName: string;
}

interface ArtifactScan {
  labelsToRemove: string[];
  addNew: boolean;
  commentIds: number[];
  prs: PREntry[];
  branchesToDelete: string[];
}

function scanArtifacts(issueNum: number, nwo: string): ArtifactScan {
  // Fetch issue data
  let issueJson: string;
  try {
    issueJson = execFileSync(
      'gh',
      ['issue', 'view', String(issueNum), '--json', 'number,state,labels'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: Failed to fetch issue #${issueNum}: ${msg}`);
    process.exit(1);
  }

  const issue: IssueViewData = JSON.parse(issueJson);

  if (issue.state !== 'OPEN') {
    console.error(`Issue #${issueNum} is closed. Reset only works on open issues.`);
    process.exit(1);
  }

  // Labels
  const shipperLabels = issue.labels.map((l) => l.name).filter((n) => n.startsWith('shipper:'));
  const labelsToRemove = shipperLabels.filter((n) => n !== 'shipper:new');
  const addNew = !shipperLabels.includes('shipper:new');

  // Comments (use REST API for IDs)
  let commentIds: number[] = [];
  try {
    const raw = execFileSync(
      'gh',
      ['api', `repos/${nwo}/issues/${issueNum}/comments`, '--paginate', '--jq', '.[].id'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    commentIds = raw
      .trim()
      .split('\n')
      .filter((s) => s !== '')
      .map(Number);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Warning: Could not fetch comments for issue #${issueNum}: ${msg}`);
  }

  // PRs
  let prs: PREntry[] = [];
  try {
    const prJson = execFileSync(
      'gh',
      [
        'pr',
        'list',
        '--search',
        String(issueNum),
        '--state',
        'open',
        '--json',
        'number,headRefName',
      ],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const allPrs: PREntry[] = JSON.parse(prJson);
    prs = allPrs.filter(
      (pr) =>
        pr.headRefName === `shipper/${issueNum}` ||
        pr.headRefName.startsWith(`shipper/${issueNum}-`) ||
        pr.headRefName === `${issueNum}` ||
        pr.headRefName.startsWith(`${issueNum}-`)
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Warning: Could not fetch PRs for issue #${issueNum}: ${msg}`);
  }

  // Branches to delete (only shipper/-prefixed)
  const branchesToDelete = prs
    .map((pr) => pr.headRefName)
    .filter((name) => name.startsWith('shipper/'));

  return { labelsToRemove, addNew, commentIds, prs, branchesToDelete };
}

function isClean(scan: ArtifactScan): boolean {
  return (
    scan.labelsToRemove.length === 0 &&
    !scan.addNew &&
    scan.commentIds.length === 0 &&
    scan.prs.length === 0 &&
    scan.branchesToDelete.length === 0
  );
}

function printDryRun(issueNum: number, scan: ArtifactScan): void {
  console.log(`\nReset summary for issue #${issueNum}:`);
  if (scan.labelsToRemove.length > 0) {
    console.log(`  Labels to remove: ${scan.labelsToRemove.join(', ')}`);
  }
  if (scan.addNew) {
    console.log(`  Labels to add: shipper:new`);
  }
  if (scan.commentIds.length > 0) {
    console.log(`  Comments to delete: ${scan.commentIds.length}`);
  }
  if (scan.prs.length > 0) {
    console.log(`  PRs to close: ${scan.prs.map((pr) => `#${pr.number}`).join(', ')}`);
  }
  if (scan.branchesToDelete.length > 0) {
    console.log(`  Branches to delete: ${scan.branchesToDelete.join(', ')}`);
  }
  console.log('');
}

function executeReset(issueNum: number, scan: ArtifactScan, nwo: string): void {
  const actions: string[] = [];

  // 1. Close PRs
  for (const pr of scan.prs) {
    try {
      execFileSync('gh', ['pr', 'close', String(pr.number)], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  Warning: Failed to close PR #${pr.number}: ${msg}`);
    }
  }
  if (scan.prs.length > 0) {
    actions.push(`Closed PRs: ${scan.prs.map((pr) => `#${pr.number}`).join(', ')}`);
  }

  // 2. Delete branches
  for (const branch of scan.branchesToDelete) {
    try {
      execFileSync('git', ['push', 'origin', '--delete', branch], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  Warning: Failed to delete branch ${branch}: ${msg}`);
    }
  }
  if (scan.branchesToDelete.length > 0) {
    actions.push(`Deleted branches: ${scan.branchesToDelete.join(', ')}`);
  }

  // 3. Delete comments
  for (const id of scan.commentIds) {
    try {
      execFileSync('gh', ['api', '-X', 'DELETE', `repos/${nwo}/issues/comments/${id}`], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  Warning: Failed to delete comment ${id}: ${msg}`);
    }
  }
  if (scan.commentIds.length > 0) {
    actions.push(`Deleted ${scan.commentIds.length} comment(s)`);
  }

  // 4. Reset labels
  if (scan.labelsToRemove.length > 0 || scan.addNew) {
    const args = ['issue', 'edit', String(issueNum)];
    if (scan.labelsToRemove.length > 0) {
      args.push('--remove-label', scan.labelsToRemove.join(','));
    }
    if (scan.addNew) {
      args.push('--add-label', 'shipper:new');
    }
    try {
      execFileSync('gh', args, { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  Warning: Failed to update labels: ${msg}`);
    }
  }
  if (scan.labelsToRemove.length > 0) {
    actions.push(`Removed labels: ${scan.labelsToRemove.join(', ')}`);
  }
  if (scan.addNew) {
    actions.push('Added label: shipper:new');
  }

  // 5. Post reset comment
  const resetBody =
    '**This issue has been reset to `shipper:new`.**\n\n' +
    'Any remaining content in the issue body is from a previous workflow run ' +
    'and should be treated as a suggestion for the next grooming attempt, not as groomed or approved content.';
  try {
    execFileSync('gh', ['issue', 'comment', String(issueNum), '--body', resetBody], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    actions.push('Posted reset notice comment');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  Warning: Failed to post reset comment: ${msg}`);
  }

  // Print summary
  console.log(`\nReset complete for issue #${issueNum}:`);
  for (const action of actions) {
    console.log(`  ✓ ${action}`);
  }
}

export async function resetCommand(issue: string, opts: { force: boolean }): Promise<void> {
  const cleaned = issue.replace(/^#/, '');
  if (!/^\d+$/.test(cleaned)) {
    console.error('Error: Please provide a valid issue number.');
    console.error('Usage: shipper reset <issue>');
    process.exit(1);
  }
  const issueNum = Number(cleaned);

  const nwo = getRepoNwo();
  const scan = scanArtifacts(issueNum, nwo);

  if (isClean(scan)) {
    console.log(`Issue #${issueNum} is already clean. Nothing to reset.`);
    return;
  }

  printDryRun(issueNum, scan);

  if (!opts.force) {
    const proceed = await confirm('Proceed? (y/N): ');
    if (!proceed) {
      console.log('Reset cancelled.');
      return;
    }
  }

  executeReset(issueNum, scan, nwo);
}
