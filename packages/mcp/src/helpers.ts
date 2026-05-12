import { spawn, type ChildProcess } from 'node:child_process';
import type { ArtifactScan, DeferMarkerPayload, ResetResult } from '@baremetallabs-ai/shipper-core';
import {
  DEFER_MARKER_PREFIX,
  parseDeferMarker,
  toErrorMessage,
} from '@baremetallabs-ai/shipper-core';

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ToolTextResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

interface StructuredResultOptions {
  result: SpawnResult;
  headerLines: string[];
  finalMessage?: string;
  sessionLogPath?: string;
}

interface FailureSummaryOptions {
  command: string;
  sessionLogPath?: string;
  finalMessage?: string;
  detail?: string;
  forceError?: boolean;
}

interface CreateIssuePayload {
  issueNumber: number;
  title: string;
  url: string;
}

interface AdvancePayload {
  from: string;
  to: string;
  verdict: string;
  prUrl?: string;
}

interface UnblockPayload {
  verdict: string;
  reason: string;
}

const MISSING_FINAL_MESSAGE_LINE =
  'No final message was captured in this run. See session log for details.';
const STDERR_TAIL_LIMIT = 4_096;

export async function spawnShipper(
  args: string[],
  opts: { timeoutMs: number; env?: Record<string, string | undefined> }
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('shipper', args, {
      cwd: process.cwd(),
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? -1,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

export interface ShipperDeferEvent {
  kind: 'deferred';
  payload: DeferMarkerPayload;
  sessionId: string;
}

export interface ShipperCompletionEvent {
  kind: 'completed';
  result: SpawnResult;
}

export type ShipperEvent = ShipperDeferEvent | ShipperCompletionEvent;

export interface ShipperRunner {
  /** Awaits the next significant event from the running shipper child. */
  next(): Promise<ShipperEvent>;
  /** Writes a JSON answers line to the child's stdin to resume a deferred worker. */
  answer(answers: Record<string, string>): Promise<void>;
  /** Sends SIGKILL to the child. */
  cancel(): void;
  /** True once the child has emitted a completion event (no more defers possible). */
  isCompleted(): boolean;
}

interface PendingResolver {
  resolve: (event: ShipperEvent) => void;
  reject: (err: Error) => void;
}

/**
 * Spawn `shipper` and stream its stdout, surfacing each defer marker as a discrete event.
 * Caller drives the run with `runner.next()` until a completion event is returned.
 * Between defers, caller calls `runner.answer(...)` to feed the worker its answer.
 */
export function startShipper(args: string[], opts: { timeoutMs: number }): ShipperRunner {
  const child: ChildProcess = spawn('shipper', args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let stdoutLineBuffer = '';
  let timedOut = false;
  let completed = false;
  const eventQueue: ShipperEvent[] = [];
  let pending: PendingResolver | undefined;

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, opts.timeoutMs);

  const enqueue = (event: ShipperEvent): void => {
    if (event.kind === 'completed') {
      completed = true;
    }
    if (pending) {
      const resolver = pending;
      pending = undefined;
      resolver.resolve(event);
      return;
    }
    eventQueue.push(event);
  };

  const fail = (err: Error): void => {
    clearTimeout(timer);
    if (pending) {
      const resolver = pending;
      pending = undefined;
      resolver.reject(err);
    }
  };

  child.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    stdout += text;
    stdoutLineBuffer += text;
    let newlineIdx: number;
    while ((newlineIdx = stdoutLineBuffer.indexOf('\n')) !== -1) {
      const line = stdoutLineBuffer.slice(0, newlineIdx);
      stdoutLineBuffer = stdoutLineBuffer.slice(newlineIdx + 1);
      const trimmed = line.trim();
      if (!trimmed.startsWith(DEFER_MARKER_PREFIX)) continue;
      const payload = parseDeferMarker(trimmed);
      if (!payload) continue;
      enqueue({ kind: 'deferred', payload, sessionId: payload.sessionId });
    }
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  child.on('error', (err) => {
    fail(err instanceof Error ? err : new Error(String(err)));
  });

  child.on('close', (code) => {
    clearTimeout(timer);
    enqueue({
      kind: 'completed',
      result: {
        exitCode: code ?? -1,
        stdout,
        stderr,
        timedOut,
      },
    });
  });

  return {
    next: async () => {
      const queued = eventQueue.shift();
      if (queued) return queued;
      if (completed) {
        throw new Error('Shipper child has already completed; no more events.');
      }
      return await new Promise<ShipperEvent>((resolve, reject) => {
        pending = { resolve, reject };
      });
    },
    answer: async (answers) => {
      if (completed) {
        throw new Error('Cannot submit an answer: shipper child already completed.');
      }
      const stdin = child.stdin;
      if (!stdin || stdin.destroyed) {
        throw new Error('shipper child stdin is unavailable; cannot submit answer.');
      }
      const line = JSON.stringify({ answers }) + '\n';
      await new Promise<void>((resolve, reject) => {
        stdin.write(line, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
    cancel: () => {
      clearTimeout(timer);
      child.kill('SIGKILL');
    },
    isCompleted: () => completed,
  };
}

export function formatToolError(error: unknown): ToolTextResult {
  return {
    content: [{ type: 'text', text: toErrorMessage(error) }],
    isError: true,
  };
}

export function formatSpawnResult(result: SpawnResult, command: string): ToolTextResult {
  const parts: string[] = [];
  if (result.timedOut) {
    parts.push(`[timed out] ${command}`);
  } else {
    parts.push(`[exit ${result.exitCode}] ${command}`);
  }
  if (result.stdout.trim().length > 0) {
    parts.push('--- stdout ---', result.stdout.trimEnd());
  }
  if (result.stderr.trim().length > 0) {
    parts.push('--- stderr ---', result.stderr.trimEnd());
  }
  const text = parts.join('\n');
  const isError = result.timedOut || result.exitCode !== 0;
  return isError
    ? { content: [{ type: 'text', text }], isError: true }
    : { content: [{ type: 'text', text }] };
}

export function formatCreateIssueResult(
  result: SpawnResult,
  payload: CreateIssuePayload | undefined,
  opts: {
    command: string;
    finalMessage?: string;
    sessionLogPath?: string;
  }
): ToolTextResult {
  if (!payload) {
    return formatFailureSummary(result, {
      command: opts.command,
      sessionLogPath: opts.sessionLogPath,
      finalMessage: opts.finalMessage,
    });
  }

  return formatStructuredResult({
    result,
    headerLines: [`Created issue: #${payload.issueNumber} ${payload.title}`, `URL: ${payload.url}`],
    finalMessage: opts.finalMessage,
    sessionLogPath: opts.sessionLogPath,
  });
}

export function formatAdvanceResult(
  result: SpawnResult,
  payload: AdvancePayload | undefined,
  opts: { command: string; finalMessage?: string; sessionLogPath?: string }
): ToolTextResult {
  if (!payload) {
    return formatFailureSummary(result, {
      command: opts.command,
      sessionLogPath: opts.sessionLogPath,
      finalMessage: opts.finalMessage,
      detail: 'Unable to recover the stage transition from post-run metadata.',
      forceError: true,
    });
  }

  const headerLines = [`Stage: ${payload.from} -> ${payload.to} (${payload.verdict})`];
  if (payload.prUrl) {
    headerLines.push(`PR: ${payload.prUrl}`);
  }

  return formatStructuredResult({
    result,
    headerLines,
    finalMessage: opts.finalMessage,
    sessionLogPath: opts.sessionLogPath,
  });
}

export function formatUnblockResult(
  result: SpawnResult,
  payload: UnblockPayload | undefined,
  opts: { command: string; finalMessage?: string; sessionLogPath?: string }
): ToolTextResult {
  if (!payload) {
    return formatFailureSummary(result, {
      command: opts.command,
      sessionLogPath: opts.sessionLogPath,
      finalMessage: opts.finalMessage,
      detail: 'Unable to recover the unblock verdict from post-run metadata.',
      forceError: true,
    });
  }

  return formatStructuredResult({
    result,
    headerLines: [`Verdict: ${payload.verdict}`, `Reason: ${payload.reason}`],
    finalMessage: opts.finalMessage,
    sessionLogPath: opts.sessionLogPath,
  });
}

export function formatResetPreview(issue: number, scan: ArtifactScan): string {
  const lines = [`Reset preview for issue #${issue}:`, `Target: ${scan.targetLabel}`];

  if (scan.labelsToRemove.length > 0) {
    lines.push(`Labels to remove: ${scan.labelsToRemove.join(', ')}`);
  }
  if (scan.addTarget) {
    lines.push(`Label to add: ${scan.targetLabel}`);
  }
  if (scan.commentIds.length > 0) {
    lines.push(`Comments to delete: ${scan.commentIds.join(', ')}`);
  }
  if (scan.prs.length > 0) {
    lines.push(
      `PRs to close: ${scan.prs.map((pr) => `#${pr.number} (${pr.headRefName})`).join(', ')}`
    );
  }
  if (scan.branchesToDelete.length > 0) {
    lines.push(`Remote branches to delete: ${scan.branchesToDelete.join(', ')}`);
  }
  if (scan.localBranches.length > 0) {
    lines.push(`Local branches to delete: ${scan.localBranches.join(', ')}`);
  }
  if (scan.localWorktrees.length > 0) {
    lines.push(`Local worktrees to remove: ${scan.localWorktrees.join(', ')}`);
  }

  lines.push('Dry run only; no changes made.');
  return lines.join('\n');
}

export function formatResetResult(issue: number, result: ResetResult): string {
  const lines = [`Reset results for issue #${issue}:`];

  for (const operation of result.operations) {
    const suffix = operation.reason ? ` (${operation.reason})` : '';
    lines.push(`${operation.status}: ${operation.description}${suffix}`);
  }

  return lines.join('\n');
}

function formatStructuredResult(opts: StructuredResultOptions): ToolTextResult {
  const text = [
    ...opts.headerLines,
    '',
    '---',
    opts.finalMessage ?? MISSING_FINAL_MESSAGE_LINE,
    '',
    `Session log: ${opts.sessionLogPath ?? '<not found>'}`,
  ].join('\n');

  return buildResult(text, opts.result);
}

function formatFailureSummary(result: SpawnResult, opts: FailureSummaryOptions): ToolTextResult {
  const parts = [
    result.timedOut ? `[timed out] ${opts.command}` : `[exit ${result.exitCode}] ${opts.command}`,
  ];
  if (opts.detail) {
    parts.push(opts.detail);
  }
  const stderrTail = getStderrTail(result.stderr);
  if (stderrTail) {
    parts.push('', '--- stderr (tail) ---', stderrTail);
  }

  if (opts.finalMessage !== undefined || !result.timedOut) {
    parts.push('', '---', opts.finalMessage ?? MISSING_FINAL_MESSAGE_LINE);
  }

  parts.push('', `Session log: ${opts.sessionLogPath ?? '<not found>'}`);

  return buildResult(parts.join('\n'), result, opts.forceError);
}

function buildResult(text: string, result: SpawnResult, forceError = false): ToolTextResult {
  const isError = forceError || result.timedOut || result.exitCode !== 0;
  return isError
    ? { content: [{ type: 'text', text }], isError: true }
    : { content: [{ type: 'text', text }] };
}

function getStderrTail(stderr: string): string | undefined {
  const trimmed = stderr.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.length <= STDERR_TAIL_LIMIT) {
    return trimmed;
  }

  const truncated = trimmed.slice(-STDERR_TAIL_LIMIT);
  const newlineIndex = truncated.indexOf('\n');
  return newlineIndex >= 0 ? truncated.slice(newlineIndex + 1) : truncated;
}
