import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gh } from './gh.js';
import { isLockStale, releaseIssueLock } from './lock.js';
import { getRepoNwo } from './repo.js';

const execFileAsync = promisify(execFile);

interface IssueComment {
  author: { login: string };
  body: string;
  createdAt: string;
}

interface IssueData {
  number: number;
  title: string;
  state: string;
  labels: { name: string }[];
  body: string;
  comments: IssueComment[];
  author: { login: string };
  createdAt: string;
}

interface ReviewComment {
  author: { login: string };
  body: string;
  state: string;
  submittedAt: string;
}

interface PRData {
  number: number;
  title: string;
  state: string;
  labels: { name: string }[];
  body: string;
  comments: IssueComment[];
  author: { login: string };
  createdAt: string;
  headRefName: string;
  baseRefName: string;
  reviews: ReviewComment[];
}

export interface ResolvedRef {
  issueNumber: string;
  prNumber?: string;
}

export interface ResolvedRefBoth extends ResolvedRef {
  prNumber: string;
}

export async function resolveBaseBranch(configured?: string): Promise<string> {
  if (configured) {
    let result: string;
    try {
      const output = await execFileAsync('git', ['ls-remote', '--heads', 'origin', configured], {
        encoding: 'utf-8',
      });
      result = output.stdout;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: Failed to check remote branch '${configured}': ${msg}`);
      process.exit(1);
    }
    // ls-remote uses pattern matching, so verify the exact ref is present
    const exactRef = `refs/heads/${configured}`;
    const found = result
      .trim()
      .split('\n')
      .some((line) => line.endsWith(`\t${exactRef}`));
    if (!found) {
      console.error(
        `Error: configured defaultBaseBranch '${configured}' does not exist on remote.`
      );
      process.exit(1);
    }
    return configured;
  }
  let output: string;
  try {
    const result = await gh([
      'repo',
      'view',
      '--json',
      'defaultBranchRef',
      '-q',
      '.defaultBranchRef.name',
    ]);
    output = result.stdout;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: Failed to auto-detect default base branch: ${msg}`);
    process.exit(1);
  }
  const branch = output.trim();
  if (!branch) {
    console.error('Error: Failed to auto-detect default base branch: received empty branch name.');
    process.exit(1);
  }
  return branch;
}

export async function fetchIssue(ref: string): Promise<string> {
  let json: string;
  try {
    const result = await gh([
      'issue',
      'view',
      ref,
      '--json',
      'number,title,state,labels,body,comments,author,createdAt',
    ]);
    json = result.stdout;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: Failed to fetch issue ${ref}: ${msg}`);
    process.exit(1);
  }

  const data: IssueData = JSON.parse(json);
  return formatIssue(data);
}

export async function fetchPR(ref: string): Promise<string> {
  let json: string;
  try {
    const result = await gh([
      'pr',
      'view',
      ref,
      '--json',
      'number,title,state,labels,body,comments,author,createdAt,headRefName,baseRefName,reviews',
    ]);
    json = result.stdout;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: Failed to fetch PR ${ref}: ${msg}`);
    process.exit(1);
  }

  const data: PRData = JSON.parse(json);
  return formatPR(data);
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function formatIssue(data: IssueData): string {
  const labels = data.labels.map((l) => l.name).join(', ') || 'none';
  const parts: string[] = [
    `<issue number="${data.number}" title="${escapeAttr(data.title)}" state="${data.state}" labels="${escapeAttr(labels)}" author="${data.author.login}" created="${data.createdAt}">`,
  ];

  parts.push(data.body ? `<body>\n${data.body}\n</body>` : '<body />');

  if (data.comments.length > 0) {
    parts.push('<comments>');
    for (const c of data.comments) {
      parts.push(
        `<comment author="${c.author.login}" date="${c.createdAt}">\n${c.body}\n</comment>`
      );
    }
    parts.push('</comments>');
  }

  parts.push('</issue>');
  return parts.join('\n');
}

