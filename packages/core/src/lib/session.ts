import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
const UNLINKED_REPO = '_unlinked';

export interface SessionMeta {
  repo: string;
  issue: string;
  stage: string;
  agent: string;
  model: string;
  timestamp: string;
  exitCode: number;
  logFile: string;
}

export interface SessionRepoInfo {
  repo: string;
  repoSlug: string;
}

export function getSessionDir(repoSlug: string): string {
  return path.join(homedir(), '.shipper', 'sessions', repoSlug);
}

export function getSessionPaths(
  repoSlug: string,
  issue: string | undefined,
  stage: string,
  timestamp: Date = new Date()
): { logFile: string; metaFile: string } {
  const timestampToken = timestamp.toISOString().replace(/[:.]/g, '-');
  const issueToken = issue ?? 'unlinked';
  const basename = `${issueToken}-${stage}-${timestampToken}`;

  return {
    logFile: path.join(getSessionDir(repoSlug), `${basename}.jsonl`),
    metaFile: path.join(getSessionDir(repoSlug), `${basename}.meta.json`),
  };
}

export async function resolveSessionRepo(opts: {
  repo?: string;
  cwd?: string;
}): Promise<SessionRepoInfo> {
  if (opts.repo) {
    return {
      repo: opts.repo,
      repoSlug: toRepoSlug(opts.repo),
    };
  }

  try {
    const stdout = await getRemoteUrl(opts.cwd);
    const repo = parseRepoFromRemote(stdout);
    if (repo) {
      return {
        repo,
        repoSlug: toRepoSlug(repo),
      };
    }
  } catch {
    // Fall through to the unlinked sentinel when git resolution is unavailable.
  }

  return {
    repo: UNLINKED_REPO,
    repoSlug: UNLINKED_REPO,
  };
}

export async function writeSessionMeta(metaFile: string, meta: SessionMeta): Promise<void> {
  await mkdir(path.dirname(metaFile), { recursive: true });
  await writeFile(metaFile, `${JSON.stringify(meta, null, 2)}\n`, 'utf-8');
}

function parseRepoFromRemote(remote: string): string | undefined {
  const match = remote.trim().match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  return match?.[1];
}

function getRemoteUrl(cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['remote', 'get-url', 'origin'], { cwd }, (error, stdout) => {
      if (error) {
        reject(error instanceof Error ? error : new Error(toErrorMessage(error)));
        return;
      }
      resolve(stdout);
    });
  });
}

function toRepoSlug(repo: string): string {
  return repo.replaceAll('/', '-');
}

function toErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (typeof error === 'number' || typeof error === 'boolean') return String(error);
  if (
    (typeof error === 'object' || typeof error === 'function') &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message;
  }
  return 'Failed to resolve git remote URL';
}
