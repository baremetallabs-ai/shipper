import { useCallback, useEffect, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';

import '@xterm/xterm/css/xterm.css';

type TerminalStatus = 'idle' | 'running' | 'exited';

interface UseTerminalRuntimeOptions {
  sessionId: string | null;
  status: TerminalStatus;
}

const WRITE_BATCH_THRESHOLD = 8192;
const WRITE_FLUSH_INTERVAL_MS = 16;
const RESIZE_DEBOUNCE_MS = 50;
const MAX_BUFFER_SIZE = 200_000;
const CHUNK_MERGE_THRESHOLD = 2048;

export function useTerminalRuntime({ sessionId, status }: UseTerminalRuntimeOptions) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(sessionId);
  const statusRef = useRef<TerminalStatus>(status);

  // Output buffer state
  const chunksRef = useRef<string[]>([]);
  const bufferLengthRef = useRef(0);
  const lastSequenceRef = useRef(0);
  const renderedCharsRef = useRef(0);

  // Write batching refs (port of old prototype's jank fix)
  const writeFlushTimerRef = useRef<number | null>(null);
  const queuedWritesRef = useRef<string[]>([]);
  const queuedWriteLengthRef = useRef(0);

  // Resize debounce
  const resizeTimerRef = useRef<number | null>(null);
  const lastSentSizeRef = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 });

  const clearQueuedWrites = useCallback(() => {
    queuedWritesRef.current = [];
    queuedWriteLengthRef.current = 0;
    if (writeFlushTimerRef.current !== null) {
      window.clearTimeout(writeFlushTimerRef.current);
      writeFlushTimerRef.current = null;
    }
  }, []);

  const flushQueuedWrites = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal || queuedWritesRef.current.length === 0) {
      queuedWritesRef.current = [];
      queuedWriteLengthRef.current = 0;
      return;
    }

    const combined = queuedWritesRef.current.join('');
    queuedWritesRef.current = [];
    queuedWriteLengthRef.current = 0;
    terminal.write(combined);
  }, []);

  const queueTerminalWrite = useCallback(
    (data: string) => {
      if (data.length === 0) return;

      queuedWritesRef.current.push(data);
      queuedWriteLengthRef.current += data.length;

      // Flush immediately if we've accumulated enough data.
      if (queuedWriteLengthRef.current >= WRITE_BATCH_THRESHOLD) {
        if (writeFlushTimerRef.current !== null) {
          window.clearTimeout(writeFlushTimerRef.current);
          writeFlushTimerRef.current = null;
        }
        flushQueuedWrites();
        return;
      }

      // Otherwise schedule a flush on the next frame.
      if (writeFlushTimerRef.current !== null) return;

      writeFlushTimerRef.current = window.setTimeout(() => {
        writeFlushTimerRef.current = null;
        flushQueuedWrites();
      }, WRITE_FLUSH_INTERVAL_MS);
    },
    [flushQueuedWrites]
  );

  // Keep refs in sync with props.
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // Initialize xterm on mount.
  useEffect(() => {
    if (!containerRef.current || terminalRef.current) return;

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      theme: {
        background: '#0b1020',
        foreground: '#ebedf2',
      },
      scrollback: 3000,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const fitAndResize = () => {
      if (!terminalRef.current || !fitAddonRef.current) return;

      fitAddonRef.current.fit();
      const { cols, rows } = terminalRef.current;
      const prev = lastSentSizeRef.current;
      if (prev.cols === cols && prev.rows === rows) return;

      lastSentSizeRef.current = { cols, rows };
      const sid = sessionIdRef.current;
      if (sid) {
        void window.shipperAPI.ptyResize(sid, cols, rows);
      }
    };

    fitAndResize();

    // Forward keyboard input to the PTY.
    const dataDisposable = terminal.onData((data) => {
      if (statusRef.current !== 'running') return;
      const sid = sessionIdRef.current;
      if (sid) {
        void window.shipperAPI.ptyWrite(sid, data);
      }
    });

    // Debounced resize on container changes.
    const observer = new ResizeObserver(() => {
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current);
      }
      resizeTimerRef.current = window.setTimeout(() => {
        resizeTimerRef.current = null;
        fitAndResize();
      }, RESIZE_DEBOUNCE_MS);
    });

    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
      clearQueuedWrites();
      dataDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      lastSentSizeRef.current = { cols: 0, rows: 0 };
      renderedCharsRef.current = 0;
    };
  }, [clearQueuedWrites]);

  // Reset terminal when session changes.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    clearQueuedWrites();
    terminal.reset();

    // Replay buffered output for the new session.
    const output = chunksRef.current.join('');
    if (output.length > 0) {
      terminal.write(output);
    }
    renderedCharsRef.current = output.length;
    lastSentSizeRef.current = { cols: 0, rows: 0 };

    if (sessionId) {
      void window.shipperAPI.ptyResize(sessionId, terminal.cols, terminal.rows);
    }
  }, [sessionId, clearQueuedWrites]);

  // Subscribe to PTY output events.
  useEffect(() => {
    const unsubscribe = window.shipperAPI.onPtyOutput((event) => {
      if (event.sessionId !== sessionIdRef.current) return;

      const { sequence, data } = event;

      // Deduplication: ignore out-of-order or duplicate sequences,
      // but allow restart (sequence 1 after a higher number).
      const prev = lastSequenceRef.current;
      if (prev > 0) {
        const restarted = sequence === 1 && prev > 1;
        if (!restarted && sequence <= prev) return;
      }
      lastSequenceRef.current = sequence;

      // Append to buffer.
      const chunks = chunksRef.current;
      const lastChunk = chunks[chunks.length - 1];
      if (
        lastChunk !== undefined &&
        lastChunk.length < CHUNK_MERGE_THRESHOLD &&
        data.length < CHUNK_MERGE_THRESHOLD
      ) {
        chunks[chunks.length - 1] = `${lastChunk}${data}`;
      } else {
        chunks.push(data);
      }

      bufferLengthRef.current += data.length;

      // Cap the buffer by evicting oldest chunks.
      while (bufferLengthRef.current > MAX_BUFFER_SIZE && chunks.length > 0) {
        const overflow = bufferLengthRef.current - MAX_BUFFER_SIZE;
        const first = chunks[0];
        if (first === undefined) break;

        if (first.length <= overflow) {
          chunks.shift();
          bufferLengthRef.current -= first.length;
          continue;
        }

        chunks[0] = first.slice(overflow);
        bufferLengthRef.current -= overflow;
      }

      // Delta rendering: if this is the next sequential chunk, just write the delta.
      if (sequence === prev + 1) {
        queueTerminalWrite(data);
        renderedCharsRef.current += data.length;
      } else {
        // Sequence skip or restart — full re-render.
        const terminal = terminalRef.current;
        if (terminal) {
          clearQueuedWrites();
          const output = chunks.join('');
          terminal.reset();
          terminal.write(output);
          renderedCharsRef.current = output.length;
        }
      }
    });

    return unsubscribe;
  }, [queueTerminalWrite, clearQueuedWrites]);

  return { containerRef };
}
