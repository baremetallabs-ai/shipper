import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { BrowserWindow } from 'electron';
import * as bundledPty from 'node-pty';
import type * as NodePty from 'node-pty';

export interface PtySpawnOptions {
  cols: number;
  rows: number;
  cwd?: string;
  env?: Record<string, string>;
  initialInput?: string;
}

interface PtySessionEntry {
  ptyProcess: NodePty.IPty;
  sequence: number;
  pendingBytes: number[];
}

const GRACE_TIMEOUT_MS = 5_000;
const require = createRequire(import.meta.url);

let cachedPty: typeof NodePty | null = null;

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
  const packageJson = JSON.parse(readFileSync(path.join(sourcePath, 'package.json'), 'utf-8')) as {
    version?: unknown;
  };
  if (typeof packageJson.version !== 'string') {
    throw new Error('Unable to determine node-pty package version.');
  }
  return packageJson.version;
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
  const markerPath = path.join(cachePath, '.shipper-node-pty-cache.json');
  const marker = `${JSON.stringify({ packageVersion, electronVersion }, null, 2)}\n`;

  if (!existsSync(markerPath) || readFileSync(markerPath, 'utf-8') !== marker) {
    rmSync(cachePath, { recursive: true, force: true });
    mkdirSync(cacheRoot, { recursive: true });
    cpSync(sourcePath, cachePath, { recursive: true });
    writeFileSync(markerPath, marker);
  }

  return cachePath;
}

function loadNodePty(): typeof NodePty {
  if (cachedPty !== null) return cachedPty;

  if (isPackagedDarwinElectron()) {
    const nodePtyPath = path.join(ensurePackagedDarwinNodePtyPath(), 'lib', 'index.js');
    cachedPty = require(nodePtyPath) as typeof NodePty;
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

      this.sessions.delete(id);
      const exitCb = this.exitCallbacks.get(id);
      if (exitCb) {
        this.exitCallbacks.delete(id);
        exitCb();
      }
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
    const entry = this.sessions.get(id);
    if (!entry) return;

    try {
      // Explicitly send SIGTERM — node-pty's default .kill() sends SIGHUP,
      // which Claude Code may ignore during its shutdown/update-check phase.
      process.kill(entry.ptyProcess.pid, 'SIGTERM');
    } catch {
      // Already exited.
    }

    // If it hasn't exited after a grace period, force-kill.
    setTimeout(() => {
      if (this.sessions.has(id)) {
        try {
          process.kill(entry.ptyProcess.pid, 'SIGKILL');
        } catch {
          // Process already gone.
        }
      }
    }, GRACE_TIMEOUT_MS);
  }

  destroyAll(): void {
    for (const [id] of this.sessions) {
      this.kill(id);
    }
  }
}
