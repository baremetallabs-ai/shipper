import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { BrowserWindow } from 'electron';
import * as bundledPty from 'node-pty';
import type * as NodePty from 'node-pty';
import {
  DESKTOP_AGENT_GRACE_TIMEOUT_MS,
  DESKTOP_WRAPPER_DRAIN_TIMEOUT_MS,
  hasDesktopResultArtifact,
  requestDesktopFinalize,
} from '@dnsquared/shipper-core';

export type PtyWorkflowKind = 'groom' | 'setup';
type PtyLifecycleStatus = 'running' | 'finalizing';

export type PtyCloseState =
  | { state: 'finalizable' }
  | { state: 'requires-discard-confirmation' }
  | { state: 'finalizing' }
  | { state: 'exited' };

export interface PtyWorkflowSessionSummary {
  sessionId: string;
  label: string;
  kind: PtyWorkflowKind;
  repo?: string;
  issueNumber?: number;
  status: PtyLifecycleStatus;
}

export interface PtySpawnOptions {
  cols: number;
  rows: number;
  cwd?: string;
  env?: Record<string, string>;
  initialInput?: string;
  kind?: PtyWorkflowKind;
  label?: string;
  repo?: string;
  issueNumber?: number;
  controlDir?: string;
}

interface PtySessionEntry {
  ptyProcess: NodePty.IPty;
  sequence: number;
  pendingBytes: number[];
  status: PtyLifecycleStatus;
  kind?: PtyWorkflowKind;
  label?: string;
  repo?: string;
  issueNumber?: number;
  controlDir?: string;
  gracefulKillTimer?: ReturnType<typeof setTimeout>;
}

const NODE_PTY_CACHE_MARKER = '.shipper-node-pty-cache.json';
const require = createRequire(import.meta.url);

type NodePtyModule = typeof import('node-pty');

let cachedPty: NodePtyModule | null = null;

type ElectronApp = typeof import('electron').app;
interface ElectronModule {
  app: ElectronApp;
}

function getElectronApp(): ElectronApp {
  return (require('electron') as ElectronModule).app;
}

function isPackagedDarwinElectron(): boolean {
  return (
    process.platform === 'darwin' && 'electron' in process.versions && getElectronApp().isPackaged
  );
}

function readNodePtyPackageVersion(sourcePath: string): string {
  const packageJsonPath = path.join(sourcePath, 'package.json');
  let packageJson: { version?: unknown };
  try {
    packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
      version?: unknown;
    };
  } catch (error) {
    throw new Error(`Unable to read node-pty package metadata from ${packageJsonPath}.`, {
      cause: error,
    });
  }

  if (typeof packageJson.version !== 'string') {
    throw new Error('Unable to determine node-pty package version.');
  }
  return packageJson.version;
}

function hasValidCacheMarker(markerPath: string, marker: string): boolean {
  try {
    return existsSync(markerPath) && readFileSync(markerPath, 'utf-8') === marker;
  } catch {
    return false;
  }
}

function createNodePtyCacheCandidate(
  cacheRoot: string,
  sourcePath: string,
  marker: string
): string {
  const tempPath = mkdtempSync(path.join(cacheRoot, '.node-pty-'));
  try {
    cpSync(sourcePath, tempPath, { recursive: true });
    writeFileSync(path.join(tempPath, NODE_PTY_CACHE_MARKER), marker);
    return tempPath;
  } catch (error) {
    rmSync(tempPath, { recursive: true, force: true });
    throw error;
  }
}

function isExistingPathError(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;

  return code === 'EEXIST' || code === 'ENOTEMPTY';
}

