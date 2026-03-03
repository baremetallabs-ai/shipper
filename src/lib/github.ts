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
  } catch {
    console.error('Error: Could not determine repository.');
    process.exit(1);
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
