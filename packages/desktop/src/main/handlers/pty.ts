import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { ipcMain } from 'electron';
import {
  acquireIssueLock,
  buildPromptCommand,
  ensureRepoClone,
  getSettings,
  releaseIssueLock,
  renewIssueLock,
} from '@dnsquared/shipper-core';

import type { PtyManager } from '../pty-manager.js';
import { isPositiveInteger, parseRepo } from './shared.js';

interface SpawnPtyPayload {
  repo: string;
  cols: number;
  rows: number;
}

interface SpawnShipperGroomPayload extends SpawnPtyPayload {
  issueNumber: number;
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

export function registerPtyHandlers(ptyManager: PtyManager): void {
  ipcMain.handle('pty-spawn-shipper-groom', async (_event, payload: unknown) => {
    const parsedPayload = parseSpawnShipperGroomPayload(payload);
    if (parsedPayload === null) {
      throw new Error('Invalid pty-spawn-shipper-groom payload.');
    }

    const issueNumber = String(parsedPayload.issueNumber);
    await acquireIssueLock(parsedPayload.repo, issueNumber);
    const heartbeatCancelled = { value: false };
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let lockReleased = false;

    const releaseLock = async (): Promise<void> => {
      if (lockReleased) {
        return;
      }

      lockReleased = true;
      heartbeatCancelled.value = true;
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      await releaseIssueLock(parsedPayload.repo, issueNumber);
    };

    try {
      const repoPath = await ensureRepoClone(parsedPayload.repo);

      const cmd = await buildPromptCommand('groom', {
        issueRef: issueNumber,
        repo: parsedPayload.repo,
        cwd: repoPath,
        mode: 'interactive',
      });

      const heartbeatMs = (getSettings().lockTimeoutMinutes / 3) * 60_000;
      heartbeatTimer = setInterval(() => {
        void renewIssueLock(parsedPayload.repo, issueNumber, heartbeatCancelled);
      }, heartbeatMs);

      const sessionId = randomUUID();
      ptyManager.spawn(sessionId, cmd.command, cmd.args, {
        cols: parsedPayload.cols,
        rows: parsedPayload.rows,
        cwd: cmd.cwd ?? repoPath,
        initialInput: cmd.initialInput,
      });
      ptyManager.onSessionExit(sessionId, () => {
        void releaseLock();
      });

      return { sessionId };
    } catch (error) {
      await releaseLock();
      throw error;
    }
  });

  ipcMain.handle('pty-spawn-shipper-setup', async (_event, payload: unknown) => {
    const parsedPayload = parseSpawnPtyPayload(payload);
    if (parsedPayload === null) {
      throw new Error('Invalid pty-spawn-shipper-setup payload.');
    }

    const repoPath = await ensureRepoClone(parsedPayload.repo);
    const repoName = path.basename(repoPath);
    const hasShipperDir = existsSync(path.join(repoPath, '.shipper'));
    const userInput = hasShipperDir
      ? `Run setup for ${repoName}. .shipper/ directory already exists.`
      : `Run setup for ${repoName}. This is a fresh setup — no .shipper/ directory found.`;
    const cmd = await buildPromptCommand('setup', {
      userInput,
      repo: parsedPayload.repo,
      cwd: repoPath,
      mode: 'interactive',
    });

    const sessionId = randomUUID();
    ptyManager.spawn(sessionId, cmd.command, cmd.args, {
      cols: parsedPayload.cols,
      rows: parsedPayload.rows,
      cwd: cmd.cwd ?? repoPath,
      initialInput: cmd.initialInput,
    });

    return { sessionId };
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
