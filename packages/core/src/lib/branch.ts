import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function getRepoRoot(): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf-8',
  });
  return stdout.trim();
}

export async function generateBranchName(issueRef: string): Promise<string> {
  const num = issueRef.replace(/^#/, '');

  let title: string;
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['issue', 'view', num, '--json', 'title', '--jq', '.title'],
      {
        encoding: 'utf-8',
      }
    );
    title = stdout.trim();
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

export async function findBranchForIssue(issueRef: string): Promise<string> {
  const num = issueRef.replace(/^#/, '');

  // Fetch to ensure local remote-tracking refs are up to date (e.g. after a
  // push from a sandboxed agent that couldn't update local tracking metadata).
  try {
    await execFileAsync('git', ['fetch', 'origin', '--prune']);
  } catch {
    // Best-effort — fall through to branch lookup with stale refs
  }

  const { stdout } = await execFileAsync(
    'git',
    ['branch', '-r', '--list', `origin/shipper/${num}-*`],
    {
      encoding: 'utf-8',
    }
  );
  const output = stdout.trim();

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

export async function getBranchForPR(prRef: string): Promise<string> {
  const { stdout } = await execFileAsync('gh', ['pr', 'view', prRef, '--json', 'headRefName'], {
    encoding: 'utf-8',
  });
  const data: { headRefName: string } = JSON.parse(stdout);
  return data.headRefName;
}
