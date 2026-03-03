import { execFileSync } from 'node:child_process';
import { openSync, closeSync, readFileSync, writeFileSync, unlinkSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getRepoNwo } from '../lib/github.js';

interface MergeOptions {
  interval: string;
  once: boolean;
  dryRun: boolean;
  repo?: string;
}

interface QueuedPR {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  labeledAt: string;
}

interface SearchNode {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  timelineItems: {
    nodes: Array<{
      createdAt: string;
      label?: { name: string };
    }>;
  };
}

interface GraphQLResponse {
  data: {
    search: {
      nodes: SearchNode[];
      pageInfo: {
        hasNextPage: boolean;
        endCursor: string | null;
      };
    };
  };
}

interface PRViewData {
  mergeStateStatus: string;
}

interface PRChecksLine {
  name: string;
  state: string;
  conclusion: string;
}

function resolveRepo(override?: string): string {
  if (override) return override;
  return getRepoNwo();
}

function getLockPath(nwo: string): string {
  return path.join(tmpdir(), `shipper-merge-${nwo.replace('/', '-')}.lock`);
}

function acquireLock(lockPath: string): void {
  // Try to create the lock file exclusively (O_CREAT | O_EXCL) — atomic on POSIX
  try {
    const fd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    return;
  } catch {
    // Lock file already exists — check if stale
  }

  let pid: number;
  try {
    pid = parseInt(readFileSync(lockPath, 'utf-8').trim(), 10);
  } catch {
    // Can't read lock file — remove and retry
    try {
      unlinkSync(lockPath);
    } catch {
      // Another process may have removed it
    }
    return acquireLock(lockPath);
  }

  if (isNaN(pid)) {
    // Corrupt lock file — remove and retry
    try {
      unlinkSync(lockPath);
    } catch {
      // Another process may have removed it
    }
    return acquireLock(lockPath);
  }

  // Check if the process is still running
  try {
    process.kill(pid, 0); // Throws if process doesn't exist
    console.error(`Error: Another merge queue is running (PID ${pid}). Lock: ${lockPath}`);
    process.exit(1);
  } catch {
    // Process doesn't exist — stale lock
    console.log(`Removing stale lock (PID ${pid} no longer running).`);
    try {
      unlinkSync(lockPath);
    } catch {
      // Another process may have removed it
    }
    return acquireLock(lockPath);
  }
}

function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // Best effort
  }
}

function getQueue(nwo: string): QueuedPR[] {
  const query = `
    query($q: String!, $cursor: String) {
      search(query: $q, type: ISSUE, first: 50, after: $cursor) {
        nodes {
          ... on PullRequest {
            number
            title
            headRefName
            baseRefName
            timelineItems(itemTypes: [LABELED_EVENT], last: 50) {
              nodes {
                ... on LabeledEvent {
                  createdAt
                  label { name }
                }
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;
  const searchQuery = `repo:${nwo} is:pr is:open label:shipper:ready`;
  const allNodes: SearchNode[] = [];
  let cursor: string | null = null;

  do {
    const args = ['api', 'graphql', '-f', `query=${query}`, '-f', `q=${searchQuery}`];
    if (cursor) {
      args.push('-f', `cursor=${cursor}`);
    }

    let output: string;
    try {
      output = execFileSync('gh', args, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: Failed to query merge queue: ${msg}`);
      return [];
    }

    const response: GraphQLResponse = JSON.parse(output);
    allNodes.push(...response.data.search.nodes);

    if (response.data.search.pageInfo.hasNextPage) {
      cursor = response.data.search.pageInfo.endCursor;
    } else {
      cursor = null;
    }
  } while (cursor);

  const prs: QueuedPR[] = [];
  for (const node of allNodes) {
    const labelEvent = node.timelineItems.nodes.find((e) => e.label?.name === 'shipper:ready');
    prs.push({
      number: node.number,
      title: node.title,
      headRefName: node.headRefName,
      baseRefName: node.baseRefName,
      labeledAt: labelEvent?.createdAt ?? '',
    });
  }

  // Sort FIFO by when shipper:ready was applied
  prs.sort((a, b) => a.labeledAt.localeCompare(b.labeledAt));
  return prs;
}

function failPR(pr: QueuedPR, reason: string, nwo: string, dryRun: boolean): void {
  console.log(`  PR #${pr.number} failed: ${reason}`);
  if (dryRun) {
    console.log(`  [dry-run] Would remove shipper:ready, add shipper:pr-reviewed, comment on PR`);
    return;
  }

  const prRef = String(pr.number);
  const repoArgs = ['-R', nwo];

  try {
    execFileSync('gh', ['pr', 'edit', prRef, ...repoArgs, '--remove-label', 'shipper:ready'], {
      stdio: 'ignore',
    });
  } catch {
    console.error(`  Warning: Failed to remove shipper:ready label from PR #${pr.number}`);
  }

  try {
    execFileSync('gh', ['pr', 'edit', prRef, ...repoArgs, '--add-label', 'shipper:pr-reviewed'], {
      stdio: 'ignore',
    });
  } catch {
    console.error(`  Warning: Failed to add shipper:pr-reviewed label to PR #${pr.number}`);
  }

  try {
    execFileSync(
      'gh',
      [
        'pr',
        'comment',
        prRef,
        ...repoArgs,
        '--body',
        `Merge queue removed this PR from the queue.\n\n**Reason:** ${reason}\n\nThe \`shipper:pr-reviewed\` label has been re-applied so the PR can be remediated and re-queued.`,
      ],
      { stdio: 'ignore' }
    );
  } catch {
    console.error(`  Warning: Failed to comment on PR #${pr.number}`);
  }
}

