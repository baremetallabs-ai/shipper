import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { app, ipcMain } from 'electron';
import { ensureRepoClone, gh, isPlainObject, toErrorMessage } from '@baremetallabs-ai/shipper-core';

import type { BackgroundManager } from '../background-manager.js';
import { isPositiveInteger, parseRepo } from './shared.js';

interface SpawnBackgroundCommandPayload {
  repo: string;
}

interface SpawnBackgroundNewPayload extends SpawnBackgroundCommandPayload {
  request: string;
}

interface SpawnBackgroundShipPayload extends SpawnBackgroundCommandPayload {
  issueNumber: number;
  merge: boolean;
  origin?: 'auto' | 'manual';
  issueTitle?: string;
}

interface SpawnBackgroundUnblockPayload extends SpawnBackgroundCommandPayload {
  issueNumber: number;
  issueTitle?: string;
}

interface SessionIdPayload {
  sessionId: string;
}

interface RawCreatedIssueData {
  number: number;
  title: string;
  url: string;
  createdAt: string;
}

interface RawPullRequestData {
  number: number;
  headRefName: string;
  state: string;
  mergedAt: string | null;
  createdAt: string;
}

function parseIssueTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseSpawnBackgroundCommandPayload(value: unknown): SpawnBackgroundCommandPayload | null {
  if (typeof value !== 'object' || value === null || !('repo' in value)) {
    return null;
  }

  const repo = parseRepo(value.repo);
  if (repo === null) {
    return null;
  }

  return { repo };
}

function parseSpawnBackgroundNewPayload(value: unknown): SpawnBackgroundNewPayload | null {
  if (typeof value !== 'object' || value === null || !('request' in value)) {
    return null;
  }

  const payload = parseSpawnBackgroundCommandPayload(value);
  if (payload === null || typeof value.request !== 'string') {
    return null;
  }

  return {
    ...payload,
    request: value.request,
  };
}

function parseSpawnBackgroundShipPayload(value: unknown): SpawnBackgroundShipPayload | null {
  if (typeof value !== 'object' || value === null || !('issueNumber' in value)) {
    return null;
  }

  const parsedOrigin =
    'origin' in value && (value.origin === 'auto' || value.origin === 'manual')
      ? value.origin
      : undefined;
  const payload = parseSpawnBackgroundCommandPayload(value);
  if (
    payload === null ||
    !isPositiveInteger(value.issueNumber) ||
    ('origin' in value &&
      value.origin !== undefined &&
      value.origin !== 'auto' &&
      value.origin !== 'manual')
  ) {
    return null;
  }

  return {
    ...payload,
    issueNumber: value.issueNumber,
    merge: 'merge' in value && typeof value.merge === 'boolean' ? value.merge : false,
    origin: parsedOrigin,
    issueTitle: 'issueTitle' in value ? parseIssueTitle(value.issueTitle) : undefined,
  };
}

function parseSpawnBackgroundUnblockPayload(value: unknown): SpawnBackgroundUnblockPayload | null {
  if (typeof value !== 'object' || value === null || !('issueNumber' in value)) {
    return null;
  }

  const payload = parseSpawnBackgroundCommandPayload(value);
  if (payload === null || !isPositiveInteger(value.issueNumber)) {
    return null;
  }

  return {
    ...payload,
    issueNumber: value.issueNumber,
    issueTitle: 'issueTitle' in value ? parseIssueTitle(value.issueTitle) : undefined,
  };
}

function parseSessionIdPayload(value: unknown): SessionIdPayload | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('sessionId' in value) ||
    typeof value.sessionId !== 'string'
  ) {
    return null;
  }

  return {
    sessionId: value.sessionId,
  };
}

function readConfiguredAgentFromSettings(
  filepath: string
): 'claude' | 'codex' | 'copilot' | undefined {
  try {
    const data = JSON.parse(readFileSync(filepath, 'utf8')) as Record<string, unknown>;
    const commands = isPlainObject(data.commands) ? data.commands : undefined;
    const commandDefault = isPlainObject(commands?.default) ? commands.default : undefined;
    const agents = isPlainObject(data.agents) ? data.agents : undefined;

    const configuredAgent =
      typeof commandDefault?.agent === 'string'
        ? commandDefault.agent
        : typeof agents?.default === 'string'
          ? agents.default
          : typeof data.agent === 'string'
            ? data.agent
            : undefined;

    return configuredAgent === 'claude' ||
      configuredAgent === 'codex' ||
      configuredAgent === 'copilot'
      ? configuredAgent
      : undefined;
  } catch {
    // Missing or malformed settings file — fall through to default.
    return undefined;
  }
}

