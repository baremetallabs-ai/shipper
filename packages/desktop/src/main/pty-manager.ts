import type { BrowserWindow } from 'electron';
import * as pty from 'node-pty';

export interface PtySpawnOptions {
  cols: number;
  rows: number;
  cwd?: string;
  env?: Record<string, string>;
}

interface PtySessionEntry {
  ptyProcess: pty.IPty;
  sequence: number;
  pendingBytes: number[];
}

const GRACE_TIMEOUT_MS = 5_000;

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
  private window: BrowserWindow | null = null;

  setWindow(win: BrowserWindow): void {
    this.window = win;
  }

  spawn(id: string, command: string, args: string[], options: PtySpawnOptions): void {
    if (this.sessions.has(id)) {
      throw new Error(`Session "${id}" is already running.`);
    }

    const ptyProcess = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env: options.env ?? (process.env as Record<string, string>),
    });

    const entry: PtySessionEntry = {
      ptyProcess,
      sequence: 0,
      pendingBytes: [],
    };

    this.sessions.set(id, entry);

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
