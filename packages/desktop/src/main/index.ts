import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, ipcMain } from 'electron';
import { checkGhAuth, checkGhInstalled, listIssues } from '@dnsquared/shipper-core';

interface AppConfig {
  repo: string;
}

interface ListIssuesSuccess {
  ok: true;
  issues: Awaited<ReturnType<typeof listIssues>>;
}

interface ListIssuesFailure {
  ok: false;
  error: string;
}

const defaultConfig: AppConfig = { repo: '' };
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const preloadPath = fileURLToPath(new URL('../preload/index.mjs', import.meta.url));
const rendererPath = fileURLToPath(new URL('../renderer/index.html', import.meta.url));

function getConfigPath(): string {
  return join(app.getPath('userData'), 'config.json');
}

function readConfig(): AppConfig {
  const configPath = getConfigPath();

  try {
    const raw = readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<AppConfig>;

    if (typeof parsed.repo === 'string') {
      return { repo: parsed.repo };
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
  if (typeof value !== 'object' || value === null || !('repo' in value)) {
    return null;
  }

  const repo = typeof value.repo === 'string' ? value.repo.trim() : null;
  if (repo === null) {
    return null;
  }

  return { repo };
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
  ipcMain.handle('set-config', (_event, config: unknown) => {
    const nextConfig = parseConfig(config);
    if (nextConfig === null) {
      throw new Error('Invalid config payload.');
    }

    if (nextConfig.repo.length > 0 && parseRepo(nextConfig.repo) === null) {
      throw new Error('Enter a repository in owner/repo format.');
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