export async function tryResolvePrForIssue(issueNumber: number): Promise<string | undefined> {
  try {
    const result = await gh([
      'pr',
      'list',
      '--state',
      'open',
      '--json',
      'number,headRefName',
      '--limit',
      '100',
    ]);
    const output = result.stdout.trim();
    const prs = JSON.parse(output) as { number: number; headRefName: string }[];
    const match = prs.find(
      (pr) =>
        pr.headRefName === `shipper/${issueNumber}` ||
        pr.headRefName.startsWith(`shipper/${issueNumber}-`)
    );
    return match ? String(match.number) : undefined;
  } catch {
    return undefined;
  }
}

export function formatPR(data: PRData): string {
  const labels = data.labels.map((l) => l.name).join(', ') || 'none';
  const parts: string[] = [
    `<pr number="${data.number}" title="${escapeAttr(data.title)}" state="${data.state}" labels="${escapeAttr(labels)}" author="${data.author.login}" created="${data.createdAt}" head="${data.headRefName}" base="${data.baseRefName}">`,
  ];

  parts.push(data.body ? `<body>\n${data.body}\n</body>` : '<body />');

  if (data.reviews.length > 0) {
    parts.push('<reviews>');
    for (const r of data.reviews) {
      parts.push(
        `<review author="${r.author.login}" state="${r.state}" date="${r.submittedAt}">\n${r.body || ''}\n</review>`
      );
    }
    parts.push('</reviews>');
  }

  if (data.comments.length > 0) {
    parts.push('<comments>');
    for (const c of data.comments) {
      parts.push(
        `<comment author="${c.author.login}" date="${c.createdAt}">\n${c.body}\n</comment>`
      );
    }
    parts.push('</comments>');
  }

  parts.push('</pr>');
  return parts.join('\n');
}

export interface TimelineLabelEvent {
  event: string;
  label?: { name: string };
  created_at?: string;
}

export function sortIssuesByLabelTime(
  issues: { number: number; title: string }[],
  timelinesByIssue: Map<number, TimelineLabelEvent[]>,
  label: string
): { number: number; title: string }[] {
  const withTimestamps = issues.map((issue) => {
    const events = timelinesByIssue.get(issue.number) ?? [];
    const labelEvents = events.filter(
      (e) => e.event === 'labeled' && e.label?.name === label && e.created_at
    );
    const lastEvent = labelEvents.length > 0 ? labelEvents[labelEvents.length - 1] : undefined;
    return { issue, timestamp: lastEvent?.created_at ?? '' };
  });

  withTimestamps.sort((a, b) => {
    if (!a.timestamp && !b.timestamp) return 0;
    if (!a.timestamp) return 1;
    if (!b.timestamp) return -1;
    return a.timestamp.localeCompare(b.timestamp);
  });

  return withTimestamps.map((w) => w.issue);
}

export async function selectIssuesForStage(
  label: string,
  staleLocked?: Set<number>
): Promise<{ number: number; title: string }[]> {
  const issueSearchFilter =
    label === 'shipper:new'
      ? '-label:shipper:locked'
      : '-label:shipper:blocked -label:shipper:locked';
  const lockedSearchFilter = label === 'shipper:new' ? null : '-label:shipper:blocked';
  let issues: { number: number; title: string }[];
  try {
    const result = await gh([
      'issue',
      'list',
      '--label',
      label,
      '--state',
      'open',
      '--limit',
      '1000',
      '--search',
      issueSearchFilter,
      '--json',
      'number,title',
    ]);
    const output = result.stdout.trim();
    issues = JSON.parse(output) as { number: number; title: string }[];
  } catch {
    return [];
  }

  // Fetch locked issues for the same stage and check for stale locks
  try {
    const result = await gh([
      'issue',
      'list',
      '--label',
      label,
      '--label',
      'shipper:locked',
      '--state',
      'open',
      '--limit',
      '1000',
      ...(lockedSearchFilter ? ['--search', lockedSearchFilter] : []),
      '--json',
      'number,title',
    ]);
    const lockedOutput = result.stdout.trim();
    const lockedIssues = JSON.parse(lockedOutput) as { number: number; title: string }[];
    for (const issue of lockedIssues) {
      if (await isLockStale(String(issue.number))) {
        issues.push(issue);
        staleLocked?.add(issue.number);
      }
    }
  } catch {
    console.error('Warning: Could not check for stale-locked issues. Proceeding without them.');
  }

  if (issues.length <= 1) {
    return issues;
  }

  const nwo = await getRepoNwo();
  const timelinesByIssue = new Map<number, TimelineLabelEvent[]>();

  for (const issue of issues) {
    try {
      const result = await gh([
        'api',
        `repos/${nwo}/issues/${issue.number}/timeline`,
        '--paginate',
        '--jq',
        '.[] | select(.event == "labeled") | {event, label, created_at}',
      ]);
      const output = result.stdout.trim();
      const events: TimelineLabelEvent[] = output
        ? output.split('\n').map((line) => JSON.parse(line) as TimelineLabelEvent)
        : [];
      timelinesByIssue.set(issue.number, events);
    } catch {
      timelinesByIssue.set(issue.number, []);
    }
  }

  return sortIssuesByLabelTime(issues, timelinesByIssue, label);
}

