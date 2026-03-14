import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { gh } from './gh.js';

const execFileAsync = promisify(execFile);

export async function getRepoRoot(): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf-8',
  });
  return stdout.trim();
}

export async function generateBranchName(repo: string, issueRef: string): Promise<string> {
  const num = issueRef.replace(/^#/, '');

  let title: string;
  try {
    const { stdout } = await gh([
      'issue',
      'view',
      num,
      '-R',
      repo,
      '--json',
      'title',
      '--jq',
      '.title',
    ]);
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

  if (output) {
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

    const branch = branches[0];
    if (branch) {
      return branch.replace(/^origin\//, '');
    }
  }

  // Fall back to local branches (e.g. when the implement push failed)
  const { stdout: localOutput } = await execFileAsync(
    'git',
    ['branch', '--list', `shipper/${num}-*`],
    {
      encoding: 'utf-8',
    }
  );
  const localBranches = localOutput
    .trim()
    .split('\n')
    .map((b) => b.trim().replace(/^\* /, ''))
    .filter(Boolean);

  if (localBranches.length === 0) {
    throw new Error(
      `No branch found matching shipper/${num}-*.\n` +
        `Run \`shipper implement ${issueRef}\` first to create one.`
    );
  }

  if (localBranches.length > 1) {
    throw new Error(
      `Multiple local branches found for issue ${issueRef}:\n` +
        localBranches.map((b) => `  ${b}`).join('\n') +
        '\nPlease specify the branch directly.'
    );
  }

  const localBranch = localBranches[0];
  if (!localBranch) {
    throw new Error(`No branch found matching shipper/${num}-*.`);
  }
  return localBranch;
}

export async function getBranchForPR(repo: string, prRef: string): Promise<string> {
  const { stdout } = await gh(['pr', 'view', prRef, '-R', repo, '--json', 'headRefName']);
  const data: { headRefName: string } = JSON.parse(stdout);
  return data.headRefName;
}
