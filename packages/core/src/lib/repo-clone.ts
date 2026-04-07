import { execFile } from 'node:child_process';
import { access, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { gh } from './gh.js';
import { logger } from './logger.js';

const REPOS_DIR = path.join(homedir(), '.shipper', 'repos');
const execFileAsync = promisify(execFile);
const INVALID_WORKTREE_PATTERNS = [/not a git repository/i, /invalid gitfile format/i];

/**
 * Returns the local clone path for a GitHub repo (e.g. `owner/repo`).
 * The clone lives at `~/.shipper/repos/<owner>/<repo>/`.
 */
export function getRepoClonePath(repo: string): string {
  return path.join(REPOS_DIR, repo);
}

/**
 * Ensures a shallow clone of the given GitHub repo exists at
 * `~/.shipper/repos/<owner>/<repo>/`. If the clone already exists,
 * it is fetched to pick up new branches and refs.
 *
 * Returns the absolute path to the local clone.
 */
export async function ensureRepoClone(repo: string): Promise<string> {
  const clonePath = getRepoClonePath(repo);

  if (await exists(clonePath)) {
    if (await isValidWorktree(clonePath)) {
      await gh(['repo', 'sync', '--source', repo], { cwd: clonePath });
      return clonePath;
    }

    logger.warn(`Clone at ${clonePath} is not a valid git worktree, removing and re-cloning`);
    await rm(clonePath, { recursive: true, force: true });
  }

  await mkdir(path.dirname(clonePath), { recursive: true });
  await gh(['repo', 'clone', repo, clonePath]);

  return clonePath;
}

async function exists(dir: string): Promise<boolean> {
  try {
    await access(dir);
    return true;
  } catch {
    // Directory doesn't exist — not cloned yet.
    return false;
  }
}

async function isValidWorktree(dir: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: dir,
      encoding: 'utf-8',
    });
    return stdout.trim() === 'true';
  } catch (error) {
    if (isInvalidWorktreeProbeError(error)) {
      return false;
    }

    throw error;
  }
}

function isInvalidWorktreeProbeError(error: unknown): boolean {
  return INVALID_WORKTREE_PATTERNS.some((pattern) => pattern.test(getErrorStderr(error)));
}

function getErrorStderr(error: unknown): string {
  return typeof error === 'object' &&
    error !== null &&
    'stderr' in error &&
    typeof error.stderr === 'string'
    ? error.stderr
    : '';
}
