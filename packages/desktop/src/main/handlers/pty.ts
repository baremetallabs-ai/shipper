import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ipcMain } from 'electron';
import {
  SHIPPER_DESKTOP_CONTROL_DIR_ENV,
  buildPromptCommand,
  ensureRepoClone,
} from '@baremetallabs-ai/shipper-core';

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

function getRepoConcurrencyKey(repo: string): string {
  return repo.toLowerCase();
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

function parseSessionIdPayload(value: unknown, channel: string): string {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('sessionId' in value) ||
    typeof value.sessionId !== 'string'
  ) {
    throw new Error(`Invalid ${channel} payload.`);
  }

  return value.sessionId;
}

function getPtyEnv(extra?: Record<string, string>): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => {
        return typeof entry[1] === 'string';
      })
    ),
    ...extra,
  };
}

export function registerPtyHandlers(ptyManager: PtyManager): void {
  const activeSetupRepos = new Set<string>();
  const repoPreparationQueues = new Map<string, Promise<void>>();

  const runWithRepoPreparationQueue = async <T>(
    repo: string,
    prepare: () => Promise<T>
  ): Promise<T> => {
    const repoKey = getRepoConcurrencyKey(repo);
    const previous = repoPreparationQueues.get(repoKey) ?? Promise.resolve();
    let releaseCurrent: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const next = previous.catch(() => undefined).then(() => current);
    repoPreparationQueues.set(repoKey, next);

    await previous.catch(() => undefined);

    try {
      return await prepare();
    } finally {
      releaseCurrent();
      if (repoPreparationQueues.get(repoKey) === next) {
        repoPreparationQueues.delete(repoKey);
      }
    }
  };

  ipcMain.handle('pty-spawn-shipper-groom', async (_event, payload: unknown) => {
    const parsedPayload = parseSpawnShipperGroomPayload(payload);
    if (parsedPayload === null) {
      throw new Error('Invalid pty-spawn-shipper-groom payload.');
    }

    const repoPath = await runWithRepoPreparationQueue(parsedPayload.repo, async () => {
      return await ensureRepoClone(parsedPayload.repo);
    });

    const sessionId = randomUUID();
    const controlDir = path.join(tmpdir(), 'shipper-pty', sessionId);
    await mkdir(controlDir, { recursive: true });
    ptyManager.spawn(
      sessionId,
      'shipper',
      ['groom', String(parsedPayload.issueNumber), '--mode', 'interactive'],
      {
        cols: parsedPayload.cols,
        rows: parsedPayload.rows,
        cwd: repoPath,
        env: getPtyEnv({ [SHIPPER_DESKTOP_CONTROL_DIR_ENV]: controlDir }),
        kind: 'groom',
        label: `groom — #${parsedPayload.issueNumber}`,
        repo: parsedPayload.repo,
        issueNumber: parsedPayload.issueNumber,
        controlDir,
      }
    );

    return { sessionId };
  });

  ipcMain.handle('pty-spawn-shipper-setup', async (_event, payload: unknown) => {
    const parsedPayload = parseSpawnPtyPayload(payload);
    if (parsedPayload === null) {
      throw new Error('Invalid pty-spawn-shipper-setup payload.');
    }

    const repoKey = getRepoConcurrencyKey(parsedPayload.repo);
    if (activeSetupRepos.has(repoKey)) {
      throw new Error(`Setup is already running for ${parsedPayload.repo}.`);
    }

    activeSetupRepos.add(repoKey);
    const clearSetupActive = (): void => {
      activeSetupRepos.delete(repoKey);
    };

    try {
      const repoPath = await runWithRepoPreparationQueue(parsedPayload.repo, async () => {
        return await ensureRepoClone(parsedPayload.repo);
      });
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
        kind: 'setup',
        label: `setup — ${parsedPayload.repo}`,
        repo: parsedPayload.repo,
      });
      ptyManager.onSessionExit(sessionId, clearSetupActive);

      return { sessionId };
    } catch (error) {
      clearSetupActive();
      throw error;
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

  ipcMain.handle('pty-close-state', async (_event, payload: unknown) => {
    const sessionId = parseSessionIdPayload(payload, 'pty-close-state');
    return await ptyManager.getCloseState(sessionId);
  });

  ipcMain.handle('pty-finalize', async (_event, payload: unknown) => {
    const sessionId = parseSessionIdPayload(payload, 'pty-finalize');
    await ptyManager.finalize(sessionId);
  });

  ipcMain.handle('pty-force-kill', (_event, payload: unknown) => {
    const sessionId = parseSessionIdPayload(payload, 'pty-force-kill');
    ptyManager.forceKill(sessionId);
  });
}
