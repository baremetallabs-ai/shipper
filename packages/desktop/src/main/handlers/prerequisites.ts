import { ipcMain } from 'electron';
import {
  checkGhAuth,
  checkGhInstalled,
  checkLabels,
  toErrorMessage,
} from '@dnsquared/shipper-core';

import { parseRepoPayload } from './shared.js';

export function registerPrerequisiteHandlers(): void {
  ipcMain.handle('check-prerequisites', async () => {
    const ghInstalled = await checkGhInstalled();
    const ghAuth = ghInstalled.ok ? await checkGhAuth() : { ok: false, message: '' };
    return { ghInstalled, ghAuth };
  });

  ipcMain.handle('check-init', async (_event, payload: unknown) => {
    const repo = parseRepoPayload(payload);
    if (repo === null) {
      return { initialized: false, error: 'Invalid repo payload.' };
    }

    try {
      const result = await checkLabels(repo);
      if (!result.ok && result.message.startsWith('Could not check')) {
        return { initialized: false, error: result.message };
      }
      return { initialized: result.ok };
    } catch (error) {
      const message = toErrorMessage(error);
      return { initialized: false, error: message };
    }
  });
}
