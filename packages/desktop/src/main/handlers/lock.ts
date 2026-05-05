import { ipcMain } from 'electron';
import { gh, isLockStale, LOCKED_LABEL, toErrorMessage } from '@baremetallabs-ai/shipper-core';

import { parseAdoptIssuePayload } from './shared.js';

export function registerLockHandlers(): void {
  ipcMain.handle('check-lock-stale', async (_event, payload: unknown) => {
    try {
      const parsedPayload = parseAdoptIssuePayload(payload);
      if (parsedPayload === null) {
        return { stale: false };
      }

      const stale = await isLockStale(parsedPayload.repo, String(parsedPayload.issueNumber));
      return { stale };
    } catch {
      console.warn('[shipper] Failed to check lock staleness');
      return { stale: false };
    }
  });

  ipcMain.handle('unlock-issue', async (_event, payload: unknown) => {
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
        '--remove-label',
        LOCKED_LABEL,
      ]);

      return { ok: true };
    } catch (error) {
      const message = toErrorMessage(error);
      return { ok: false, error: message };
    }
  });
}
