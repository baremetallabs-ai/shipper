import { execFileSync } from 'node:child_process';
import { isLockStale, releaseIssueLock } from './lock.js';
import { getRepoNwo } from './repo.js';

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

export function resolveBaseBranch(configured?: string): string {
  if (configured) {
    let result: string;
    try {
      result = execFileSync('git', ['ls-remote', '--heads', 'origin', configured], {
        encoding: 'utf-8',
      });
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
    output = execFileSync(
      'gh',
      ['repo', 'view', '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name'],
      { encoding: 'utf-8' }
    );
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

export function fetchIssue(ref: string): string {
  let json: string;
  try {
    json = execFileSync(
      'gh',
      ['issue', 'view', ref, '--json', 'number,title,state,labels,body,comments,author,createdAt'],
      { encoding: 'utf-8' }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: Failed to fetch issue ${ref}: ${msg}`);
    process.exit(1);
  }

  const data: IssueData = JSON.parse(json);
  return formatIssue(data);
}

export function fetchPR(ref: string): string {
  let json: string;
  try {
    json = execFileSync(
      'gh',
      [
        'pr',
        'view',
        ref,
        '--json',
        'number,title,state,labels,body,comments,author,createdAt,headRefName,baseRefName,reviews',
      ],
      { encoding: 'utf-8' }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: Failed to fetch PR ${ref}: ${msg}`);
    process.exit(1);
  }

  const data: PRData = JSON.parse(json);
  return formatPR(data);
}

export function formatIssue(data: IssueData): string {
  const labels = data.labels.map((l) => l.name).join(', ') || 'none';
  const lines: string[] = [
    `# Issue #${data.number}: ${data.title}`,
    `**State:** ${data.state} | **Labels:** ${labels} | **Author:** @${data.author.login} | **Created:** ${data.createdAt}`,
    '',
    '## Body',
    '',
    data.body || '*No description provided.*',
  ];

  if (data.comments.length > 0) {
    lines.push('', '## Comments', '');
    for (const c of data.comments) {
      lines.push(`### @${c.author.login} — ${c.createdAt}`, '', c.body, '');
    }
  }

  return lines.join('\n');
}

export function tryResolvePrForIssue(issueNumber: number): string | undefined {
  try {
    const output = execFileSync(
      'gh',
      ['pr', 'list', '--state', 'open', '--json', 'number,headRefName', '--limit', '100'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
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
  const lines: string[] = [
    `# PR #${data.number}: ${data.title}`,
    `**State:** ${data.state} | **Labels:** ${labels} | **Author:** @${data.author.login} | **Created:** ${data.createdAt}`,
    `**Branch:** ${data.headRefName} → ${data.baseRefName}`,
    '',
    '## Body',
    '',
    data.body || '*No description provided.*',
  ];

  if (data.reviews.length > 0) {
    lines.push('', '## Reviews', '');
    for (const r of data.reviews) {
      lines.push(
        `### @${r.author.login} — ${r.state} — ${r.submittedAt}`,
        '',
        r.body || '*No review body.*',
        ''
      );
    }
  }

  if (data.comments.length > 0) {
    lines.push('', '## Comments', '');
    for (const c of data.comments) {
      lines.push(`### @${c.author.login} — ${c.createdAt}`, '', c.body, '');
    }
  }

  return lines.join('\n');
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

export function selectIssuesForStage(
  label: string,
  staleLocked?: Set<number>
): { number: number; title: string }[] {
  const issueSearchFilter =
    label === 'shipper:new'
      ? '-label:shipper:locked'
      : '-label:shipper:blocked -label:shipper:locked';
  const lockedSearchFilter = label === 'shipper:new' ? null : '-label:shipper:blocked';
  let issues: { number: number; title: string }[];
  try {
    const output = execFileSync(
      'gh',
      [
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
      ],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    issues = JSON.parse(output) as { number: number; title: string }[];
  } catch {
    return [];
  }

  // Fetch locked issues for the same stage and check for stale locks
  try {
    const lockedOutput = execFileSync(
      'gh',
      [
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
      ],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    const lockedIssues = JSON.parse(lockedOutput) as { number: number; title: string }[];
    for (const issue of lockedIssues) {
      if (isLockStale(String(issue.number))) {
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

  const nwo = getRepoNwo();
  const timelinesByIssue = new Map<number, TimelineLabelEvent[]>();

  for (const issue of issues) {
    try {
      const output = execFileSync(
        'gh',
        [
          'api',
          `repos/${nwo}/issues/${issue.number}/timeline`,
          '--paginate',
          '--jq',
          '.[] | select(.event == "labeled") | {event, label, created_at}',
        ],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
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

export function clearStaleLockIfNeeded(issueNumber: number, staleLocked: Set<number>): void {
  if (staleLocked.has(issueNumber)) {
    console.error(`Issue #${issueNumber} lock is stale — clearing.`);
    releaseIssueLock(String(issueNumber));
  }
}

export function autoSelectIssue(label: string): { number: number; title: string } | null {
  const staleLocked = new Set<number>();
  const issues = selectIssuesForStage(label, staleLocked);
  const candidate = issues[0] ?? null;
  if (candidate) {
    clearStaleLockIfNeeded(candidate.number, staleLocked);
  }
  return candidate;
}

export function autoSelectPrForStage(
  label: string,
  emptyMessage: string
): { pr: string; issue: { number: number; title: string } } {
  const staleLocked = new Set<number>();
  const issues = selectIssuesForStage(label, staleLocked);
  for (const issue of issues) {
    const resolved = tryResolvePrForIssue(issue.number);
    if (resolved) {
      clearStaleLockIfNeeded(issue.number, staleLocked);
      return { pr: resolved, issue };
    }
  }
  console.error(emptyMessage);
  process.exit(1);
}

export function resolveRef(ref: string, need: 'both'): ResolvedRefBoth;
// eslint-disable-next-line no-redeclare
export function resolveRef(ref: string, need: 'issue' | 'pr'): ResolvedRef;
// eslint-disable-next-line no-redeclare
export function resolveRef(ref: string, need: 'issue' | 'pr' | 'both'): ResolvedRef {
  // Try as PR first — GitHub treats PRs as issues, so `gh issue view` succeeds
  // for PR numbers. Checking `gh pr view` first avoids misclassifying PRs.
  try {
    const output = execFileSync('gh', ['pr', 'view', ref, '--json', 'number,body'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
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
    execFileSync('gh', ['issue', 'view', ref, '--json', 'number'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // ref is an issue number
    let prNumber: string | undefined;
    if (need === 'pr' || need === 'both') {
      prNumber = tryResolvePrForIssue(Number(ref));
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
