import { spawn } from 'node:child_process';
import { access, constants, stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { createLogger, getLogCaptureStream, logger } from './logger.js';
import { getSettings } from './settings.js';

const HOOKS_DIR = path.join('.shipper', 'hooks');
const HOOK_KILL_GRACE_MS = 2_000;
const WORKTREE_HOOK_META = {
  'worktree-setup': {
    label: 'Worktree setup',
    exitBlocking: false,
    timeoutBlocking: true,
  },
  'worktree-teardown': {
    label: 'Worktree teardown',
    exitBlocking: false,
    timeoutBlocking: false,
    cancelBlocking: false,
  },
} as const;

type WorktreeHookEvent = keyof typeof WORKTREE_HOOK_META;
type HookProcessErrorKind = 'exit' | 'timeout' | 'cancelled';
type HookSignal = 'SIGTERM' | 'SIGKILL';

class HookProcessError extends Error {
  kind: HookProcessErrorKind;
  code?: number | 'unknown';
  stderr: string;
  label: string;
  timeoutMinutes?: number;

  constructor(
    kind: HookProcessErrorKind,
    label: string,
    options: { code?: number | 'unknown'; stderr?: string; timeoutMinutes?: number } = {}
  ) {
    super(`Hook process ${kind}`);
    this.name = 'HookProcessError';
    this.kind = kind;
    this.code = options.code;
    this.stderr = options.stderr ?? '';
    this.label = label;
    this.timeoutMinutes = options.timeoutMinutes;
  }
}

interface HookRunBehavior {
  exitBlocking: boolean;
  timeoutBlocking: boolean;
  cancelBlocking?: boolean;
  cwd?: string;
  resultLabel?: string;
}

interface HookProcessOptions {
  cwd?: string;
  env: Record<string, string>;
  label: string;
  shell?: boolean;
}

function formatHookProcessError(err: HookProcessError): string {
  if (err.kind === 'timeout') {
    const timeoutMinutes = err.timeoutMinutes ?? getSettings().hookTimeoutMinutes;
    return `${err.label} hook timed out after ${formatMinutes(timeoutMinutes)}`;
  }

  if (err.kind === 'cancelled') {
    return `${err.label} hook cancelled`;
  }

  return `${err.label} hook exited with code ${err.code ?? 'unknown'}${
    err.stderr ? ': ' + err.stderr : ''
  }`;
}

function formatMinutes(minutes: number): string {
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

function runHookProcess(
  command: string,
  args: string[],
  options: HookProcessOptions
): Promise<void> {
  return new Promise((resolve, reject) => {
    const stderrChunks: string[] = [];
    const captureStream = getLogCaptureStream();
    const timeoutMinutes = getSettings().hookTimeoutMinutes;
    let settled = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingFailureKind: Exclude<HookProcessErrorKind, 'exit'> | undefined;
    const child = spawn(command, args, {
      stdio: captureStream ? ['inherit', 'pipe', 'pipe'] : ['inherit', 'inherit', 'pipe'],
      env: { ...process.env, ...options.env },
      cwd: options.cwd,
      shell: options.shell,
      detached: process.platform !== 'win32',
    });
    const childStderr = child.stderr;

    const killChild = (signal: HookSignal) => {
      if (!child.pid || process.platform === 'win32') {
        child.kill(signal);
        return;
      }

      try {
        process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };

    const beginTermination = (kind: Exclude<HookProcessErrorKind, 'exit'>) => {
      pendingFailureKind ??= kind;
      killChild('SIGTERM');
      graceTimer ??= setTimeout(() => {
        killChild('SIGKILL');
      }, HOOK_KILL_GRACE_MS);
    };

    const onSignal = () => {
      beginTermination('cancelled');
    };

    const cleanup = () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = undefined;
      }
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    };

    if (!childStderr) {
      cleanup();
      reject(new Error(`Failed to capture stderr for ${command}`));
      return;
    }

    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    if (timeoutMinutes > 0) {
      timeoutTimer = setTimeout(() => {
        beginTermination('timeout');
      }, timeoutMinutes * 60_000);
    }

    child.stdout?.on('data', (chunk: Buffer | string) => {
      process.stdout.write(chunk);
      captureStream?.write(chunk);
    });
    childStderr.on('data', (chunk: Buffer | string) => {
      process.stderr.write(chunk);
      captureStream?.write(chunk);
      stderrChunks.push(chunk.toString());
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      const stderr = stderrChunks.join('').trim();
      if (pendingFailureKind) {
        reject(new HookProcessError(pendingFailureKind, options.label, { stderr, timeoutMinutes }));
        return;
      }

      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new HookProcessError('exit', options.label, {
          code: code ?? 'unknown',
          stderr,
        })
      );
    });
  });
}

