import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { BrowserWindow } from 'electron';

export type BackgroundCommand = 'new' | 'ship' | 'init';
export type BackgroundStatus = 'queued' | 'running' | 'complete' | 'failed';

export interface BackgroundSessionMeta {
  issueNumber?: number;
  issueUrl?: string;
  logFile?: string;
  request?: string;
  cancelled?: boolean;
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

interface BackgroundSession {
  id: string;
  command: BackgroundCommand;
  repo: string;
  commandName: string;
  args: string[];
  cwd: string;
  child?: ChildProcessWithoutNullStreams;
  outputChunks: string[];
  status: BackgroundStatus;
  exitCode?: number | null;
  spawnedAt: number | null;
  meta: BackgroundSessionMeta;
  onComplete?: SpawnBackgroundSessionOptions['onComplete'];
  cancelRequested: boolean;
}

interface ShipQueueEntry {
  sessionId: string;
}

const GRACE_TIMEOUT_MS = 5_000;

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
      } catch {
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

    session.meta = { ...session.meta, cancelled: true };

    try {
      process.kill(child.pid, 'SIGTERM');
    } catch {
      // Already exited.
    }

    setTimeout(() => {
      const activeSession = this.sessions.get(sessionId);
      if (!activeSession?.child || activeSession.child.pid !== child.pid) {
        return;
      }

      try {
        process.kill(child.pid, 'SIGKILL');
      } catch {
        // Already exited.
      }
    }, GRACE_TIMEOUT_MS);
  }

  destroyAll(): void {
    for (const sessionId of this.sessions.keys()) {
      this.kill(sessionId);
    }
  }

  private startSession(session: BackgroundSession): void {
    session.spawnedAt = Date.now();
    session.status = 'running';

    if (session.command === 'ship') {
      this.shipActive.set(session.repo, session.id);
    }

    const child = spawn(session.commandName, session.args, {
      cwd: session.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
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
    session.status = exitCode === 0 ? 'complete' : 'failed';

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

    this.emitStatus(session);
    this.maybeAdvanceShipQueue(session);
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
}
