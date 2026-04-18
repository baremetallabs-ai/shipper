import { AsyncLocalStorage } from 'node:async_hooks';
import type { Writable } from 'node:stream';

export interface Logger {
  stageStart(stage: string, issue: string): void;
  stageComplete(stage: string, issue: string, durationMs: number): void;
  stageFailed(stage: string, issue: string, durationMs: number): void;
  worktreeStep(step: string): void;
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

type LoggerChannel = 'log' | 'warn' | 'error';

interface LogCaptureContext {
  stream?: Writable;
}

const logCaptureContext = new AsyncLocalStorage<LogCaptureContext>();

function prefixMessage(message: string): string {
  return message.replace(/^(\n*)/, '$1[shipper] ');
}

function writeLine(channel: LoggerChannel, message: string, stream?: Writable): void {
  switch (channel) {
    case 'log':
      console.log(message);
      break;
    case 'warn':
      console.warn(message);
      break;
    case 'error':
      console.error(message);
      break;
  }

  const targetStream = stream ?? logCaptureContext.getStore()?.stream;
  if (
    !targetStream ||
    !targetStream.writable ||
    targetStream.writableEnded ||
    targetStream.destroyed
  ) {
    return;
  }

  targetStream.write(`${message}\n`);
}

function formatIssueSegment(issue: string): string {
  return issue ? ` #${issue}` : '';
}

export function createLogger(options?: { stream?: Writable }): Logger {
  return {
    stageStart(stage: string, issue: string) {
      writeLine(
        'error',
        `[shipper] ▶ stage:${stage}${formatIssueSegment(issue)} starting`,
        options?.stream
      );
    },
    stageComplete(stage: string, issue: string, durationMs: number) {
      writeLine(
        'error',
        `[shipper] ✓ stage:${stage}${formatIssueSegment(issue)} complete (${formatDuration(durationMs)})`,
        options?.stream
      );
    },
    stageFailed(stage: string, issue: string, durationMs: number) {
      writeLine(
        'error',
        `[shipper] ✗ stage:${stage}${formatIssueSegment(issue)} failed (${formatDuration(durationMs)})`,
        options?.stream
      );
    },
    worktreeStep(step: string) {
      writeLine('error', `[shipper]   worktree: ${step}`, options?.stream);
    },
    log(message: string) {
      writeLine('log', prefixMessage(message), options?.stream);
    },
    warn(message: string) {
      writeLine('warn', prefixMessage(message), options?.stream);
    },
    error(message: string) {
      writeLine('error', prefixMessage(message), options?.stream);
    },
  };
}

export function getLogCaptureStream(): Writable | undefined {
  return logCaptureContext.getStore()?.stream;
}

export async function withLogCapture<T>(
  stream: Writable | undefined,
  fn: () => Promise<T>
): Promise<T> {
  if (!stream) {
    return await fn();
  }

  return await logCaptureContext.run({ stream }, fn);
}

export const logger = createLogger();
