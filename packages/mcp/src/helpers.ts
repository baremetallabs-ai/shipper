import { spawn } from 'node:child_process';
import { toErrorMessage } from '@dnsquared/shipper-core';

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
  opts: { timeoutMs: number }
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('shipper', args, {
      cwd: process.cwd(),
      env: process.env,
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
  opts: { command: string; finalMessage?: string; sessionLogPath?: string }
): ToolTextResult {
  if (!payload) {
    return formatFailureSummary(result, opts.command, opts.sessionLogPath);
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
    return formatFailureSummary(result, opts.command, opts.sessionLogPath);
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
    return formatFailureSummary(result, opts.command, opts.sessionLogPath);
  }

  return formatStructuredResult({
    result,
    headerLines: [`Verdict: ${payload.verdict}`, `Reason: ${payload.reason}`],
    finalMessage: opts.finalMessage,
    sessionLogPath: opts.sessionLogPath,
  });
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

function formatFailureSummary(
  result: SpawnResult,
  command: string,
  sessionLogPath?: string
): ToolTextResult {
  const parts = [
    result.timedOut ? `[timed out] ${command}` : `[exit ${result.exitCode}] ${command}`,
  ];
  const stderrTail = getStderrTail(result.stderr);
  if (stderrTail) {
    parts.push('', '--- stderr (tail) ---', stderrTail);
  }
  parts.push('', `Session log: ${sessionLogPath ?? '<not found>'}`);

  return buildResult(parts.join('\n'), result);
}

function buildResult(text: string, result: SpawnResult): ToolTextResult {
  const isError = result.timedOut || result.exitCode !== 0;
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
