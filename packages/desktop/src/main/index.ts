import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, ipcMain } from 'electron';
import {
  buildPromptCommand,
  checkGhAuth,
  checkGhInstalled,
  ensureRepoClone,
  gh,
  listIssues,
  type ListIssueItem,
} from '@dnsquared/shipper-core';

import { PtyManager } from './pty-manager.js';

interface AppConfig {
  repos: string[];
  activeRepo: string;
}

interface ParseConfigResult {
  config: AppConfig;
  changed: boolean;
}

interface ListIssuesSuccess {
  ok: true;
  issues: Awaited<ReturnType<typeof listIssues>>;
}

interface ListIssuesFailure {
  ok: false;
  error: string;
}

interface SpawnPtyPayload {
  repo: string;
  cols: number;
  rows: number;
}

interface SpawnShipperNewPayload extends SpawnPtyPayload {
  request: string;
}

interface SpawnShipperGroomPayload extends SpawnPtyPayload {
  issueNumber: number;
}

interface AdoptIssuePayload {
  repo: string;
  issueNumber: number;
}

interface RawListIssueData {
  number: number;
  title: string;
  state: string;
  labels: { name: string }[];
  author: { login: string } | null;
  createdAt: string;
}

const defaultConfig: AppConfig = { repos: [], activeRepo: '' };
const ptyManager = new PtyManager();
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const preloadPath = fileURLToPath(new URL('../preload/index.cjs', import.meta.url));
const rendererPath = fileURLToPath(new URL('../renderer/index.html', import.meta.url));

function getConfigPath(): string {
  return join(app.getPath('userData'), 'config.json');
}

function readConfig(): AppConfig {
  const configPath = getConfigPath();

  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
    const parsedConfig = parseConfig(parsed);
    if (parsedConfig !== null) {
      if (parsedConfig.changed) {
        writeConfig(parsedConfig.config);
      }

      return parsedConfig.config;
    }

    const legacyRepo =
      typeof parsed === 'object' && parsed !== null && 'repo' in parsed
        ? parseRepo(parsed.repo)
        : null;
    if (legacyRepo !== null) {
      const migratedConfig: AppConfig = {
        repos: [legacyRepo],
        activeRepo: legacyRepo,
      };
      writeConfig(migratedConfig);
      return migratedConfig;
    }

    return defaultConfig;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return defaultConfig;
    }

    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return defaultConfig;
    }

    throw error;
  }
}

function writeConfig(config: AppConfig): void {
  const configPath = getConfigPath();
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

function parseRepo(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const repo = value.trim();
  return repoPattern.test(repo) ? repo : null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function parseSpawnPtyPayload(value: unknown): SpawnPtyPayload | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('repo' in value) ||
    !('cols' in value) ||
    !('rows' in value)
  ) {
    return null;
  }

  const repo = parseRepo(value.repo);
  if (repo === null || !isPositiveInteger(value.cols) || !isPositiveInteger(value.rows)) {
    return null;
  }

  return {
    repo,
    cols: value.cols,
    rows: value.rows,
  };
}

function parseSpawnShipperNewPayload(value: unknown): SpawnShipperNewPayload | null {
  if (typeof value !== 'object' || value === null || !('request' in value)) {
    return null;
  }

  const payload = parseSpawnPtyPayload(value);
  if (payload === null || typeof value.request !== 'string') {
    return null;
  }

  return {
    ...payload,
    request: value.request,
  };
}

function parseSpawnShipperGroomPayload(value: unknown): SpawnShipperGroomPayload | null {
  if (typeof value !== 'object' || value === null || !('issueNumber' in value)) {
    return null;
  }

  const payload = parseSpawnPtyPayload(value);
  if (payload === null || !isPositiveInteger(value.issueNumber)) {
    return null;
  }

  return {
    ...payload,
    issueNumber: value.issueNumber,
  };
}

function parseAdoptIssuePayload(value: unknown): AdoptIssuePayload | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('repo' in value) ||
    !('issueNumber' in value)
  ) {
    return null;
  }

  const repo = parseRepo(value.repo);
  if (repo === null || !isPositiveInteger(value.issueNumber)) {
    return null;
  }

  return {
    repo,
    issueNumber: value.issueNumber,
  };
}

