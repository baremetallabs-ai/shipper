import { access, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { gh } from './gh.js';

const REPOS_DIR = path.join(homedir(), '.shipper', 'repos');

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
    await gh(['repo', 'sync', '--source', repo], { cwd: clonePath });
    return clonePath;
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