function resolveInitAgent(repoPath: string): 'claude' | 'codex' | 'copilot' {
  const localAgent = readConfiguredAgentFromSettings(
    join(repoPath, '.shipper', 'settings.local.json')
  );
  if (localAgent) {
    return localAgent;
  }

  const storedAgent = readConfiguredAgentFromSettings(join(repoPath, '.shipper', 'settings.json'));
  return storedAgent ?? 'claude';
}

function getRepoSlug(repo: string): string {
  return repo.replaceAll('/', '-');
}

function createDesktopNewLogFile(repo: string): string {
  const sessionsDir = join(app.getPath('home'), '.shipper', 'sessions', getRepoSlug(repo));
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  return join(sessionsDir, `desktop-${randomUUID()}.jsonl`);
}

function parseCreatedIssueList(repo: string, json: string): RawCreatedIssueData[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error('GitHub CLI returned an invalid issue list.');
    }

    return parsed.map((entry) => {
      if (
        !isPlainObject(entry) ||
        typeof entry.number !== 'number' ||
        typeof entry.title !== 'string' ||
        typeof entry.url !== 'string' ||
        typeof entry.createdAt !== 'string'
      ) {
        throw new Error('GitHub CLI returned an invalid created issue payload.');
      }

      return {
        number: entry.number,
        title: entry.title,
        url: entry.url,
        createdAt: entry.createdAt,
      };
    });
  } catch (error) {
    const message = toErrorMessage(error);
    throw new Error(`Failed to parse created issue metadata for ${repo}: ${message}`);
  }
}

