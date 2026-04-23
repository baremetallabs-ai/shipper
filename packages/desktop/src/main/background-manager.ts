import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { app, type BrowserWindow } from 'electron';
import {
  gh,
  LOCKED_LABEL,
  PAUSED_EXIT_CODE,
  RETRIABLE_FAILURE_EXIT_CODE,
} from '@dnsquared/shipper-core';

type BackgroundChildProcess = ChildProcessByStdio<null, Readable, Readable>;

export type BackgroundCommand = 'new' | 'ship' | 'init' | 'unblock';
export type BackgroundStatus = 'queued' | 'running' | 'complete' | 'failed' | 'paused';
type ShipOrigin = 'auto' | 'manual';
type HaltReason = 'user-pause' | 'auto-ship-off';

export interface BackgroundSessionMeta {
  issueNumber?: number;
  merge?: boolean;
  issueUrl?: string;
  logFile?: string;
  request?: string;
  cancelled?: boolean;
  pausePending?: boolean;
  origin?: ShipOrigin;
  autoShipHalted?: boolean;
  retriable?: boolean;
}

export interface BackgroundStatusEvent {
  sessionId: string;
  command: BackgroundCommand;
  repo: string;
  status: BackgroundStatus;
  exitCode?: number | null;
  meta?: BackgroundSessionMeta;
}

export interface BackgroundOutputEvent {
  sessionId: string;
  data: string;
}

export interface BackgroundSessionSnapshot {
  id: string;
  command: BackgroundCommand;
  repo: string;
  status: BackgroundStatus;
  exitCode?: number | null;
  spawnedAt: number | null;
  meta: BackgroundSessionMeta;
  output: string;
}

export interface SpawnBackgroundSessionOptions {
  sessionId: string;
  command: BackgroundCommand;
  repo: string;
  commandName: string;
  args: string[];
  cwd: string;
  logFile?: string;
  meta?: BackgroundSessionMeta;
  onComplete?: (
    session: BackgroundSessionSnapshot
  ) =>
    | Partial<BackgroundSessionMeta>
    | undefined
    | Promise<Partial<BackgroundSessionMeta> | undefined>;
}

export type RemoveQueuedSessionResult = 'ignored' | 'pause-requested' | 'paused';

interface BackgroundSession {
  id: string;
  command: BackgroundCommand;
  repo: string;
  commandName: string;
  args: string[];
  cwd: string;
  child?: BackgroundChildProcess;
  outputChunks: string[];
  status: BackgroundStatus;
  exitCode?: number | null;
  spawnedAt: number | null;
  meta: BackgroundSessionMeta;
  onComplete?: SpawnBackgroundSessionOptions['onComplete'];
  cancelRequested: boolean;
  pauseSentinelPath?: string;
  haltReason?: HaltReason;
}

interface ShipQueueEntry {
  sessionId: string;
}

const GRACE_TIMEOUT_MS = 5_000;
const LOCK_RELEASE_ATTEMPTS = 3;
const LOCK_RELEASE_DELAY_MS = 500;

export class BackgroundManager {
  private sessions = new Map<string, BackgroundSession>();
  private shipActive = new Map<string, string>();
  private shipQueue = new Map<string, ShipQueueEntry[]>();
  private window: BrowserWindow | null = null;

  setWindow(win: BrowserWindow): void {
    this.window = win;
  }

  spawn(options: SpawnBackgroundSessionOptions): { sessionId: string } {
    if (this.sessions.has(options.sessionId)) {
      throw new Error(`Background session "${options.sessionId}" already exists.`);
    }

    const session: BackgroundSession = {
      id: options.sessionId,
      command: options.command,
      repo: options.repo,
      commandName: options.commandName,
      args: options.args,
      cwd: options.cwd,
      outputChunks: [],
      status: 'running',
      spawnedAt: null,
      meta: {
        ...options.meta,
        logFile: options.logFile ?? options.meta?.logFile,
      },
      onComplete: options.onComplete,
      cancelRequested: false,
    };

    this.sessions.set(session.id, session);

    if (session.command === 'ship' && this.shipActive.has(session.repo)) {
      session.status = 'queued';
      const queue = this.shipQueue.get(session.repo) ?? [];
      queue.push({ sessionId: session.id });
      this.shipQueue.set(session.repo, queue);
      this.emitStatus(session);
      return { sessionId: session.id };
    }

    this.startSession(session);
    return { sessionId: session.id };
  }

  getOutput(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return '';
    }

