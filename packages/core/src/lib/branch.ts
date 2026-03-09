import { execFileSync } from 'node:child_process';

export function getRepoRoot(): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim();
}

export function generateBranchName(issueRef: string): string {
  const num = issueRef.replace(/^#/, '');

  let title: string;
  try {
    title = execFileSync('gh', ['issue', 'view', num, '--json', 'title', '--jq', '.title'], {
      encoding: 'utf-8',
    }).trim();
  } catch {
    title = '';
  }

  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50)
    .replace(/-$/, '');

  if (slug) {
    return `shipper/${num}-${slug}`;
  }
  return `shipper/${num}-implement`;
}

export function findBranchForIssue(issueRef: string): string {
  const num = issueRef.replace(/^#/, '');

  // Fetch to ensure local remote-tracking refs are up to date (e.g. after a
  // push from a sandboxed agent that couldn't update local tracking metadata).
  try {
    execFileSync('git', ['fetch', 'origin', '--prune'], { stdio: 'ignore' });
  } catch {
    // Best-effort — fall through to branch lookup with stale refs
  }

  const output = execFileSync('git', ['branch', '-r', '--list', `origin/shipper/${num}-*`], {
    encoding: 'utf-8',
  }).trim();

  if (!output) {
    throw new Error(
      `No remote branch found matching origin/shipper/${num}-*.\n` +
        `Run \`shipper implement ${issueRef}\` first to create one.`
    );
  }

  const branches = output
    .split('\n')
    .map((b) => b.trim())
    .filter(Boolean);

  if (branches.length > 1) {
    throw new Error(
      `Multiple branches found for issue ${issueRef}:\n` +
        branches.map((b) => `  ${b}`).join('\n') +
        '\nPlease specify the branch directly.'
    );
  }

  // Strip "origin/" prefix
  const branch = branches[0];
  if (!branch) {
    throw new Error(`No remote branch found matching origin/shipper/${num}-*.`);
  }
  return branch.replace(/^origin\//, '');
}

export function getBranchForPR(prRef: string): string {
  const json = execFileSync('gh', ['pr', 'view', prRef, '--json', 'headRefName'], {
    encoding: 'utf-8',
  });
  const data: { headRefName: string } = JSON.parse(json);
  return data.headRefName;
}