export async function clearStaleLockIfNeeded(
  issueNumber: number,
  staleLocked: Set<number>
): Promise<void> {
  if (staleLocked.has(issueNumber)) {
    console.error(`Issue #${issueNumber} lock is stale — clearing.`);
    await releaseIssueLock(String(issueNumber));
  }
}

export async function autoSelectIssue(
  label: string
): Promise<{ number: number; title: string } | null> {
  const staleLocked = new Set<number>();
  const issues = await selectIssuesForStage(label, staleLocked);
  const candidate = issues[0] ?? null;
  if (candidate) {
    await clearStaleLockIfNeeded(candidate.number, staleLocked);
  }
  return candidate;
}

export async function autoSelectPrForStage(
  label: string,
  emptyMessage: string
): Promise<{ pr: string; issue: { number: number; title: string } }> {
  const staleLocked = new Set<number>();
  const issues = await selectIssuesForStage(label, staleLocked);
  for (const issue of issues) {
    const resolved = await tryResolvePrForIssue(issue.number);
    if (resolved) {
      await clearStaleLockIfNeeded(issue.number, staleLocked);
      return { pr: resolved, issue };
    }
  }
  console.error(emptyMessage);
  process.exit(1);
}

export function resolveRef(ref: string, need: 'both'): Promise<ResolvedRefBoth>;
// eslint-disable-next-line no-redeclare
export function resolveRef(ref: string, need: 'issue' | 'pr'): Promise<ResolvedRef>;
// eslint-disable-next-line no-redeclare
export async function resolveRef(ref: string, need: 'issue' | 'pr' | 'both'): Promise<ResolvedRef> {
  // Try as PR first — GitHub treats PRs as issues, so `gh issue view` succeeds
  // for PR numbers. Checking `gh pr view` first avoids misclassifying PRs.
  try {
    const result = await gh(['pr', 'view', ref, '--json', 'number,body']);
    const output = result.stdout.trim();
    const prData = JSON.parse(output) as { number: number; body: string };
    const prNumber = String(prData.number);
    const match = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i.exec(prData.body);
    const linkedIssue = match?.[1];
    if (!linkedIssue && (need === 'issue' || need === 'both')) {
      console.error(
        `PR #${ref} has no linked issue. Ensure the PR body references an issue (e.g., 'Closes #42').`
      );
      process.exit(1);
    }
    return { issueNumber: linkedIssue ?? ref, prNumber };
  } catch {
    // Not a PR — try as issue
  }

  try {
    await gh(['issue', 'view', ref, '--json', 'number']);
    // ref is an issue number
    let prNumber: string | undefined;
    if (need === 'pr' || need === 'both') {
      prNumber = await tryResolvePrForIssue(Number(ref));
      if (!prNumber) {
        console.error(`No open PR found for issue #${ref}. Run 'shipper pr open ${ref}' first.`);
        process.exit(1);
      }
    }
    return { issueNumber: ref, prNumber };
  } catch {
    // Not an issue either
  }

  console.error(`Could not find issue or PR matching '${ref}'.`);
  process.exit(1);
}