function publishNodePtyCacheCandidate(
  tempPath: string,
  cachePath: string,
  markerPath: string,
  marker: string
): string {
  if (hasValidCacheMarker(markerPath, marker)) {
    rmSync(tempPath, { recursive: true, force: true });
    return cachePath;
  }

  try {
    renameSync(tempPath, cachePath);
    return cachePath;
  } catch (error) {
    if (isExistingPathError(error) && hasValidCacheMarker(markerPath, marker)) {
      rmSync(tempPath, { recursive: true, force: true });
      return cachePath;
    }

    const fallbackPath = `${cachePath}-${path.basename(tempPath)}`;
    try {
      renameSync(tempPath, fallbackPath);
      return fallbackPath;
    } catch (fallbackError) {
      rmSync(tempPath, { recursive: true, force: true });
      throw new Error('Unable to publish node-pty native cache.', { cause: fallbackError });
    }
  }
}

function ensurePackagedDarwinNodePtyPath(): string {
  const app = getElectronApp();
  // node-pty's macOS helper fails to spawn from inside a .app bundle path.
  const sourcePath = path.join(
    process.resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    'node-pty'
  );
  const packageVersion = readNodePtyPackageVersion(sourcePath);
  const electronVersion = process.versions.electron;
  const cacheRoot = path.join(app.getPath('userData'), 'native');
  const cachePath = path.join(cacheRoot, `node-pty-${packageVersion}-electron-${electronVersion}`);
  const markerPath = path.join(cachePath, NODE_PTY_CACHE_MARKER);
  const marker = `${JSON.stringify({ packageVersion, electronVersion }, null, 2)}\n`;

  mkdirSync(cacheRoot, { recursive: true });
  if (!hasValidCacheMarker(markerPath, marker)) {
    const tempPath = createNodePtyCacheCandidate(cacheRoot, sourcePath, marker);
    return publishNodePtyCacheCandidate(tempPath, cachePath, markerPath, marker);
  }

  return cachePath;
}

function loadNodePty(): NodePtyModule {
  if (cachedPty !== null) return cachedPty;

  if (isPackagedDarwinElectron()) {
    const nodePtyPath = path.join(ensurePackagedDarwinNodePtyPath(), 'lib', 'index.js');
    cachedPty = require(nodePtyPath) as NodePtyModule;
    return cachedPty;
  }

  cachedPty = bundledPty;
  return cachedPty;
}

/**
 * Decodes a chunk of bytes that may contain incomplete UTF-8 sequences at the end.
 *
 * Port of the Tauri prototype's `decode_utf8_bytes` / `decode_utf8_pending`.
 * On macOS, node-pty typically emits pre-decoded strings so this is defensive,
 * but it prevents corruption on platforms or edge cases where data arrives as
 * raw bytes split mid-character.
 */
function decodeUtf8Chunk(pending: number[], chunk: Buffer): string {
  for (let i = 0; i < chunk.length; i++) {
    const byte = chunk[i];
    if (byte !== undefined) pending.push(byte);
  }
  return drainPendingUtf8(pending, false);
}

function flushPendingUtf8(pending: number[]): string {
  return drainPendingUtf8(pending, true);
}

function drainPendingUtf8(pending: number[], flush: boolean): string {
  const buf = Buffer.from(pending);
  let consumed = 0;
  let output = '';

  while (consumed < buf.length) {
    const byte = buf[consumed];
    if (byte === undefined) break;
    let seqLen: number;

    if (byte <= 0x7f) {
      seqLen = 1;
    } else if ((byte & 0xe0) === 0xc0) {
      seqLen = 2;
    } else if ((byte & 0xf0) === 0xe0) {
      seqLen = 3;
    } else if ((byte & 0xf8) === 0xf0) {
      seqLen = 4;
    } else {
      output += '\uFFFD';
      consumed += 1;
      continue;
    }

    const remaining = buf.length - consumed;
    if (remaining < seqLen) {
      if (flush) {
        output += '\uFFFD';
        consumed += remaining;
      }
      break;
    }

    let valid = true;
    for (let i = 1; i < seqLen; i++) {
      const continuation = buf[consumed + i];
      if (continuation === undefined || (continuation & 0xc0) !== 0x80) {
        valid = false;
        break;
      }
    }

    if (!valid) {
      output += '\uFFFD';
      consumed += 1;
      continue;
    }

    output += buf.subarray(consumed, consumed + seqLen).toString('utf-8');
    consumed += seqLen;
  }

  pending.length = 0;
  for (let i = consumed; i < buf.length; i++) {
    const byte = buf[i];
    if (byte !== undefined) pending.push(byte);
  }

  return output;
}

