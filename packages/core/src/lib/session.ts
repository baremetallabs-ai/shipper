import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { hasErrorCode, toError, toErrorMessage } from './errors.js';
import { logger } from './logger.js';
import type { NewResultJson } from './result-schema.js';
import type { TokenUsage } from './usage.js';

export const SHIPPER_SESSION_RUN_ID_ENV = 'SHIPPER_SESSION_RUN_ID';

const UNLINKED_REPO = '_unlinked';

export interface SessionMeta {
  repo: string;
  issue: string;
  stage: string;
  agent: string;
  model: string;
  timestamp: string;
  exitCode: number;
  logFile?: string;
  resultFile?: string;
  runId?: string;
  usage?: TokenUsage;
}

export interface SessionRepoInfo {
  repo: string;
  repoSlug: string;
}

interface SessionMetaMatch {
  meta: SessionMeta;
  metaFile: string;
}

export function getSessionDir(repoSlug: string): string {
  return path.join(homedir(), '.shipper', 'sessions', repoSlug);
}

export function getSessionPaths(
  repoSlug: string,
  issue: string | undefined,
  stage: string,
  timestamp: Date = new Date()
): { logFile: string; metaFile: string; resultFile: string } {
  const timestampToken = timestamp.toISOString().replace(/[:.]/g, '-');
  const issueToken = issue ?? 'unlinked';
  const basename = `${issueToken}-${stage}-${timestampToken}`;

  return {
    logFile: path.join(getSessionDir(repoSlug), `${basename}.jsonl`),
    metaFile: path.join(getSessionDir(repoSlug), `${basename}.meta.json`),
    resultFile: path.join(getSessionDir(repoSlug), `${basename}.result.json`),
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

export async function aggregateSessionUsage(
  repo: string,
  issue: string,
  since: Date
): Promise<TokenUsage | undefined> {
  return aggregateSessionUsageImpl(repo, issue, since);
}

export async function aggregateAllIssueUsage(repo: string): Promise<Map<string, TokenUsage>> {
  const sessionDir = getSessionDir(toRepoSlug(repo));
  let entries: string[];
  try {
    entries = await readdir(sessionDir);
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) {
      logger.warn(`Failed to read session directory for ${repo}`);
    }
    return new Map();
  }

  const totals = new Map<string, TokenUsage>();
  const parsedEntries = await Promise.all(
    entries
      .filter((entry) => entry.endsWith('.meta.json'))
      .map(async (entry) => {
        try {
          return JSON.parse(await readFile(path.join(sessionDir, entry), 'utf-8')) as unknown;
        } catch {
          return undefined;
        }
      })
  );

  for (const parsed of parsedEntries) {
    if (!isSessionMeta(parsed)) {
      continue;
    }

    const usage = parseUsage(parsed.usage);
    if (!usage) {
      continue;
    }

    totals.set(parsed.issue, sumTokenUsage(totals.get(parsed.issue), usage));
  }

  return totals;
}

export async function findLatestSessionMeta(opts: {
  repoSlug: string;
  issue: string;
  stage: string;
  since: Date;
  runId?: string;
}): Promise<SessionMeta | undefined> {
  return (await findLatestSessionMetaMatch(opts))?.meta;
}

async function findLatestSessionMetaMatch(opts: {
  repoSlug: string;
  issue: string;
  stage: string;
  since: Date;
  runId?: string;
}): Promise<SessionMetaMatch | undefined> {
  const sessionDir = getSessionDir(opts.repoSlug);
  let entries: string[];
  try {
    entries = await readdir(sessionDir);
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) {
      logger.warn(`Failed to read session directory for ${opts.repoSlug}/${opts.issue}`);
    }
    return undefined;
  }

  const prefix = `${opts.issue}-${opts.stage}-`;
  const matchingEntries = entries
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith('.meta.json'))
    .sort()
    .reverse();

  for (const entry of matchingEntries) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path.join(sessionDir, entry), 'utf-8'));
    } catch {
      continue;
    }

    if (!isSessionMeta(parsed) || parsed.issue !== opts.issue || parsed.stage !== opts.stage) {
      continue;
    }

    if (opts.runId !== undefined && parsed.runId !== opts.runId) {
      continue;
    }

    const timestamp = new Date(parsed.timestamp);
    const time = timestamp.getTime();
    if (Number.isNaN(time)) {
      continue;
    }

    if (timestamp < opts.since) {
      break;
    }

    return {
      meta: parsed,
      metaFile: path.join(sessionDir, entry),
    };
  }

  return undefined;
}