function parseRepoPayload(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('repo' in value)) {
    return null;
  }

  return parseRepo(value.repo);
}

function parseIssueListJson(repo: string, json: string): RawListIssueData[] {
  try {
    return JSON.parse(json) as RawListIssueData[];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const preview = json.length > 200 ? `${json.slice(0, 200)}…` : json;
    throw new Error(`Failed to list adoptable issues for ${repo}: ${message}. Output: ${preview}`);
  }
}

function toRepoKey(repo: string): string {
  return repo.trim().toLowerCase();
}

function parseConfig(value: unknown): ParseConfigResult | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('repos' in value) ||
    !Array.isArray(value.repos) ||
    !('activeRepo' in value)
  ) {
    return null;
  }

  const repos: string[] = [];
  const seenRepos = new Set<string>();
  let changed = false;

  for (const repo of value.repos) {
    const parsedRepo = parseRepo(repo);
    if (parsedRepo === null) {
      return null;
    }

    if (repo !== parsedRepo) {
      changed = true;
    }

    const repoKey = toRepoKey(parsedRepo);
    if (seenRepos.has(repoKey)) {
      changed = true;
      continue;
    }

    seenRepos.add(repoKey);
    repos.push(parsedRepo);
  }

  if (typeof value.activeRepo !== 'string') {
    return null;
  }

  if (repos.length === 0) {
    return {
      config: { repos, activeRepo: '' },
      changed: changed || value.activeRepo.trim().length > 0,
    };
  }

  const fallbackActiveRepo = repos[0];
  if (fallbackActiveRepo === undefined) {
    return {
      config: { repos: [], activeRepo: '' },
      changed: true,
    };
  }

  const parsedActiveRepo = parseRepo(value.activeRepo);
  if (parsedActiveRepo === null) {
    return {
      config: { repos, activeRepo: fallbackActiveRepo },
      changed: true,
    };
  }

  const matchingActiveRepo = repos.find((repo) => toRepoKey(repo) === toRepoKey(parsedActiveRepo));
  if (matchingActiveRepo === undefined) {
    return {
      config: { repos, activeRepo: fallbackActiveRepo },
      changed: true,
    };
  }

  return {
    config: { repos, activeRepo: matchingActiveRepo },
    changed: changed || value.activeRepo !== matchingActiveRepo,
  };
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
    },
  });

  ptyManager.setWindow(window);

  window.on('close', () => {
    ptyManager.destroyAll();
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    void window.loadURL(rendererUrl);
  } else {
    void window.loadFile(rendererPath);
  }

  return window;
}

