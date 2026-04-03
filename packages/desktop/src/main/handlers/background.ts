import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { app, ipcMain } from 'electron';
import { ensureRepoClone, gh, isPlainObject, toErrorMessage } from '@dnsquared/shipper-core';

import type { BackgroundManager } from '../background-manager.js';
import { isPositiveInteger, parseAdoptIssuePayload, parseRepo } from './shared.js';

interface SpawnBackgroundCommandPayload {
  repo: string;
}

interface SpawnBackgroundNewPayload extends SpawnBackgroundCommandPayload {
  request: string;
}

interface SpawnBackgroundShipPayload extends SpawnBackgroundCommandPayload {
  issueNumber: number;
  merge: boolean;
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

  const payload = parseSpawnBackgroundCommandPayload(value);
  if (payload === null || !isPositiveInteger(value.issueNumber)) {
    return null;
  }

  return {
    ...payload,
    issueNumber: value.issueNumber,
    merge: 'merge' in value && typeof value.merge === 'boolean' ? value.merge : false,
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

async function resolveCreatedIssueMeta(
  repo: string,
  spawnedAt: number | null
): Promise<{ issueNumber?: number; issueUrl?: string }> {
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

    return match ? { issueNumber: match.number, issueUrl: match.url } : {};
  } catch {
    console.warn(`[shipper] Failed to find matching created issue for ${repo}`);
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
      },
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
    const parsedPayload = parseAdoptIssuePayload(payload);
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
      meta: { issueNumber: parsedPayload.issueNumber },
    });
  });

  ipcMain.handle('bg-kill', (_event, payload: unknown) => {
    const parsedPayload = parseSessionIdPayload(payload);
    if (parsedPayload === null) {
      throw new Error('Invalid bg-kill payload.');
    }

    backgroundManager.kill(parsedPayload.sessionId);
  });

  ipcMain.handle('bg-get-output', (_event, payload: unknown) => {
    const parsedPayload = parseSessionIdPayload(payload);
    if (parsedPayload === null) {
      throw new Error('Invalid bg-get-output payload.');
    }

    return backgroundManager.getOutput(parsedPayload.sessionId);
  });
}