export async function runAdvisoryHook(
  label: string,
  command: string,
  env: Record<string, string>,
  cwd?: string,
  options: Partial<
    Pick<HookRunBehavior, 'exitBlocking' | 'timeoutBlocking' | 'cancelBlocking'>
  > = {}
): Promise<void> {
  const behavior = {
    exitBlocking: false,
    timeoutBlocking: false,
    cancelBlocking: false,
    ...options,
  };
  try {
    await runHookProcess(command, [], { env, cwd, shell: true, label });
    logger.log(`  ${label} hook completed.`);
  } catch (err) {
    if (!(err instanceof HookProcessError)) {
      throw err;
    }

    const message = formatHookProcessError(err);
    const shouldThrow =
      (err.kind === 'exit' && behavior.exitBlocking) ||
      (err.kind === 'timeout' && behavior.timeoutBlocking) ||
      (err.kind === 'cancelled' && behavior.cancelBlocking);

    if (shouldThrow) {
      throw new Error(message);
    }

    logger.warn(`  Warning: ${message}`);
  }
}

async function hookExists(hookPath: string): Promise<boolean> {
  try {
    await stat(hookPath);
    return true;
  } catch {
    // File doesn't exist — no hook to run.
    return false;
  }
}

async function hookIsExecutable(hookPath: string): Promise<boolean> {
  try {
    await access(hookPath, constants.X_OK);
    return true;
  } catch {
    // Not executable — caller handles the warning.
    return false;
  }
}

function warnNonExecutableHook(foundPath: string, chmodPath = foundPath): void {
  logger.warn(
    `  Warning: Found ${foundPath} but it is not executable — skipping. Run \`chmod +x ${chmodPath}\` to enable.`
  );
}

async function runFileHook(
  hookPath: string,
  label: string,
  env: Record<string, string>,
  options: HookRunBehavior
): Promise<void> {
  if (!(await hookExists(hookPath))) return;

  if (!(await hookIsExecutable(hookPath))) {
    warnNonExecutableHook(hookPath);
    return;
  }

  try {
    await runHookProcess(hookPath, [], {
      env,
      cwd: options.cwd,
      label: options.resultLabel ?? label,
    });
    logger.log(`  ${label} hook completed.`);
  } catch (err) {
    if (!(err instanceof HookProcessError)) {
      throw err;
    }

    const message = formatHookProcessError(err);
    const shouldThrow =
      (err.kind === 'exit' && options.exitBlocking) ||
      (err.kind === 'timeout' && options.timeoutBlocking) ||
      (err.kind === 'cancelled' && (options.cancelBlocking ?? options.timeoutBlocking));

    if (shouldThrow) {
      throw new Error(message);
    }

    logger.warn(`  Warning: ${message}`);
  }
}

export async function runPreHook(stage: string, env: Record<string, string>): Promise<void> {
  await runFileHook(path.resolve(HOOKS_DIR, `pre-${stage}`), `Pre-${stage}`, env, {
    exitBlocking: true,
    timeoutBlocking: true,
    resultLabel: `pre-${stage}`,
  });
}

export async function runPostHook(stage: string, env: Record<string, string>): Promise<void> {
  await runFileHook(path.resolve(HOOKS_DIR, `post-${stage}`), `Post-${stage}`, env, {
    exitBlocking: false,
    timeoutBlocking: false,
    resultLabel: `post-${stage}`,
  });
}

export async function runWorktreeHook(
  event: WorktreeHookEvent,
  env: Record<string, string>,
  cwd?: string
): Promise<void> {
  const meta = WORKTREE_HOOK_META[event];
  const displayPath = path.join(HOOKS_DIR, event);
  const hookPath = path.join(cwd ?? process.cwd(), HOOKS_DIR, event);

  if (!(await hookExists(hookPath))) return;

  if (!(await hookIsExecutable(hookPath))) {
    warnNonExecutableHook(displayPath);
    return;
  }

  await runFileHook(hookPath, meta.label, env, {
    exitBlocking: meta.exitBlocking,
    timeoutBlocking: meta.timeoutBlocking,
    cancelBlocking: 'cancelBlocking' in meta ? meta.cancelBlocking : undefined,
    cwd,
    resultLabel: meta.label,
  });
}

export async function withStageHooks<T>(
  stage: string,
  env: { issueNumber?: string; branchName?: string },
  fn: () => Promise<T>
): Promise<T> {
  const stageLogger = createLogger();
  const issueNumber = env.issueNumber ?? '';
  const hookEnv = {
    SHIPPER_STAGE: stage,
    SHIPPER_ISSUE_NUMBER: issueNumber,
    SHIPPER_BRANCH_NAME: env.branchName ?? '',
  };
  stageLogger.stageStart(stage, issueNumber);
  const startedAt = performance.now();

  try {
    await runPreHook(stage, hookEnv);
    const result = await fn();
    await runPostHook(stage, hookEnv);
    stageLogger.stageComplete(stage, issueNumber, performance.now() - startedAt);
    return result;
  } catch (error) {
    stageLogger.stageFailed(stage, issueNumber, performance.now() - startedAt);
    throw error;
  }
}
