import { fileURLToPath } from 'node:url';

import { app, BrowserWindow } from 'electron';

import { PtyManager } from './pty-manager.js';
import { BackgroundManager } from './background-manager.js';
import { configureExternalLinks } from './external-links.js';
import { registerBackgroundHandlers } from './handlers/background.js';
import { registerConfigHandlers } from './handlers/config.js';
import { registerIssueHandlers } from './handlers/issues.js';
import { registerLockHandlers } from './handlers/lock.js';
import { registerPrerequisiteHandlers } from './handlers/prerequisites.js';
import { registerPtyHandlers } from './handlers/pty.js';
import { registerResetHandlers } from './handlers/reset.js';

const ptyManager = new PtyManager();
const backgroundManager = new BackgroundManager();
const preloadPath = fileURLToPath(new URL('../preload/index.cjs', import.meta.url));
const rendererPath = fileURLToPath(new URL('../renderer/index.html', import.meta.url));

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

  configureExternalLinks(window.webContents);
  ptyManager.setWindow(window);
  backgroundManager.setWindow(window);

  window.on('close', () => {
    ptyManager.destroyAll();
    backgroundManager.destroyAll();
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
  registerConfigHandlers();
  registerPrerequisiteHandlers();
  registerIssueHandlers();
  registerLockHandlers();
  registerResetHandlers();
  registerPtyHandlers(ptyManager);
  registerBackgroundHandlers(backgroundManager);
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
