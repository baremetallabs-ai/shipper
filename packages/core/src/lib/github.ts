import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { toErrorMessage } from './errors.js';
import { gh } from './gh.js';
import {
  parseIssue,
  parseIssueList,
  parseIssueTitleLabelsList,
  parsePrNumberBodyView,
  parsePrSummaryList,
  parsePullRequest,
  parseTimelineLabelEvent,
  type Issue as IssuePayload,
  type PullRequest as PullRequestPayload,
  type TimelineLabelEventPayload,
} from './gh-schemas.js';
import { getPriorityTier } from './labels.js';
import { isLockStale, releaseIssueLock } from './lock.js';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

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
  url: string;
}

export interface ListIssuesOptions {
  label?: string;
  state?: 'open' | 'closed' | 'all';
}

export interface StageIssueCandidate {
  number: number;
  title: string;
  priority: 0 | 1 | 2;
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
      throw new Error(`Failed to check remote branch '${configured}': ${toErrorMessage(err)}`);
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
    throw new Error(`Failed to auto-detect default base branch: ${toErrorMessage(err)}`);
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
    throw new Error(`Failed to fetch issue ${ref}: ${toErrorMessage(err)}`);
  }

  const data = parseIssue(json);
  return formatIssue(data);
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
    throw new Error(`Failed to fetch PR ${ref}: ${toErrorMessage(err)}`);
  }

  const data = parsePullRequest(json);
  return formatPR(data);
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
    'number,title,labels,state,author,createdAt,url',
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
    throw new Error(`Failed to list issues for ${repo}: ${toErrorMessage(err)}`);
  }

  const raw = parseIssueList(json);
  const mapped = raw.map((issue) => ({
    number: issue.number,
    title: issue.title,
    labels: issue.labels.map((l) => l.name),
    state: issue.state,
    author: issue.author?.login ?? 'ghost',
    createdAt: issue.createdAt,
    url: issue.url,
  }));

  if (!options?.label) {
    return mapped.filter((issue) => issue.labels.some((l) => l.startsWith('shipper:')));
  }

  return mapped;
}

export function formatIssue(data: IssuePayload): string {
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
  let output = '';
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
    output = result.stdout.trim();
  } catch {
    logger.warn(`Failed to resolve PR for issue #${issueNumber}`);
    return undefined;
  }

  const prs = parsePrSummaryList(output);
  const match = prs.find(
    (pr) =>
      pr.headRefName === `shipper/${issueNumber}` ||
      pr.headRefName.startsWith(`shipper/${issueNumber}-`)
  );
  return match ? String(match.number) : undefined;
}

