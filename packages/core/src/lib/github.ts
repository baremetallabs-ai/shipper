import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gh } from './gh.js';
import { isLockStale, releaseIssueLock } from './lock.js';

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

export interface ListIssueItem {
  number: number;
  title: string;
  labels: string[];
  state: string;
  author: string;
  createdAt: string;
}

export interface ListIssuesOptions {
  label?: string;
  state?: 'open' | 'closed' | 'all';
}

interface RawListIssueData {
  number: number;
  title: string;
  state: string;
  labels: { name: string }[];
  author: { login: string };
  createdAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasName(value: unknown): value is { name: string } {
  return isRecord(value) && typeof value.name === 'string';
}

function hasLogin(value: unknown): value is { login: string } {
  return isRecord(value) && typeof value.login === 'string';
}

function isIssueComment(value: unknown): value is IssueComment {
  return (
    isRecord(value) &&
    hasLogin(value.author) &&
    typeof value.body === 'string' &&
    typeof value.createdAt === 'string'
  );
}

function isReviewComment(value: unknown): value is ReviewComment {
  return (
    isRecord(value) &&
    hasLogin(value.author) &&
    typeof value.body === 'string' &&
    typeof value.state === 'string' &&
    typeof value.submittedAt === 'string'
  );
}

function isIssueData(value: unknown): value is IssueData {
  return (
    isRecord(value) &&
    typeof value.number === 'number' &&
    typeof value.title === 'string' &&
    typeof value.state === 'string' &&
    Array.isArray(value.labels) &&
    value.labels.every(hasName) &&
    typeof value.body === 'string' &&
    Array.isArray(value.comments) &&
    value.comments.every(isIssueComment) &&
    hasLogin(value.author) &&
    typeof value.createdAt === 'string'
  );
}

function isPRData(value: unknown): value is PRData {
  if (!isIssueData(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.headRefName === 'string' &&
    typeof record.baseRefName === 'string' &&
    Array.isArray(record.reviews) &&
    record.reviews.every(isReviewComment)
  );
}

function parseIssueData(json: string): IssueData {
  const parsed = JSON.parse(json) as unknown;
  if (!isIssueData(parsed)) {
    throw new Error('Invalid issue response from GitHub CLI.');
  }

  return parsed;
}

function parsePRData(json: string): PRData {
  const parsed = JSON.parse(json) as unknown;
  if (!isPRData(parsed)) {
    throw new Error('Invalid PR response from GitHub CLI.');
  }

  return parsed;
}

export async function resolveBaseBranch(repo: string, configured?: string): Promise<string> {
  if (configured) {
    let result: string;
    try {
      const output = await execFileAsync('git', ['ls-remote', '--heads', 'origin', configured], {
        encoding: 'utf-8',
      });
      result = output.stdout;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to check remote branch '${configured}': ${msg}`);
    }
    // ls-remote uses pattern matching, so verify the exact ref is present
    const exactRef = `refs/heads/${configured}`;
    const found = result
      .trim()
      .split('\n')
      .some((line) => line.endsWith(`\t${exactRef}`));
    if (!found) {
      throw new Error(`configured defaultBaseBranch '${configured}' does not exist on remote.`);
    }
    return configured;
  }
  let output: string;
  try {
    const result = await gh([
      'repo',
      'view',
      repo,
      '--json',
      'defaultBranchRef',
      '-q',
      '.defaultBranchRef.name',
    ]);
    output = result.stdout;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to auto-detect default base branch: ${msg}`);
  }
  const branch = output.trim();
  if (!branch) {
    throw new Error('Failed to auto-detect default base branch: received empty branch name.');
  }
  return branch;
}

export async function fetchIssue(repo: string, ref: string): Promise<string> {
  let json: string;
  try {
    const result = await gh([
      'issue',
      'view',
      ref,
      '-R',
      repo,
      '--json',
      'number,title,state,labels,body,comments,author,createdAt',
    ]);
    json = result.stdout;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to fetch issue ${ref}: ${msg}`);
  }

  return formatIssue(parseIssueData(json));
}

export async function fetchPR(repo: string, ref: string): Promise<string> {
  let json: string;
  try {
    const result = await gh([
      'pr',
      'view',
      ref,
      '-R',
      repo,
      '--json',
      'number,title,state,labels,body,comments,author,createdAt,headRefName,baseRefName,reviews',
    ]);
    json = result.stdout;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to fetch PR ${ref}: ${msg}`);
  }

  return formatPR(parsePRData(json));
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export async function listIssues(
  repo: string,
  options?: ListIssuesOptions
): Promise<ListIssueItem[]> {
  const args = [
    'issue',
    'list',
    '-R',
    repo,
    '--json',
    'number,title,labels,state,author,createdAt',
    '--limit',
    '1000',
    '--state',
    options?.state ?? 'open',
  ];

  if (options?.label) {
    args.push('--label', options.label);
  }

  let json: string;
  try {
    const result = await gh(args);
    json = result.stdout;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to list issues for ${repo}: ${msg}`);
  }

  let raw: RawListIssueData[];
  try {
    raw = JSON.parse(json) as RawListIssueData[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const preview = json.length > 200 ? `${json.slice(0, 200)}…` : json;
    throw new Error(`Failed to list issues for ${repo}: ${msg}. Output: ${preview}`);
  }

  const mapped = raw.map((issue) => ({
    number: issue.number,
    title: issue.title,
    labels: issue.labels.map((l) => l.name),
    state: issue.state,
    author: issue.author.login,
    createdAt: issue.createdAt,
  }));

  if (!options?.label) {
    return mapped.filter((issue) => issue.labels.some((l) => l.startsWith('shipper:')));
  }

  return mapped;
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

export async function tryResolvePrForIssue(
  repo: string,
  issueNumber: number
): Promise<string | undefined> {
  try {
    const result = await gh([
      'pr',
      'list',
      '-R',
      repo,
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
    `<pr number="${data.number}" title="${escapeAttr(data.title)}" state="${data.state}" labels="${escapeAttr(labels)}" author="${data.author.login}" created="${data.createdAt}" head="${escapeAttr(data.headRefName)}" base="${escapeAttr(data.baseRefName)}">`,
  ];

  parts.push(data.body ? `<body>\n${data.body}\n</body>` : '<body />');

  if (data.reviews.length > 0) {
    parts.push('<reviews>');
    for (const r of data.reviews) {
      parts.push(
        r.body
          ? `<review author="${r.author.login}" state="${r.state}" date="${r.submittedAt}">\n${r.body}\n</review>`
          : `<review author="${r.author.login}" state="${r.state}" date="${r.submittedAt}"></review>`
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
  repo: string,
  label: string,
  staleLocked?: Set<number>
): Promise<{ number: number; title: string }[]> {
  const issueSearchFilter =
    label === 'shipper:new'
      ? '-label:shipper:locked -label:shipper:failed'
      : '-label:shipper:blocked -label:shipper:locked -label:shipper:failed';
  const lockedSearchFilter =
    label === 'shipper:new'
      ? '-label:shipper:failed'
      : '-label:shipper:blocked -label:shipper:failed';
  let issues: { number: number; title: string }[];
  try {
    const result = await gh([
      'issue',
      'list',
      '-R',
      repo,
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
      '-R',
      repo,
      '--label',
      label,
      '--label',
      'shipper:locked',
      '--state',
      'open',
      '--limit',
      '1000',
      '--search',
      lockedSearchFilter,
      '--json',
      'number,title',
    ]);
    const lockedOutput = result.stdout.trim();
    const lockedIssues = JSON.parse(lockedOutput) as { number: number; title: string }[];
    for (const issue of lockedIssues) {
      if (await isLockStale(repo, String(issue.number))) {
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

  const timelinesByIssue = new Map<number, TimelineLabelEvent[]>();

  for (const issue of issues) {
    try {
      const result = await gh([
        'api',
        `repos/${repo}/issues/${issue.number}/timeline`,
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
  repo: string,
  issueNumber: number,
  staleLocked: Set<number>
): Promise<void> {
  if (staleLocked.has(issueNumber)) {
    console.error(`Issue #${issueNumber} lock is stale — clearing.`);
    await releaseIssueLock(repo, String(issueNumber));
  }
}

export async function autoSelectIssue(
  repo: string,
  label: string
): Promise<{ number: number; title: string } | null> {
  const staleLocked = new Set<number>();
  const issues = await selectIssuesForStage(repo, label, staleLocked);
  const candidate = issues[0] ?? null;
  if (candidate) {
    await clearStaleLockIfNeeded(repo, candidate.number, staleLocked);
  }
  return candidate;
}

export async function autoSelectPrForStage(
  repo: string,
  label: string,
  emptyMessage: string
): Promise<{ pr: string; issue: { number: number; title: string } }> {
  const staleLocked = new Set<number>();
  const issues = await selectIssuesForStage(repo, label, staleLocked);
  for (const issue of issues) {
    const resolved = await tryResolvePrForIssue(repo, issue.number);
    if (resolved) {
      await clearStaleLockIfNeeded(repo, issue.number, staleLocked);
      return { pr: resolved, issue };
    }
  }
  throw new Error(emptyMessage);
}

export function resolveRef(repo: string, ref: string, need: 'both'): Promise<ResolvedRefBoth>;
// eslint-disable-next-line no-redeclare
export function resolveRef(repo: string, ref: string, need: 'issue' | 'pr'): Promise<ResolvedRef>;
// eslint-disable-next-line no-redeclare
export async function resolveRef(
  repo: string,
  ref: string,
  need: 'issue' | 'pr' | 'both'
): Promise<ResolvedRef> {
  // Try as PR first — GitHub treats PRs as issues, so `gh issue view` succeeds
  // for PR numbers. Checking `gh pr view` first avoids misclassifying PRs.
  let prResult: { stdout: string } | undefined;
  try {
    prResult = await gh(['pr', 'view', ref, '-R', repo, '--json', 'number,body']);
  } catch {
    // Not a PR — try as issue below
  }

  if (prResult) {
    const output = prResult.stdout.trim();
    const prData = JSON.parse(output) as { number: number; body: string };
    const prNumber = String(prData.number);
    const match = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i.exec(prData.body);
    const linkedIssue = match?.[1];
    if (!linkedIssue && (need === 'issue' || need === 'both')) {
      throw new Error(
        `PR #${ref} has no linked issue. Ensure the PR body references an issue (e.g., 'Closes #42').`
      );
    }
    return { issueNumber: linkedIssue ?? ref, prNumber };
  }

  let issueFound = false;
  try {
    await gh(['issue', 'view', ref, '-R', repo, '--json', 'number']);
    issueFound = true;
  } catch {
    // Not an issue either
  }

  if (issueFound) {
    let prNumber: string | undefined;
    if (need === 'pr' || need === 'both') {
      prNumber = await tryResolvePrForIssue(repo, Number(ref));
      if (!prNumber) {
        throw new Error(`No open PR found for issue #${ref}. Run 'shipper pr open ${ref}' first.`);
      }
    }
    return { issueNumber: ref, prNumber };
  }

  throw new Error(`Could not find issue or PR matching '${ref}'.`);
}
