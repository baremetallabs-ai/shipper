import { openSync, closeSync, readFileSync, writeFileSync, unlinkSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fetchChecks, classifyChecks } from '@dnsquared/shipper-core';
import { gh } from '@dnsquared/shipper-core';
import { tryResolvePrForIssue } from '@dnsquared/shipper-core';
import { getRepoNwo } from '@dnsquared/shipper-core';
import { withStageHooks } from '@dnsquared/shipper-core';

interface MergeOptions {
  interval: string;
  once: boolean;
  dryRun: boolean;
  repo?: string;
  number?: string;
}

export interface QueuedPR {
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

async function resolveRepo(override?: string): Promise<string> {
  if (override) return override;
  return await getRepoNwo();
}

interface PRViewResult {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  state: string;
  labels: { name: string }[];
}

async function fetchPRView(ref: string, nwo: string): Promise<PRViewResult> {
  const { stdout: json } = await gh([
    'pr',
    'view',
    ref,
    '-R',
    nwo,
    '--json',
    'number,title,headRefName,baseRefName,state,labels',
  ]);
  return JSON.parse(json) as PRViewResult;
}

export async function lookupPR(ref: string, nwo: string): Promise<QueuedPR> {
  let data: PRViewResult;

  try {
    data = await fetchPRView(ref, nwo);
  } catch {
    // Not a PR — try resolving as an issue number
    const resolved = await tryResolvePrForIssue(Number(ref));
    if (!resolved) {
      console.error(`Error: #${ref} is not a PR and no linked PR was found.`);
      process.exit(1);
    }
    try {
      data = await fetchPRView(resolved, nwo);
    } catch {
      console.error(`Error: Failed to fetch resolved PR #${resolved}.`);
      process.exit(1);
    }
  }

  if (data.state !== 'OPEN') {
    console.error(`Error: PR #${data.number} is not open (state: ${data.state}).`);
    process.exit(1);
  }

  const hasReadyLabel = data.labels.some((l) => l.name === 'shipper:ready');
  if (!hasReadyLabel) {
    console.error(`Error: PR #${data.number} does not have the shipper:ready label.`);
    process.exit(1);
  }

  return {
    number: data.number,
    title: data.title,
    headRefName: data.headRefName,
    baseRefName: data.baseRefName,
    labeledAt: '',
  };
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

async function getQueue(nwo: string): Promise<QueuedPR[]> {
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
      const result = await gh(args);
      output = result.stdout;
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

async function failPR(pr: QueuedPR, reason: string, nwo: string, dryRun: boolean): Promise<void> {
  console.log(`  PR #${pr.number} failed: ${reason}`);
  if (dryRun) {
    console.log(`  [dry-run] Would remove shipper:ready, add shipper:pr-reviewed, comment on PR`);
    return;
  }

  const prRef = String(pr.number);
  const repoArgs = ['-R', nwo];

  try {
    await gh(['pr', 'edit', prRef, ...repoArgs, '--remove-label', 'shipper:ready']);
  } catch {
    console.error(`  Warning: Failed to remove shipper:ready label from PR #${pr.number}`);
  }

  try {
    await gh(['pr', 'edit', prRef, ...repoArgs, '--add-label', 'shipper:pr-reviewed']);
  } catch {
    console.error(`  Warning: Failed to add shipper:pr-reviewed label to PR #${pr.number}`);
  }

  try {
    await gh([
      'pr',
      'comment',
      prRef,
      ...repoArgs,
      '--body',
      `Merge queue removed this PR from the queue.\n\n**Reason:** ${reason}\n\nThe \`shipper:pr-reviewed\` label has been re-applied so the PR can be remediated and re-queued.`,
    ]);
  } catch {
    console.error(`  Warning: Failed to comment on PR #${pr.number}`);
  }
}

export async function getLinkedIssueNumber(prNumber: number, nwo: string): Promise<number | null> {
  try {
    const { stdout: json } = await gh([
      'pr',
      'view',
      String(prNumber),
      '-R',
      nwo,
      '--json',
      'body',
    ]);
    const { body } = JSON.parse(json) as { body: string };
    const match = /(?:^|\s)(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/im.exec(body);
    return match?.[1] ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

export async function postMerge(
  _pr: QueuedPR,
  issueNumber: number,
  nwo: string,
  dryRun: boolean
): Promise<void> {
  // Clean up label and close issue
  if (dryRun) {
    console.log(`  [dry-run] Would remove shipper:ready and close issue #${issueNumber}`);
    return;
  }

  const repoArgs = ['-R', nwo];
  try {
    await gh([
      'issue',
      'edit',
      String(issueNumber),
      ...repoArgs,
      '--remove-label',
      'shipper:ready',
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `  Warning: Failed to remove shipper:ready label from issue #${issueNumber}: ${msg}`
    );
  }

  try {
    await gh(['issue', 'close', String(issueNumber), ...repoArgs]);
    console.log(`  Issue #${issueNumber} closed.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  Warning: Failed to close issue #${issueNumber}: ${msg}`);
  }
}

async function runPostMergeActions(pr: QueuedPR, nwo: string, dryRun: boolean): Promise<void> {
  const issueNumber = await getLinkedIssueNumber(pr.number, nwo);
  if (issueNumber == null) {
    console.warn(
      `  Warning: Could not determine linked issue for PR #${pr.number}. Skipping post-merge actions.`
    );
    return;
  }
  await postMerge(pr, issueNumber, nwo, dryRun);
}

async function processPR(pr: QueuedPR, nwo: string, dryRun: boolean): Promise<boolean> {
  console.log(`  Processing PR #${pr.number}: ${pr.title}`);

  // Check merge state
  let mergeState: string;
  try {
    const { stdout: json } = await gh([
      'pr',
      'view',
      String(pr.number),
      '-R',
      nwo,
      '--json',
      'mergeStateStatus',
    ]);
    const data: PRViewData = JSON.parse(json);
    mergeState = data.mergeStateStatus;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await failPR(pr, `Could not determine merge state: ${msg}`, nwo, dryRun);
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
      const { stdout } = await gh([
        'pr',
        'update-branch',
        String(pr.number),
        '-R',
        nwo,
        '--rebase',
      ]);
      if (stdout.trim()) {
        process.stdout.write(stdout);
      }
      console.log(`  Branch updated. Will check again next cycle.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await failPR(pr, `Failed to update branch: ${msg}`, nwo, dryRun);
    }
    return false;
  }

  if (mergeState === 'DIRTY') {
    await failPR(pr, 'PR has merge conflicts that must be resolved manually.', nwo, dryRun);
    return false;
  }

  if (mergeState === 'BLOCKED') {
    // Could be blocked by required checks still running — check CI status
    let checks;
    try {
      checks = await fetchChecks(String(pr.number), nwo);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await failPR(pr, `Could not fetch CI checks: ${msg}`, nwo, dryRun);
      return false;
    }

    const { pending, failed } = classifyChecks(checks);

    if (failed.length > 0) {
      const names = failed.map((c) => c.name).join(', ');
      await failPR(pr, `CI checks failed: ${names}`, nwo, dryRun);
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
    await runPostMergeActions(pr, nwo, true);
    return true;
  }

  try {
    const { stdout } = await gh([
      'pr',
      'merge',
      String(pr.number),
      '-R',
      nwo,
      '--rebase',
      '--delete-branch',
    ]);
    if (stdout.trim()) {
      process.stdout.write(stdout);
    }
    console.log(`  PR #${pr.number} merged successfully.`);
    await runPostMergeActions(pr, nwo, false);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await failPR(pr, `Merge failed: ${msg}`, nwo, dryRun);
    return false;
  }
}

async function processQueue(nwo: string, dryRun: boolean): Promise<void> {
  const queue = await getQueue(nwo);

  if (queue.length === 0) {
    console.log('No PRs in merge queue.');
    return;
  }

  console.log(`Merge queue: ${queue.length} PR(s)`);
  for (const pr of queue) {
    console.log(`  #${pr.number} — ${pr.title} (labeled ${pr.labeledAt})`);
  }

  const first = queue[0];
  if (!first) {
    return;
  }

  await withStageHooks(
    'merge',
    {
      issueNumber: String((await getLinkedIssueNumber(first.number, nwo)) ?? ''),
      branchName: first.headRefName,
    },
    async () => await processPR(first, nwo, dryRun)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function mergeCommand(options: MergeOptions): Promise<void> {
  const nwo = await resolveRepo(options.repo);

  if (options.number) {
    const cleaned = options.number.replace(/^#/, '');
    if (!/^\d+$/.test(cleaned)) {
      console.error('Error: argument must be a numeric issue or PR number.');
      process.exit(1);
    }
    console.log(`Merge queue for ${nwo}`);
    if (options.dryRun) console.log('[dry-run mode]');
    const pr = await lookupPR(cleaned, nwo);
    console.log(`Targeting PR #${pr.number}: ${pr.title}`);
    const merged = await withStageHooks(
      'merge',
      {
        issueNumber: String((await getLinkedIssueNumber(pr.number, nwo)) ?? ''),
        branchName: pr.headRefName,
      },
      async () => await processPR(pr, nwo, options.dryRun)
    );
    if (!merged) process.exit(1);
    return;
  }

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
      await processQueue(nwo, options.dryRun);
    } else {
      console.log(`Polling every ${intervalSeconds}s. Press Ctrl+C to stop.`);
      while (true) {
        await processQueue(nwo, options.dryRun);
        await sleep(intervalSeconds * 1000);
      }
    }
  } finally {
    releaseLock(lockPath);
  }
}
