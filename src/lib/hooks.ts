import { execFileSync, execSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';

const WORKTREE_HOOK_META = {
  'worktree-setup': {
    label: 'Worktree setup',
    settingsKey: 'worktreeSetup',
  },
  'worktree-teardown': {
    label: 'Worktree teardown',
    settingsKey: 'worktreeTeardown',
  },
} as const;

type WorktreeHookEvent = keyof typeof WORKTREE_HOOK_META;

function extractExecError(err: unknown): { code: number | 'unknown'; stderr: string } {
  const rawStatus =
    err && typeof err === 'object' && 'status' in err
      ? (err as { status: unknown }).status
      : undefined;
  const code = typeof rawStatus === 'number' ? rawStatus : 'unknown';
  const stderr =
    err && typeof err === 'object' && 'stderr' in err
      ? String((err as { stderr: unknown }).stderr).trim()
      : '';
  return { code, stderr };
}

export function runAdvisoryHook(
  label: string,
  command: string,
  env: Record<string, string>,
  cwd?: string
): void {
  try {
    execSync(command, {
      stdio: ['inherit', 'inherit', 'pipe'],
      env: { ...process.env, ...env },
      cwd,
    });
    console.log(`  ${label} hook completed.`);
  } catch (err) {
    const { code, stderr } = extractExecError(err);
    console.warn(`  Warning: ${label} hook exited with code ${code}${stderr ? ': ' + stderr : ''}`);
  }
}

function hookExists(hookPath: string): boolean {
  try {
    statSync(hookPath);
    return true;
  } catch {
    return false;
  }
}

function hookIsExecutable(hookPath: string): boolean {
  try {
    accessSync(hookPath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function runFileHook(
  hookPath: string,
  label: string,
  env: Record<string, string>,
  options: { blocking: boolean; cwd?: string; resultLabel?: string }
): void {
  if (!hookExists(hookPath)) return;

  if (!hookIsExecutable(hookPath)) {
    console.warn(
      `  Warning: Found ${hookPath} but it is not executable — skipping. Run \`chmod +x ${hookPath}\` to enable.`
    );
    return;
  }

  try {
    execFileSync(hookPath, [], {
      stdio: ['inherit', 'inherit', 'pipe'],
      env: { ...process.env, ...env },
      cwd: options.cwd,
    });
    console.log(`  ${label} hook completed.`);
  } catch (err) {
    const { code, stderr } = extractExecError(err);
    const resultLabel = options.resultLabel ?? label;
    const message = `${resultLabel} hook exited with code ${code}${stderr ? ': ' + stderr : ''}`;

    if (options.blocking) {
      throw new Error(message);
    }

    console.warn(`  Warning: ${message}`);
  }
}

export function runPreHook(stage: string, env: Record<string, string>): void {
  runFileHook(path.resolve('.shipper', 'hooks', `pre-${stage}`), `Pre-${stage}`, env, {
    blocking: true,
    resultLabel: `pre-${stage}`,
  });
}

export function runPostHook(stage: string, env: Record<string, string>): void {
  runFileHook(path.resolve('.shipper', 'hooks', `post-${stage}`), `Post-${stage}`, env, {
    blocking: false,
    resultLabel: `post-${stage}`,
  });
}

export function runWorktreeHook(
  event: WorktreeHookEvent,
  env: Record<string, string>,
  settingsHookCommand: string | undefined,
  cwd?: string
): void {
  const meta = WORKTREE_HOOK_META[event];
  const hookPath = path.resolve('.shipper', 'hooks', event);

  if (hookExists(hookPath)) {
    if (settingsHookCommand) {
      console.warn(
        `  Warning: Both ${hookPath} and settings-based hooks.${meta.settingsKey} found. Using file-based hook; settings-based hook skipped.`
      );
    }

    runFileHook(hookPath, meta.label, env, {
      blocking: false,
      cwd,
      resultLabel: meta.label,
    });
    return;
  }

  if (!settingsHookCommand) return;

  console.warn(
    `  Warning: settings-based hooks.${meta.settingsKey} is deprecated. Move your command to ${hookPath} and make it executable.`
  );
  runAdvisoryHook(meta.label, settingsHookCommand, env, cwd);
}

export function withStageHooks<T>(
  stage: string,
  env: { issueNumber?: string; branchName?: string },
  fn: () => T
): T {
  const hookEnv = {
    SHIPPER_STAGE: stage,
    SHIPPER_ISSUE_NUMBER: env.issueNumber ?? '',
    SHIPPER_BRANCH_NAME: env.branchName ?? '',
  };
  runPreHook(stage, hookEnv);
  const result = fn();
  runPostHook(stage, hookEnv);
  return result;
}