    if (session.command === 'new' && session.meta.logFile) {
      try {
        return readFileSync(session.meta.logFile, 'utf8');
      } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) {
          console.warn(`[shipper] Failed to read session log file ${session.meta.logFile}`);
        }
        return '';
      }
    }

    return session.outputChunks.join('');
  }

  kill(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    session.cancelRequested = true;

    if (session.status === 'queued') {
      this.removeQueuedShip(session);
      session.status = 'failed';
      session.exitCode = null;
      session.meta = { ...session.meta, cancelled: true };
      this.emitStatus(session);
      return;
    }

    const child = session.child;
    if (!child) {
      return;
    }
    const childPid = child.pid;
    if (childPid === undefined) {
      return;
    }

    session.meta = { ...session.meta, cancelled: true };

    try {
      process.kill(childPid, 'SIGTERM');
    } catch {
      // Already exited.
    }

    setTimeout(() => {
      const activeSession = this.sessions.get(sessionId);
      if (!activeSession?.child || activeSession.child.pid !== childPid) {
        return;
      }

      try {
        process.kill(childPid, 'SIGKILL');
      } catch {
        // Already exited.
      }
    }, GRACE_TIMEOUT_MS);
  }

  requestPause(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.command !== 'ship' || session.status !== 'running') {
      return false;
    }

    const pauseSentinelPath = session.pauseSentinelPath;
    if (!pauseSentinelPath) {
      return false;
    }

    session.haltReason = 'user-pause';
    this.writeHaltSentinel(pauseSentinelPath);

    session.meta = { ...session.meta, pausePending: true };
    this.emitStatus(session);
    return true;
  }

  requestAutoShipHalt(repo: string): number {
    let haltedCount = 0;

    for (const session of this.sessions.values()) {
      if (
        session.command !== 'ship' ||
        session.repo !== repo ||
        session.status !== 'running' ||
        session.meta.origin !== 'auto' ||
        session.haltReason
      ) {
        continue;
      }

      const pauseSentinelPath = session.pauseSentinelPath;
      if (!pauseSentinelPath) {
        continue;
      }

      session.haltReason = 'auto-ship-off';
      this.writeHaltSentinel(pauseSentinelPath);
      haltedCount += 1;
    }

    return haltedCount;
  }

  removeQueuedSession(sessionId: string): RemoveQueuedSessionResult {
    const session = this.sessions.get(sessionId);
    if (!session || session.command !== 'ship') {
      return 'ignored';
    }

    if (session.status === 'running') {
      return this.requestPause(sessionId) ? 'pause-requested' : 'ignored';
    }

    if (session.status !== 'queued') {
      return 'ignored';
    }

    this.removeQueuedShip(session);
    session.exitCode = null;
    session.status = 'paused';
    this.emitStatus(session);
    return 'paused';
  }

  destroyAll(): void {
    for (const sessionId of this.sessions.keys()) {
      this.kill(sessionId);
    }

    for (const session of this.sessions.values()) {
      this.cleanupPauseSentinel(session.pauseSentinelPath);
    }

    try {
      rmSync(join(app.getPath('userData'), 'pause-sentinels'), { recursive: true, force: true });
    } catch {
      // Best-effort runtime cleanup on shutdown.
    }
  }

  private startSession(session: BackgroundSession): void {
    session.spawnedAt = Date.now();
    session.status = 'running';

    if (session.command === 'ship') {
      this.shipActive.set(session.repo, session.id);
      session.pauseSentinelPath = this.createPauseSentinelPath(session.id);
    }

    const env = session.pauseSentinelPath
      ? { ...process.env, SHIPPER_PAUSE_SENTINEL_FILE: session.pauseSentinelPath }
      : process.env;
    const child = spawn(session.commandName, session.args, {
      cwd: session.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    session.child = child;
    this.emitStatus(session);

    child.stdout.on('data', (chunk: Buffer | string) => {
      this.handleOutput(session, chunk);
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      this.handleOutput(session, chunk);
    });

    let settled = false;
    const finish = (exitCode: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      void this.finishSession(session, exitCode);
    };

    child.on('error', () => {
      finish(1);
    });
    child.on('close', (exitCode) => {
      finish(exitCode);
    });
  }

  private handleOutput(session: BackgroundSession, chunk: Buffer | string): void {
    const data = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (data.length === 0) {
      return;
    }

    session.outputChunks.push(data);
    this.window?.webContents.send('bg-output', {
      sessionId: session.id,
      data,
    } satisfies BackgroundOutputEvent);
  }

  private async finishSession(session: BackgroundSession, exitCode: number | null): Promise<void> {
    session.child = undefined;
    session.exitCode = exitCode;
    if (exitCode === PAUSED_EXIT_CODE && !session.cancelRequested) {
      session.status = session.haltReason === 'auto-ship-off' ? 'complete' : 'paused';
      if (session.haltReason === 'auto-ship-off') {
        session.meta = { ...session.meta, autoShipHalted: true };
      }
    } else if (exitCode === RETRIABLE_FAILURE_EXIT_CODE && !session.cancelRequested) {
      session.status = 'failed';
      session.meta = { ...session.meta, retriable: true };
    } else {
      session.status = exitCode === 0 ? 'complete' : 'failed';
    }

    if (session.cancelRequested) {
      session.status = 'failed';
      session.meta = { ...session.meta, cancelled: true };
    } else if (session.status === 'complete' && session.onComplete) {
      try {
        const extraMeta = await session.onComplete(this.snapshotSession(session));
        if (extraMeta) {
          session.meta = { ...session.meta, ...extraMeta };
        }
      } catch {
        // Metadata enrichment is best-effort.
      }
    }

    this.cleanupPauseSentinel(session.pauseSentinelPath);
    this.emitStatus(session);
    if (
      session.command === 'ship' &&
      session.status === 'failed' &&
      session.meta.issueNumber !== undefined
    ) {
      await this.releaseShipLockWithRetry(session.repo, session.meta.issueNumber);
    }
    this.maybeAdvanceShipQueue(session);
  }

  private async releaseShipLockWithRetry(repo: string, issueNumber: number): Promise<void> {
    for (let attempt = 1; attempt <= LOCK_RELEASE_ATTEMPTS; attempt += 1) {
      try {
        await gh([
          'issue',
          'edit',
          String(issueNumber),
          '-R',
          repo,
          '--remove-label',
          LOCKED_LABEL,
        ]);
        return;
      } catch {
        if (attempt === LOCK_RELEASE_ATTEMPTS) {
          console.warn(
            `[shipper] Failed to release lock for ${repo}#${issueNumber} after ${LOCK_RELEASE_ATTEMPTS} attempts; stale-lock self-heal will clear it.`
          );
          return;
        }

        await new Promise((resolve) => {
          setTimeout(resolve, LOCK_RELEASE_DELAY_MS);
        });
      }
    }
  }

  private snapshotSession(session: BackgroundSession): BackgroundSessionSnapshot {
    return {
      id: session.id,
      command: session.command,
      repo: session.repo,
      status: session.status,
      exitCode: session.exitCode,
      spawnedAt: session.spawnedAt,
      meta: { ...session.meta },
      output: session.outputChunks.join(''),
    };
  }

  private emitStatus(session: BackgroundSession): void {
    this.window?.webContents.send('bg-status', {
      sessionId: session.id,
      command: session.command,
      repo: session.repo,
      status: session.status,
      exitCode: session.exitCode,
      meta: { ...session.meta },
    } satisfies BackgroundStatusEvent);
  }

  private maybeAdvanceShipQueue(session: BackgroundSession): void {
    if (session.command !== 'ship') {
      return;
    }

    const activeSessionId = this.shipActive.get(session.repo);
    if (activeSessionId === session.id) {
      this.shipActive.delete(session.repo);
    }

    const queue = this.shipQueue.get(session.repo) ?? [];
    const nextEntry = queue.shift();
    if (queue.length === 0) {
      this.shipQueue.delete(session.repo);
    } else {
      this.shipQueue.set(session.repo, queue);
    }

    if (!nextEntry) {
      return;
    }

    const nextSession = this.sessions.get(nextEntry.sessionId);
    if (!nextSession) {
      this.maybeAdvanceShipQueue(session);
      return;
    }

    this.startSession(nextSession);
  }

  private removeQueuedShip(session: BackgroundSession): void {
    if (session.command !== 'ship') {
      return;
    }

    const queue = this.shipQueue.get(session.repo);
    if (!queue) {
      return;
    }

    const nextQueue = queue.filter((entry) => entry.sessionId !== session.id);
    if (nextQueue.length === 0) {
      this.shipQueue.delete(session.repo);
      return;
    }

    this.shipQueue.set(session.repo, nextQueue);
  }

  private createPauseSentinelPath(sessionId: string): string {
    const pauseSentinelDir = join(app.getPath('userData'), 'pause-sentinels');
    mkdirSync(pauseSentinelDir, { recursive: true });
    return join(pauseSentinelDir, sessionId);
  }

  private writeHaltSentinel(pauseSentinelPath: string): void {
    try {
      writeFileSync(pauseSentinelPath, '');
    } catch {
      // Best-effort signal file creation.
    }
  }

  private cleanupPauseSentinel(pauseSentinelPath?: string): void {
    if (!pauseSentinelPath) {
      return;
    }

    try {
      rmSync(pauseSentinelPath, { force: true });
    } catch {
      // Best-effort runtime cleanup.
    }
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