export async function persistNewResultForLatestSession(opts: {
  repo: string;
  cwd?: string;
  since: Date;
  runId?: string;
  result: NewResultJson;
}): Promise<string> {
  const sessionRepo = await resolveSessionRepo({ repo: opts.repo, cwd: opts.cwd });
  const match = await findLatestSessionMetaMatch({
    repoSlug: sessionRepo.repoSlug,
    issue: 'unlinked',
    stage: 'new',
    since: opts.since,
    ...(opts.runId === undefined ? {} : { runId: opts.runId }),
  });

  if (!match) {
    throw new Error(
      `Could not find session metadata for ${sessionRepo.repo} unlinked/new at or after ${opts.since.toISOString()}`
    );
  }

  const resultFile =
    match.meta.resultFile ?? match.metaFile.replace(/\.meta\.json$/, '.result.json');

  try {
    await mkdir(path.dirname(resultFile), { recursive: true });
    await writeFile(resultFile, `${JSON.stringify(opts.result, null, 2)}\n`, 'utf-8');
  } catch (error) {
    throw new Error(
      `Failed to persist created_issue result to ${resultFile}: ${toErrorMessage(error)}`
    );
  }

  try {
    await writeSessionMeta(match.metaFile, {
      ...match.meta,
      resultFile,
    });
  } catch (error) {
    throw new Error(
      `Failed to update session metadata with created_issue result at ${match.metaFile}: ${toErrorMessage(error)}`
    );
  }

  return resultFile;
}

async function aggregateSessionUsageDefault(
  repo: string,
  issue: string,
  since: Date
): Promise<TokenUsage | undefined> {
  const sessionDir = getSessionDir(toRepoSlug(repo));
  let entries: string[];
  try {
    entries = await readdir(sessionDir);
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) {
      logger.warn(`Failed to read session directory for ${repo}/${issue}`);
    }
    return undefined;
  }

  let total: TokenUsage | undefined;

  for (const entry of entries) {
    if (!entry.startsWith(`${issue}-`) || !entry.endsWith('.meta.json')) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path.join(sessionDir, entry), 'utf-8'));
    } catch {
      // Malformed session meta file — skip to next.
      continue;
    }

    if (!isSessionMeta(parsed)) {
      continue;
    }

    if (parsed.issue !== issue) {
      continue;
    }

    const timestamp = new Date(parsed.timestamp);
    if (Number.isNaN(timestamp.getTime()) || timestamp < since) {
      continue;
    }

    const usage = parseUsage(parsed.usage);
    if (!usage) {
      continue;
    }

    total = sumTokenUsage(total, usage);
  }

  return total;
}

let aggregateSessionUsageImpl: typeof aggregateSessionUsageDefault = aggregateSessionUsageDefault;

export function __setAggregateSessionUsageImpl(
  next?: typeof aggregateSessionUsageDefault
): typeof aggregateSessionUsageDefault {
  const previous = aggregateSessionUsageImpl;
  aggregateSessionUsageImpl = next ?? aggregateSessionUsageDefault;
  return previous;
}

function parseRepoFromRemote(remote: string): string | undefined {
  const match = remote.trim().match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  return match?.[1];
}

function getRemoteUrl(cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['remote', 'get-url', 'origin'], { cwd }, (error, stdout) => {
      if (error) {
        reject(toError(error));
        return;
      }
      resolve(stdout);
    });
  });
}

function toRepoSlug(repo: string): string {
  return repo.replaceAll('/', '-');
}

function isSessionMeta(value: unknown): value is SessionMeta {
  return (
    typeof value === 'object' &&
    value !== null &&
    'issue' in value &&
    typeof value.issue === 'string' &&
    'timestamp' in value &&
    typeof value.timestamp === 'string'
  );
}

function parseUsage(value: unknown): TokenUsage | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const usage = value as Record<string, unknown>;
  const inputTokens = usage.inputTokens;
  const outputTokens = usage.outputTokens;
  const cacheReadTokens = usage.cacheReadTokens;
  const cacheWriteTokens = usage.cacheWriteTokens;

  if (
    !isFiniteNumber(inputTokens) ||
    !isFiniteNumber(outputTokens) ||
    !isFiniteNumber(cacheReadTokens) ||
    !isFiniteNumber(cacheWriteTokens)
  ) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

function sumTokenUsage(current: TokenUsage | undefined, next: TokenUsage): TokenUsage {
  if (!current) {
    return { ...next };
  }

  return {
    inputTokens: current.inputTokens + next.inputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
    cacheReadTokens: current.cacheReadTokens + next.cacheReadTokens,
    cacheWriteTokens: current.cacheWriteTokens + next.cacheWriteTokens,
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