function registerIpcHandlers(): void {
  ipcMain.handle('check-prerequisites', async () => {
    const ghInstalled = await checkGhInstalled();
    const ghAuth = ghInstalled.ok ? await checkGhAuth() : { ok: false, message: '' };
    return { ghInstalled, ghAuth };
  });

  ipcMain.handle('list-issues', async (_event, payload: unknown) => {
    const repo = parseRepoPayload(payload);

    if (repo === null) {
      const response: ListIssuesFailure = {
        ok: false,
        error: 'Enter a repository in owner/repo format.',
      };
      return response;
    }

    try {
      const issues = await listIssues(repo);
      const response: ListIssuesSuccess = { ok: true, issues };
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const response: ListIssuesFailure = { ok: false, error: message };
      return response;
    }
  });

  ipcMain.handle('list-adoptable-issues', async (_event, payload: unknown) => {
    const repo = parseRepoPayload(payload);

    if (repo === null) {
      const response: ListIssuesFailure = {
        ok: false,
        error: 'Enter a repository in owner/repo format.',
      };
      return response;
    }

    try {
      const result = await gh([
        'issue',
        'list',
        '-R',
        repo,
        '--state',
        'open',
        '--limit',
        '1000',
        '--json',
        'number,title,labels,state,author,createdAt',
      ]);
      const rawIssues = parseIssueListJson(repo, result.stdout);
      const issues: ListIssueItem[] = rawIssues
        .map((issue) => ({
          number: issue.number,
          title: issue.title,
          labels: issue.labels.map((label) => label.name),
          state: issue.state,
          author: issue.author?.login ?? 'ghost',
          createdAt: issue.createdAt,
        }))
        .filter((issue) => !issue.labels.some((label) => label.startsWith('shipper:')));
      const response: ListIssuesSuccess = { ok: true, issues };
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const response: ListIssuesFailure = { ok: false, error: message };
      return response;
    }
  });

  ipcMain.handle('get-config', () => readConfig());
  ipcMain.handle('list-repos', async () => {
    const result = await gh(['repo', 'list', '--json', 'nameWithOwner', '--limit', '100']);
    const parsed = JSON.parse(result.stdout) as Array<{ nameWithOwner: string }>;
    return parsed.map((repo) => repo.nameWithOwner);
  });
  ipcMain.handle('set-config', (_event, config: unknown) => {
    const parsedConfig = parseConfig(config);
    if (parsedConfig === null) {
      throw new Error('Invalid config payload.');
    }

    writeConfig(parsedConfig.config);
  });

  ipcMain.handle('pty-spawn-shipper-new', async (_event, payload: unknown) => {
    const parsedPayload = parseSpawnShipperNewPayload(payload);
    if (parsedPayload === null) {
      throw new Error('Invalid pty-spawn-shipper-new payload.');
    }

    const repoPath = await ensureRepoClone(parsedPayload.repo);

    const cmd = await buildPromptCommand('new', {
      userInput: parsedPayload.request,
      repo: parsedPayload.repo,
      mode: 'interactive',
    });

    const sessionId = randomUUID();
    ptyManager.spawn(sessionId, cmd.command, cmd.args, {
      cols: parsedPayload.cols,
      rows: parsedPayload.rows,
      cwd: cmd.cwd ?? repoPath,
    });

    return { sessionId };
  });

  ipcMain.handle('pty-spawn-shipper-groom', async (_event, payload: unknown) => {
    const parsedPayload = parseSpawnShipperGroomPayload(payload);
    if (parsedPayload === null) {
      throw new Error('Invalid pty-spawn-shipper-groom payload.');
    }

    const repoPath = await ensureRepoClone(parsedPayload.repo);

    const cmd = await buildPromptCommand('groom', {
      issueRef: String(parsedPayload.issueNumber),
      repo: parsedPayload.repo,
      mode: 'interactive',
    });

    const sessionId = randomUUID();
    ptyManager.spawn(sessionId, cmd.command, cmd.args, {
      cols: parsedPayload.cols,
      rows: parsedPayload.rows,
      cwd: cmd.cwd ?? repoPath,
    });

    return { sessionId };
  });

  ipcMain.handle('adopt-issue', async (_event, payload: unknown) => {
    const parsedPayload = parseAdoptIssuePayload(payload);
    if (parsedPayload === null) {
      return {
        ok: false,
        error: 'Enter a repository in owner/repo format and a positive issue number.',
      };
    }

    try {
      await gh([
        'issue',
        'edit',
        String(parsedPayload.issueNumber),
        '-R',
        parsedPayload.repo,
        '--add-label',
        'shipper:new',
      ]);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  });

  ipcMain.handle('pty-write', (_event, payload: unknown) => {
    if (
      typeof payload !== 'object' ||
      payload === null ||
      !('sessionId' in payload) ||
      typeof payload.sessionId !== 'string' ||
      !('data' in payload) ||
      typeof payload.data !== 'string'
    ) {
      throw new Error('Invalid pty-write payload.');
    }

    ptyManager.write(payload.sessionId, payload.data);
  });

  ipcMain.handle('pty-resize', (_event, payload: unknown) => {
    if (
      typeof payload !== 'object' ||
      payload === null ||
      !('sessionId' in payload) ||
      typeof payload.sessionId !== 'string' ||
      !('cols' in payload) ||
      typeof payload.cols !== 'number' ||
      !('rows' in payload) ||
      typeof payload.rows !== 'number'
    ) {
      throw new Error('Invalid pty-resize payload.');
    }

    ptyManager.resize(payload.sessionId, payload.cols, payload.rows);
  });

  ipcMain.handle('pty-kill', (_event, payload: unknown) => {
    if (
      typeof payload !== 'object' ||
      payload === null ||
      !('sessionId' in payload) ||
      typeof payload.sessionId !== 'string'
    ) {
      throw new Error('Invalid pty-kill payload.');
    }

    ptyManager.kill(payload.sessionId);
  });
}

void app.whenReady().then(() => {
  registerIpcHandlers();

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
