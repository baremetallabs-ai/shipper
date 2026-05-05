import type { App, BrowserWindow, Event } from 'electron';
import { dialog } from 'electron';

import type { BackgroundManager } from './background-manager.js';
import type { PtyManager } from './pty-manager.js';

interface RegisterQuitCoordinatorOptions {
  app: App;
  window: BrowserWindow;
  ptyManager: PtyManager;
  backgroundManager: BackgroundManager;
}

export function registerQuitCoordinator({
  app: _app,
  window,
  ptyManager,
  backgroundManager,
}: RegisterQuitCoordinatorOptions): void {
  let closeApproved = false;
  let quitInProgress = false;

  window.on('close', (event: Event) => {
    if (closeApproved) {
      ptyManager.destroyAll();
      backgroundManager.destroyAll();
      return;
    }

    const liveWorkflowSessions = ptyManager.listLiveWorkflowSessions();
    if (liveWorkflowSessions.length === 0) {
      ptyManager.destroyAll();
      backgroundManager.destroyAll();
      return;
    }

    event.preventDefault();
    if (quitInProgress) {
      return;
    }
    quitInProgress = true;

    void (async () => {
      const labels = liveWorkflowSessions.map((session) => `- ${session.label}`).join('\n');
      const { response } = await dialog.showMessageBox(window, {
        type: 'warning',
        buttons: ['Close Sessions and Quit', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        message: 'Quit with live workflow sessions?',
        detail: `Quitting will close these live sessions:\n\n${labels}`,
      });

      if (response !== 0) {
        quitInProgress = false;
        return;
      }

      await ptyManager.closeLiveWorkflowSessionsForQuit();
      backgroundManager.destroyAll();
      closeApproved = true;
      window.close();
    })().catch(() => {
      quitInProgress = false;
    });
  });
}