function parsePullRequestList(repo: string, json: string): RawPullRequestData[] {
  const trimmed = json.trim();
  if (trimmed.length === 0) {
    throw new Error(`GitHub CLI returned empty pull request metadata for ${repo}.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch (error) {
    const message = toErrorMessage(error);
    throw new Error(`Failed to parse pull request metadata for ${repo}: ${message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `GitHub CLI returned invalid pull request metadata for ${repo}: expected array.`
    );
  }

  return parsed.map((entry, index) => {
    if (
      !isPlainObject(entry) ||
      typeof entry.number !== 'number' ||
      typeof entry.headRefName !== 'string' ||
      typeof entry.state !== 'string' ||
      (entry.mergedAt !== null && typeof entry.mergedAt !== 'string') ||
      typeof entry.createdAt !== 'string'
    ) {
      throw new Error(
        `GitHub CLI returned invalid pull request metadata for ${repo} at index ${index}.`
      );
    }

    return {
      number: entry.number,
      headRefName: entry.headRefName,
      state: entry.state,
      mergedAt: entry.mergedAt,
      createdAt: entry.createdAt,
    };
  });
}

async function resolveCreatedIssueMeta(
  repo: string,
  spawnedAt: number | null
): Promise<{ issueNumber?: number; issueUrl?: string; issueTitle?: string }> {
  if (spawnedAt === null) {
    return {};
  }

  try {
    const result = await gh([
      'issue',
      'list',
      '-R',
      repo,
      '--label',
      'shipper:new',
      '--state',
      'open',
      '--json',
      'number,title,url,createdAt',
      '--limit',
      '20',
    ]);
    const issues = parseCreatedIssueList(repo, result.stdout);
    const spawnedAtIso = new Date(spawnedAt).toISOString();
    const match = issues
      .filter((issue) => issue.createdAt >= spawnedAtIso)
      .sort((left, right) => right.number - left.number)[0];

    return match ? { issueNumber: match.number, issueUrl: match.url, issueTitle: match.title } : {};
  } catch {
    console.warn(`[shipper] Failed to find matching created issue for ${repo}`);
    return {};
  }
}

function getGeneratedIssueBranch(issueNumber: number, issueTitle: string | undefined): string {
  const slug = (issueTitle ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50)
    .replace(/-$/, '');

  return slug ? `shipper/${issueNumber}-${slug}` : `shipper/${issueNumber}-implement`;
}

function getShipPrHeadCandidates(issueNumber: number, issueTitle: string | undefined): string[] {
  return [`shipper/${issueNumber}`, getGeneratedIssueBranch(issueNumber, issueTitle)].filter(
    (branch, index, branches) => branches.indexOf(branch) === index
  );
}

async function listPullRequestsForHead(
  repo: string,
  headRefName: string
): Promise<RawPullRequestData[]> {
  const result = await gh([
    'pr',
    'list',
    '-R',
    repo,
    '--state',
    'all',
    '--head',
    headRefName,
    '--json',
    'number,headRefName,state,mergedAt,createdAt',
    '--limit',
    '20',
  ]);

  return parsePullRequestList(repo, result.stdout);
}

function selectUniqueShipPullRequest(
  repo: string,
  issueNumber: number,
  pullRequests: RawPullRequestData[],
  spawnedAt: number | null
): RawPullRequestData | undefined {
  if (pullRequests.length === 0) {
    console.warn(`[shipper] Failed to find matching shipped PR for ${repo}#${issueNumber}`);
    return undefined;
  }

  if (pullRequests.length === 1) {
    return pullRequests[0];
  }

  if (spawnedAt !== null) {
    const recentPullRequests = pullRequests.filter((pr) => Date.parse(pr.createdAt) >= spawnedAt);
    if (recentPullRequests.length === 1) {
      return recentPullRequests[0];
    }
  }

  const prNumbers = pullRequests.map((pr) => `#${pr.number}`).join(', ');
  console.warn(
    `[shipper] Found ambiguous shipped PR candidates for ${repo}#${issueNumber}: ${prNumbers}`
  );
  return undefined;
}

async function resolveCompletedShipMeta(
  repo: string,
  issueNumber: number | undefined,
  issueTitle: string | undefined,
  merge: boolean | undefined,
  autoShipHalted: boolean | undefined,
  spawnedAt: number | null
): Promise<{ prMerged?: boolean }> {
  if (merge !== true || issueNumber === undefined || autoShipHalted === true) {
    return {};
  }

  try {
    const headCandidates = getShipPrHeadCandidates(issueNumber, issueTitle);
    const pullRequests = (
      await Promise.all(headCandidates.map((head) => listPullRequestsForHead(repo, head)))
    ).flat();
    const uniquePullRequests = [...new Map(pullRequests.map((pr) => [pr.number, pr])).values()];
    const match = selectUniqueShipPullRequest(repo, issueNumber, uniquePullRequests, spawnedAt);

    if (!match) {
      return {};
    }

    return match.state === 'MERGED' || match.mergedAt !== null ? { prMerged: true } : {};
  } catch (error) {
    const message = toErrorMessage(error);
    console.warn(
      `[shipper] Failed to resolve PR merge state for ${repo}#${issueNumber}: ${message}`
    );
    return {};
  }
}

export function registerBackgroundHandlers(backgroundManager: BackgroundManager): void {
  ipcMain.handle('bg-spawn-new', async (_event, payload: unknown) => {
    const parsedPayload = parseSpawnBackgroundNewPayload(payload);
    if (parsedPayload === null) {
      throw new Error('Invalid bg-spawn-new payload.');
    }

    const repoPath = await ensureRepoClone(parsedPayload.repo);
    const logFile = createDesktopNewLogFile(parsedPayload.repo);
    const sessionId = randomUUID();

    return backgroundManager.spawn({
      sessionId,
      command: 'new',
      repo: parsedPayload.repo,
      commandName: 'shipper',
      args: ['new', parsedPayload.request, '--mode', 'headless', '--log-file', logFile],
      cwd: repoPath,
      logFile,
      meta: {
        request: parsedPayload.request,
        logFile,
      },
      onComplete: async (session) => resolveCreatedIssueMeta(parsedPayload.repo, session.spawnedAt),
    });
  });

  ipcMain.handle('bg-spawn-ship', async (_event, payload: unknown) => {
    const parsedPayload = parseSpawnBackgroundShipPayload(payload);
    if (parsedPayload === null) {
      throw new Error('Invalid bg-spawn-ship payload.');
    }

    const repoPath = await ensureRepoClone(parsedPayload.repo);
    const sessionId = randomUUID();
    const args = ['ship', String(parsedPayload.issueNumber), '--mode', 'headless'];
    if (parsedPayload.merge) {
      args.push('--merge');
    }

    return backgroundManager.spawn({
      sessionId,
      command: 'ship',
      repo: parsedPayload.repo,
      commandName: 'shipper',
      args,
      cwd: repoPath,
      meta: {
        issueNumber: parsedPayload.issueNumber,
        merge: parsedPayload.merge,
        ...(parsedPayload.origin ? { origin: parsedPayload.origin } : {}),
        ...(parsedPayload.issueTitle ? { issueTitle: parsedPayload.issueTitle } : {}),
      },
      onComplete: async (session) =>
        resolveCompletedShipMeta(
          parsedPayload.repo,
          parsedPayload.issueNumber,
          parsedPayload.issueTitle,
          parsedPayload.merge,
          session.meta.autoShipHalted,
          session.spawnedAt
        ),
    });
  });

  ipcMain.handle('bg-spawn-init', async (_event, payload: unknown) => {
    const parsedPayload = parseSpawnBackgroundCommandPayload(payload);
    if (parsedPayload === null) {
      throw new Error('Invalid bg-spawn-init payload.');
    }

    const repoPath = await ensureRepoClone(parsedPayload.repo);
    const agent = resolveInitAgent(repoPath);
    const sessionId = randomUUID();

    return backgroundManager.spawn({
      sessionId,
      command: 'init',
      repo: parsedPayload.repo,
      commandName: 'shipper',
      args: ['init', '--agent', agent],
      cwd: repoPath,
    });
  });

  ipcMain.handle('bg-spawn-unblock', async (_event, payload: unknown) => {
    const parsedPayload = parseSpawnBackgroundUnblockPayload(payload);
    if (parsedPayload === null) {
      throw new Error('Invalid bg-spawn-unblock payload.');
    }

    const repoPath = await ensureRepoClone(parsedPayload.repo);
    const sessionId = randomUUID();

    return backgroundManager.spawn({
      sessionId,
      command: 'unblock',
      repo: parsedPayload.repo,
      commandName: 'shipper',
      args: ['unblock', String(parsedPayload.issueNumber), '--mode', 'headless'],
      cwd: repoPath,
      meta: {
        issueNumber: parsedPayload.issueNumber,
        ...(parsedPayload.issueTitle ? { issueTitle: parsedPayload.issueTitle } : {}),
      },
    });
  });

  ipcMain.handle('bg-kill', (_event, payload: unknown) => {
    const parsedPayload = parseSessionIdPayload(payload);
    if (parsedPayload === null) {
      throw new Error('Invalid bg-kill payload.');
    }

    backgroundManager.kill(parsedPayload.sessionId);
  });

  ipcMain.handle('bg-request-pause', (_event, payload: unknown) => {
    const parsedPayload = parseSessionIdPayload(payload);
    if (parsedPayload === null) {
      throw new Error('Invalid bg-request-pause payload.');
    }

    backgroundManager.requestPause(parsedPayload.sessionId);
  });

  ipcMain.handle('bg-request-auto-ship-halt', (_event, payload: unknown) => {
    const parsedPayload = parseSpawnBackgroundCommandPayload(payload);
    if (parsedPayload === null) {
      throw new Error('Invalid bg-request-auto-ship-halt payload.');
    }

    return backgroundManager.requestAutoShipHalt(parsedPayload.repo);
  });

  ipcMain.handle('bg-remove-queued-session', (_event, payload: unknown) => {
    const parsedPayload = parseSessionIdPayload(payload);
    if (parsedPayload === null) {
      throw new Error('Invalid bg-remove-queued-session payload.');
    }

    return backgroundManager.removeQueuedSession(parsedPayload.sessionId);
  });

  ipcMain.handle('bg-get-output', (_event, payload: unknown) => {
    const parsedPayload = parseSessionIdPayload(payload);
    if (parsedPayload === null) {
      throw new Error('Invalid bg-get-output payload.');
    }

    return backgroundManager.getOutput(parsedPayload.sessionId);
  });
}