export class PtyManager {
  private sessions = new Map<string, PtySessionEntry>();
  private exitCallbacks = new Map<string, () => void>();
  private exitWaiters = new Map<string, Set<() => void>>();
  private window: BrowserWindow | null = null;

  setWindow(win: BrowserWindow): void {
    this.window = win;
  }

  onSessionExit(id: string, callback: () => void): void {
    this.exitCallbacks.set(id, callback);
  }

  spawn(id: string, command: string, args: string[], options: PtySpawnOptions): void {
    if (this.sessions.has(id)) {
      throw new Error(`Session "${id}" is already running.`);
    }

    const ptyProcess = loadNodePty().spawn(command, args, {
      name: 'xterm-256color',
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env: options.env ?? process.env,
    });

    const entry: PtySessionEntry = {
      ptyProcess,
      sequence: 0,
      pendingBytes: [],
      status: 'running',
      kind: options.kind,
      label: options.label,
      repo: options.repo,
      issueNumber: options.issueNumber,
      controlDir: options.controlDir,
    };

    this.sessions.set(id, entry);

    if (options.initialInput !== undefined) {
      ptyProcess.write(`${options.initialInput}\n`);
    }

    ptyProcess.onData((data) => {
      // node-pty emits strings on macOS/Linux, but we still run through UTF-8
      // decoding to handle edge cases defensively.
      const buf = Buffer.from(data, 'utf-8');
      const decoded = decodeUtf8Chunk(entry.pendingBytes, buf);
      if (decoded.length === 0) return;

      entry.sequence += 1;
      this.window?.webContents.send('pty-output', {
        sessionId: id,
        sequence: entry.sequence,
        data: decoded,
      });
    });

    ptyProcess.onExit(({ exitCode }) => {
      const tail = flushPendingUtf8(entry.pendingBytes);
      if (tail.length > 0) {
        entry.sequence += 1;
        this.window?.webContents.send('pty-output', {
          sessionId: id,
          sequence: entry.sequence,
          data: tail,
        });
      }

      clearTimeout(entry.gracefulKillTimer);
      if (entry.controlDir) {
        rmSync(entry.controlDir, { recursive: true, force: true });
      }
      this.sessions.delete(id);
      const exitCb = this.exitCallbacks.get(id);
      if (exitCb) {
        this.exitCallbacks.delete(id);
        exitCb();
      }
      this.resolveExitWaiters(id);
      this.window?.webContents.send('pty-exit', {
        sessionId: id,
        exitCode,
      });
    });
  }

  write(id: string, data: string): void {
    const entry = this.sessions.get(id);
    if (!entry) throw new Error(`Session "${id}" is not running.`);
    entry.ptyProcess.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const entry = this.sessions.get(id);
    if (!entry) return;
    entry.ptyProcess.resize(cols, rows);
  }

  kill(id: string): void {
    this.forceKill(id);
  }

  forceKill(id: string): void {
    const entry = this.sessions.get(id);
    if (!entry) return;

    clearTimeout(entry.gracefulKillTimer);
    entry.gracefulKillTimer = undefined;

    try {
      process.kill(entry.ptyProcess.pid, 'SIGKILL');
    } catch {
      // Already exited.
    }
  }

  async getCloseState(id: string): Promise<PtyCloseState> {
    const entry = this.sessions.get(id);
    if (!entry) {
      return { state: 'exited' };
    }

    if (entry.status === 'finalizing') {
      return { state: 'finalizing' };
    }

    if (entry.kind === 'setup') {
      return { state: 'finalizable' };
    }

    if (entry.kind === 'groom' && entry.controlDir) {
      return (await hasDesktopResultArtifact(entry.controlDir))
        ? { state: 'finalizable' }
        : { state: 'requires-discard-confirmation' };
    }

    return { state: 'requires-discard-confirmation' };
  }