export function formatPR(data: PullRequestPayload): string {
  const labels = data.labels.map((l) => l.name).join(', ') || 'none';
  const parts: string[] = [
    `<pr number="${data.number}" title="${escapeAttr(data.title)}" state="${data.state}" labels="${escapeAttr(labels)}" author="${data.author.login}" created="${data.createdAt}" head="${escapeAttr(data.headRefName)}" base="${escapeAttr(data.baseRefName)}">`,
  ];

  parts.push(data.body ? `<body>\n${data.body}\n</body>` : '<body />');

  if (data.reviews.length > 0) {
    parts.push('<reviews>');
    for (const r of data.reviews) {
      const submittedAt = r.submittedAt ?? '';
      parts.push(
        r.body
          ? `<review author="${r.author.login}" state="${r.state}" date="${submittedAt}">\n${r.body}\n</review>`
          : `<review author="${r.author.login}" state="${r.state}" date="${submittedAt}"></review>`
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

export type TimelineLabelEvent = TimelineLabelEventPayload;

export function sortIssuesByLabelTime<T extends { number: number; title: string }>(
  issues: T[],
  timelinesByIssue: Map<number, TimelineLabelEvent[]>,
  label: string
): T[] {
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

export async function fetchIssueTimelines(
  repo: string,
  issueNumbers: number[]
): Promise<Map<number, TimelineLabelEvent[]>> {
  const timelinesByIssue = new Map<number, TimelineLabelEvent[]>();

  for (const issueNumber of issueNumbers) {
    let output = '';
    try {
      const result = await gh([
        'api',
        `repos/${repo}/issues/${issueNumber}/timeline`,
        '--paginate',
        '--jq',
        '.[] | select(.event == "labeled") | {event, label, created_at}',
      ]);
      output = result.stdout.trim();
    } catch {
      logger.warn(`Failed to fetch timeline for issue #${issueNumber}`);
      timelinesByIssue.set(issueNumber, []);
      continue;
    }

    const events: TimelineLabelEvent[] = output
      ? output.split('\n').map((line) => parseTimelineLabelEvent(line))
      : [];
    timelinesByIssue.set(issueNumber, events);
  }

  return timelinesByIssue;
}

export async function selectIssuesForStage(
  repo: string,
  label: string,
  staleLocked?: Set<number>,
  options?: { skipTimeline?: boolean }
): Promise<StageIssueCandidate[]> {
  const issueSearchFilter =
    label === 'shipper:new'
      ? '-label:shipper:locked -label:shipper:failed'
      : '-label:shipper:blocked -label:shipper:locked -label:shipper:failed';
  const lockedSearchFilter =
    label === 'shipper:new'
      ? '-label:shipper:failed'
      : '-label:shipper:blocked -label:shipper:failed';
  let output = '';
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
      'number,title,labels',
    ]);
    output = result.stdout.trim();
  } catch {
    logger.warn(`Failed to fetch issues for stage ${label}`);
    return [];
  }
  const issues = parseIssueTitleLabelsList(output);

  // Fetch locked issues for the same stage and check for stale locks
  let lockedOutput = '';
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
      'number,title,labels',
    ]);
    lockedOutput = result.stdout.trim();
  } catch {
    logger.error('Warning: Could not check for stale-locked issues. Proceeding without them.');
  }
  const lockedIssues = lockedOutput ? parseIssueTitleLabelsList(lockedOutput) : [];
  for (const issue of lockedIssues) {
    if (await isLockStale(repo, String(issue.number))) {
      issues.push(issue);
      staleLocked?.add(issue.number);
    }
  }

  if (issues.length <= 1 || options?.skipTimeline) {
    return issues
      .map((issue) => ({
        number: issue.number,
        title: issue.title,
        priority: getPriorityTier(issue.labels.map((candidate) => candidate.name)),
      }))
      .sort((a, b) => a.priority - b.priority);
  }

  const timelinesByIssue = await fetchIssueTimelines(
    repo,
    issues.map((issue) => issue.number)
  );
  const sortedIssues = sortIssuesByLabelTime(issues, timelinesByIssue, label);

  return sortedIssues
    .map((issue) => ({
      number: issue.number,
      title: issue.title,
      priority: getPriorityTier(issue.labels.map((candidate) => candidate.name)),
    }))
    .sort((a, b) => a.priority - b.priority);
}

export async function clearStaleLockIfNeeded(
  repo: string,
  issueNumber: number,
  staleLocked: Set<number>
): Promise<void> {
  if (staleLocked.has(issueNumber)) {
    logger.error(`Issue #${issueNumber} lock is stale — clearing.`);
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
    return { number: candidate.number, title: candidate.title };
  }
  return null;
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
      return { pr: resolved, issue: { number: issue.number, title: issue.title } };
    }
  }
  throw new Error(emptyMessage);
}

export function resolveRef(repo: string, ref: string, need: 'both'): Promise<ResolvedRefBoth>;
// TypeScript overload signatures intentionally redeclare the function name before the implementation.
// eslint-disable-next-line no-redeclare
export function resolveRef(repo: string, ref: string, need: 'issue' | 'pr'): Promise<ResolvedRef>;
// TypeScript overload signatures intentionally redeclare the function name before the implementation.
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
    const prData = parsePrNumberBodyView(output);
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
