import { execFileSync } from 'node:child_process';
import { confirm, promptChoice } from '../lib/confirm.js';
import { getRepoNwo } from '../lib/github.js';
import { isLockStale } from '../lib/lock.js';

type ResetMode = 'full' | 'partial';

const PR_STAGE_LABELS = ['shipper:pr-open', 'shipper:pr-reviewed', 'shipper:ready'];

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
  addTarget: boolean;
  targetLabel: string;
  mode: ResetMode;
  commentIds: number[];
  prs: PREntry[];
  branchesToDelete: string[];
}

function getImplementedTimestamp(issueNum: number, nwo: string): string | null {
  try {
    const output = execFileSync(
      'gh',
      [
        'api',
        `repos/${nwo}/issues/${issueNum}/timeline`,
        '--paginate',
        '--jq',
        '.[] | select(.event == "labeled" and .label.name? == "shipper:implemented") | .created_at',
      ],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();

    if (!output) return null;

    const timestamps = output.split('\n').filter((line) => line.trim());
    if (timestamps.length === 0) return null;

    return timestamps[timestamps.length - 1]!;
  } catch {
    return null;
  }
}

function scanArtifacts(
  issueNum: number,
  nwo: string,
  mode: ResetMode,
  labels: string[]
): ArtifactScan {
  const shipperLabels = labels.filter((n) => n.startsWith('shipper:'));

  // Labels
  let labelsToRemove: string[];
  let targetLabel: string;
  let addTarget: boolean;

  if (mode === 'partial') {
    labelsToRemove = labels.filter((l) => PR_STAGE_LABELS.includes(l));
    targetLabel = 'shipper:implemented';
    addTarget = !labels.includes('shipper:implemented');
  } else {
    labelsToRemove = shipperLabels.filter((n) => n !== 'shipper:new');
    targetLabel = 'shipper:new';
    addTarget = !shipperLabels.includes('shipper:new');
  }

  // Comments
  let commentIds: number[] = [];
  if (mode === 'partial') {
    const implementedAt = getImplementedTimestamp(issueNum, nwo);
    if (implementedAt) {
      try {
        const raw = execFileSync(
          'gh',
          [
            'api',
            `repos/${nwo}/issues/${issueNum}/comments`,
            '--paginate',
            '--jq',
            '.[] | {id, created_at}',
          ],
          { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
        );
        const lines = raw
          .trim()
          .split('\n')
          .filter((s) => s !== '');
        for (const line of lines) {
          const comment = JSON.parse(line) as { id: number; created_at: string };
          if (comment.created_at > implementedAt) {
            commentIds.push(comment.id);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`Warning: Could not fetch comments for issue #${issueNum}: ${msg}`);
      }
    } else {
      console.warn(
        'Warning: Could not determine when shipper:implemented was applied. Skipping comment cleanup.'
      );
    }
  } else {
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

  return { labelsToRemove, addTarget, targetLabel, mode, commentIds, prs, branchesToDelete };
}

function isClean(scan: ArtifactScan): boolean {
  return (
    scan.labelsToRemove.length === 0 &&
    !scan.addTarget &&
    scan.commentIds.length === 0 &&
    scan.prs.length === 0 &&
    scan.branchesToDelete.length === 0
  );
}

function printDryRun(issueNum: number, scan: ArtifactScan): void {
  console.log(`\nReset summary for issue #${issueNum}:`);
  console.log(`  Target: ${scan.targetLabel}`);
  if (scan.labelsToRemove.length > 0) {
    console.log(`  Labels to remove: ${scan.labelsToRemove.join(', ')}`);
  }
  if (scan.addTarget) {
    console.log(`  Labels to add: ${scan.targetLabel}`);
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

  // 1. Close PRs and track which ones succeeded for branch deletion
  const closedPrBranches = new Set<string>();
  for (const pr of scan.prs) {
    try {
      execFileSync('gh', ['pr', 'close', String(pr.number)], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      closedPrBranches.add(pr.headRefName);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  Warning: Failed to close PR #${pr.number}: ${msg}`);
    }
  }
  if (scan.prs.length > 0) {
    actions.push(`Closed PRs: ${scan.prs.map((pr) => `#${pr.number}`).join(', ')}`);
  }

  // 2. Delete branches (only for PRs that were successfully closed)
  const deletableBranches = scan.branchesToDelete.filter((b) => closedPrBranches.has(b));
  for (const branch of deletableBranches) {
    try {
      execFileSync('git', ['push', 'origin', '--delete', branch], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  Warning: Failed to delete branch ${branch}: ${msg}`);
    }
  }
  if (deletableBranches.length > 0) {
    actions.push(`Deleted branches: ${deletableBranches.join(', ')}`);
  }

  // 3. Delete comments
  for (const id of scan.commentIds) {
    try {
      execFileSync('gh', ['api', '-X', 'DELETE', `repos/${nwo}/issues/comments/${id}`], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  Warning: Failed to delete comment ${id}: ${msg}`);
    }
  }
  if (scan.commentIds.length > 0) {
    actions.push(`Deleted ${scan.commentIds.length} comment(s)`);
  }

  // 4. Reset labels
  if (scan.labelsToRemove.length > 0 || scan.addTarget) {
    const args = ['issue', 'edit', String(issueNum)];
    if (scan.labelsToRemove.length > 0) {
      args.push('--remove-label', scan.labelsToRemove.join(','));
    }
    if (scan.addTarget) {
      args.push('--add-label', scan.targetLabel);
    }
    try {
      execFileSync('gh', args, { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  Warning: Failed to update labels: ${msg}`);
    }
  }
  if (scan.labelsToRemove.length > 0) {
    actions.push(`Removed labels: ${scan.labelsToRemove.join(', ')}`);
  }
  if (scan.addTarget) {
    actions.push(`Added label: ${scan.targetLabel}`);
  }

  // 5. Post reset comment
  let resetBody: string;
  if (scan.mode === 'partial') {
    resetBody =
      '**This issue has been reset to `shipper:implemented`.** ' +
      'PR artifacts have been cleaned up. Grooming, design, and planning content is preserved.';
  } else {
    resetBody =
      '**This issue has been reset to `shipper:new`.**\n\n' +
      'Any remaining content in the issue body is from a previous workflow run ' +
      'and should be treated as a suggestion for the next grooming attempt, not as groomed or approved content.';
  }
  try {
    execFileSync('gh', ['issue', 'comment', String(issueNum), '--body', resetBody], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    actions.push('Posted reset notice comment');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  Warning: Failed to post reset comment: ${msg}`);
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

  const issueData: IssueViewData = JSON.parse(issueJson);

  if (issueData.state !== 'OPEN') {
    console.error(`Issue #${issueNum} is closed. Reset only works on open issues.`);
    process.exit(1);
  }

  const labels = issueData.labels.map((l) => l.name);

  // Lock check
  if (!opts.force && labels.includes('shipper:locked')) {
    if (!isLockStale(String(issueNum))) {
      console.error(
        `Issue #${issueNum} is locked by another shipper instance. Use --force to override.`
      );
      process.exit(1);
    }
  }

  // Mode selection
  const isPastImplemented = labels.some((l) => PR_STAGE_LABELS.includes(l));
  let mode: ResetMode = 'full';
  if (isPastImplemented && !opts.force) {
    console.log('\nReset options:');
    console.log('  1) Reset to shipper:implemented (PR cleanup only)');
    console.log('  2) Reset to shipper:new (full reset)');
    mode = (await promptChoice('Select [1-2]: ', ['1', '2'])) === '1' ? 'partial' : 'full';
  }

  const scan = scanArtifacts(issueNum, nwo, mode, labels);

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
