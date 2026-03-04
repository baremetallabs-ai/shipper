import { execFileSync } from 'node:child_process';

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

export function getRepoNwo(): string {
  try {
    return execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      'Error: Could not determine repository. Run this command from inside a GitHub repository.'
    );
    console.error(`Underlying error: ${msg}`);
    process.exit(1);
  }
}

export function tryResolvePrForIssue(issueNumber: number): string | undefined {
  try {
    const output = execFileSync(
      'gh',
      ['pr', 'list', '--search', String(issueNumber), '--state', 'open', '--json', 'number'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    const prs = JSON.parse(output) as { number: number }[];
    if (Array.isArray(prs) && prs.length > 0) {
      return String(prs[0]!.number);
    }
    return undefined;
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

export function selectIssuesForStage(label: string): { number: number; title: string }[] {
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
        '-label:shipper:blocked -label:shipper:locked',
        '--json',
        'number,title',
      ],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    issues = JSON.parse(output) as { number: number; title: string }[];
  } catch {
    return [];
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

export function autoSelectIssue(label: string): { number: number; title: string } | null {
  const issues = selectIssuesForStage(label);
  return issues[0] ?? null;
}

export function autoSelectPrForStage(
  label: string,
  emptyMessage: string
): { pr: string; issue: { number: number; title: string } } {
  const issues = selectIssuesForStage(label);
  for (const issue of issues) {
    const resolved = tryResolvePrForIssue(issue.number);
    if (resolved) {
      return { pr: resolved, issue };
    }
  }
  console.error(emptyMessage);
  process.exit(1);
}

export function resolveRef(ref: string, need: 'issue' | 'pr' | 'both'): ResolvedRef {
  // Try as issue first
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
    // Not an issue — try as PR
  }

  try {
    const output = execFileSync('gh', ['pr', 'view', ref, '--json', 'number,body'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const prData = JSON.parse(output) as { number: number; body: string };
    const match = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i.exec(prData.body);
    const linkedIssue = match?.[1];
    if (!linkedIssue && (need === 'issue' || need === 'both')) {
      console.error(
        `PR #${ref} has no linked issue. Ensure the PR body references an issue (e.g., 'Closes #42').`
      );
      process.exit(1);
    }
    return { issueNumber: linkedIssue ?? ref, prNumber: ref };
  } catch {
    // Not a PR either
  }

  console.error(`Could not find issue or PR matching '${ref}'.`);
  process.exit(1);
}