  async finalize(id: string): Promise<void> {
    const entry = this.sessions.get(id);
    if (!entry || entry.status === 'finalizing') {
      return;
    }

    if (entry.kind === 'groom') {
      if (!entry.controlDir) {
        throw new Error(`Session "${id}" does not have a desktop control directory.`);
      }
      await requestDesktopFinalize(entry.controlDir);
      entry.status = 'finalizing';
      this.sendStatus(id, entry.status);
      return;
    }

    try {
      process.kill(entry.ptyProcess.pid, 'SIGTERM');
    } catch {
      return;
    }

    entry.status = 'finalizing';
    this.sendStatus(id, entry.status);
    entry.gracefulKillTimer = setTimeout(() => {
      if (this.sessions.has(id)) {
        try {
          process.kill(entry.ptyProcess.pid, 'SIGKILL');
        } catch {
          // Process already gone.
        }
      }
    }, DESKTOP_AGENT_GRACE_TIMEOUT_MS);
  }

  listLiveWorkflowSessions(): PtyWorkflowSessionSummary[] {
    const summaries: PtyWorkflowSessionSummary[] = [];
    for (const [sessionId, entry] of this.sessions) {
      if (entry.kind !== 'groom' && entry.kind !== 'setup') {
        continue;
      }

      summaries.push({
        sessionId,
        label: entry.label ?? sessionId,
        kind: entry.kind,
        repo: entry.repo,
        issueNumber: entry.issueNumber,
        status: entry.status,
      });
    }
    return summaries;
  }

  async closeLiveWorkflowSessionsForQuit(): Promise<void> {
    const sessions = this.listLiveWorkflowSessions();
    await Promise.all(
      sessions.map(async (session) => {
        const closeState = await this.getCloseState(session.sessionId);
        if (closeState.state === 'finalizable') {
          await this.finalize(session.sessionId);
          return;
        }

        if (closeState.state === 'requires-discard-confirmation') {
          this.forceKill(session.sessionId);
        }
      })
    );

    const timeoutMs = DESKTOP_AGENT_GRACE_TIMEOUT_MS + DESKTOP_WRAPPER_DRAIN_TIMEOUT_MS;
    await Promise.all(sessions.map((session) => this.waitForExit(session.sessionId, timeoutMs)));

    for (const session of sessions) {
      if (this.sessions.has(session.sessionId)) {
        this.forceKill(session.sessionId);
      }
    }
  }

  destroyAll(): void {
    for (const [id] of this.sessions) {
      this.forceKill(id);
    }
  }

  private sendStatus(sessionId: string, status: PtyLifecycleStatus): void {
    this.window?.webContents.send('pty-status', { sessionId, status });
  }

  private resolveExitWaiters(sessionId: string): void {
    const waiters = this.exitWaiters.get(sessionId);
    if (!waiters) {
      return;
    }
    this.exitWaiters.delete(sessionId);
    for (const resolve of waiters) {
      resolve();
    }
  }

  private async waitForExit(sessionId: string, timeoutMs: number): Promise<void> {
    if (!this.sessions.has(sessionId)) {
      return;
    }

    await new Promise<void>((resolve) => {
      const waiters = this.exitWaiters.get(sessionId) ?? new Set<() => void>();
      const cleanup = (): void => {
        clearTimeout(timeout);
        waiters.delete(cleanup);
        if (waiters.size === 0) {
          this.exitWaiters.delete(sessionId);
        }
        resolve();
      };

      waiters.add(cleanup);
      this.exitWaiters.set(sessionId, waiters);
      const timeout = setTimeout(cleanup, timeoutMs);
      if (!this.sessions.has(sessionId)) {
        cleanup();
      }
    });
  }
}
