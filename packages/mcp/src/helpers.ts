import { spawn } from 'node:child_process';
import type { ArtifactScan, ResetResult } from '@dnsquared/shipper-core';
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
    return formatFailureSummary(result, {
      command: opts.command,
      sessionLogPath: opts.sessionLogPath,
      finalMessage: opts.finalMessage,
      detail: 'Unable to recover created issue details from post-run metadata.',
      forceError: true,
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
