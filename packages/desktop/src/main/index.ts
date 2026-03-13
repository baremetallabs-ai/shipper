import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, ipcMain } from 'electron';
import { checkGhAuth, checkGhInstalled, gh, listIssues } from '@dnsquared/shipper-core';

interface AppConfig {
  repos: string[];
  activeRepo: string;
}

interface ListIssuesSuccess {
  ok: true;
  issues: Awaited<ReturnType<typeof listIssues>>;
}

interface ListIssuesFailure {
  ok: false;
  error: string;
}

const defaultConfig: AppConfig = { repos: [], activeRepo: '' };
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
    const nextConfig = parseConfig(parsed);
    if (nextConfig !== null) {
      return nextConfig;
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

function parseConfig(value: unknown): AppConfig | null {
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
  for (const repo of value.repos) {
    const parsedRepo = parseRepo(repo);
    if (parsedRepo === null) {
      return null;
    }

    repos.push(parsedRepo);
  }

  const activeRepo = typeof value.activeRepo === 'string' ? value.activeRepo.trim() : null;
  if (activeRepo === null) {
    return null;
  }

  if (activeRepo.length === 0) {
    return repos.length === 0 ? { repos, activeRepo } : null;
  }

  return repos.includes(activeRepo) ? { repos, activeRepo } : null;
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
    const repo =
      typeof payload === 'object' && payload !== null && 'repo' in payload
        ? parseRepo(payload.repo)
        : null;

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

  ipcMain.handle('get-config', () => readConfig());
  ipcMain.handle('list-repos', async () => {
    const result = await gh(['repo', 'list', '--json', 'nameWithOwner', '--limit', '100']);
    const parsed = JSON.parse(result.stdout) as Array<{ nameWithOwner: string }>;
    return parsed.map((repo) => repo.nameWithOwner);
  });
  ipcMain.handle('set-config', (_event, config: unknown) => {
    const nextConfig = parseConfig(config);
    if (nextConfig === null) {
      throw new Error('Invalid config payload.');
    }

    writeConfig(nextConfig);
  });
}

app.whenReady().then(() => {
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