function processPR(pr: QueuedPR, nwo: string, dryRun: boolean): boolean {
  console.log(`  Processing PR #${pr.number}: ${pr.title}`);

  // Check merge state
  let mergeState: string;
  try {
    const json = execFileSync(
      'gh',
      ['pr', 'view', String(pr.number), '-R', nwo, '--json', 'mergeStateStatus'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const data: PRViewData = JSON.parse(json);
    mergeState = data.mergeStateStatus;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failPR(pr, `Could not determine merge state: ${msg}`, nwo, dryRun);
    return false;
  }

  console.log(`  Merge state: ${mergeState}`);

  if (mergeState === 'BEHIND') {
    console.log(`  Branch is behind base — updating...`);
    if (dryRun) {
      console.log(`  [dry-run] Would run: gh pr update-branch --rebase`);
      return false;
    }
    try {
      execFileSync('gh', ['pr', 'update-branch', String(pr.number), '-R', nwo, '--rebase'], {
        stdio: 'ignore',
      });
      console.log(`  Branch updated. Will check again next cycle.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failPR(pr, `Failed to update branch: ${msg}`, nwo, dryRun);
    }
    return false;
  }

  if (mergeState === 'DIRTY') {
    failPR(pr, 'PR has merge conflicts that must be resolved manually.', nwo, dryRun);
    return false;
  }

  if (mergeState === 'BLOCKED') {
    // Could be blocked by required checks still running — check CI status
    let checksOutput: string;
    try {
      checksOutput = execFileSync(
        'gh',
        ['pr', 'checks', String(pr.number), '-R', nwo, '--json', 'name,state,conclusion'],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failPR(pr, `Could not fetch CI checks: ${msg}`, nwo, dryRun);
      return false;
    }

    const checks: PRChecksLine[] = JSON.parse(checksOutput);
    const pending = checks.filter(
      (c) => c.state === 'PENDING' || c.state === 'QUEUED' || c.state === 'IN_PROGRESS'
    );
    const failed = checks.filter(
      (c) => c.conclusion === 'FAILURE' || c.conclusion === 'ERROR' || c.conclusion === 'CANCELLED'
    );

    if (failed.length > 0) {
      const names = failed.map((c) => c.name).join(', ');
      failPR(pr, `CI checks failed: ${names}`, nwo, dryRun);
      return false;
    }

    if (pending.length > 0) {
      const names = pending.map((c) => c.name).join(', ');
      console.log(`  Checks still running: ${names}. Will retry next cycle.`);
      return false;
    }

    // Blocked but no failing/pending checks — might be review requirements
    console.log(`  PR is blocked (possibly awaiting review approval). Will retry next cycle.`);
    return false;
  }

  if (mergeState === 'UNKNOWN') {
    console.log(`  Merge state not yet computed by GitHub. Will retry next cycle.`);
    return false;
  }

  if (mergeState !== 'CLEAN' && mergeState !== 'HAS_HOOKS' && mergeState !== 'UNSTABLE') {
    console.log(`  Unexpected merge state: ${mergeState}. Will retry next cycle.`);
    return false;
  }

  // Ready to merge
  if (dryRun) {
    console.log(`  [dry-run] Would merge PR #${pr.number} with --rebase --delete-branch`);
    return true;
  }

  try {
    execFileSync(
      'gh',
      ['pr', 'merge', String(pr.number), '-R', nwo, '--rebase', '--delete-branch'],
      { stdio: 'inherit' }
    );
    console.log(`  PR #${pr.number} merged successfully.`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failPR(pr, `Merge failed: ${msg}`, nwo, dryRun);
    return false;
  }
}

function processQueue(nwo: string, dryRun: boolean): void {
  const queue = getQueue(nwo);

  if (queue.length === 0) {
    console.log('No PRs in merge queue.');
    return;
  }

  console.log(`Merge queue: ${queue.length} PR(s)`);
  for (const pr of queue) {
    console.log(`  #${pr.number} — ${pr.title} (labeled ${pr.labeledAt})`);
  }

  const first = queue[0]!;
  processPR(first, nwo, dryRun);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function mergeCommand(options: MergeOptions): Promise<void> {
  const nwo = resolveRepo(options.repo);
  if (!/^\d+$/.test(options.interval)) {
    console.error('Error: --interval must be a positive integer (seconds).');
    process.exit(1);
  }
  const intervalSeconds = Number(options.interval);

  if (intervalSeconds < 1) {
    console.error('Error: --interval must be a positive integer (seconds).');
    process.exit(1);
  }

  console.log(`Merge queue for ${nwo}`);
  if (options.dryRun) console.log('[dry-run mode]');

  const lockPath = getLockPath(nwo);
  acquireLock(lockPath);

  const cleanup = () => {
    releaseLock(lockPath);
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  try {
    if (options.once) {
      processQueue(nwo, options.dryRun);
    } else {
      console.log(`Polling every ${intervalSeconds}s. Press Ctrl+C to stop.`);
      while (true) {
        processQueue(nwo, options.dryRun);
        await sleep(intervalSeconds * 1000);
      }
    }
  } finally {
    releaseLock(lockPath);
  }
}
