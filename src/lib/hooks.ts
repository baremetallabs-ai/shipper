import { execFileSync, execSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';

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
    const rawStatus =
      err && typeof err === 'object' && 'status' in err
        ? (err as { status: unknown }).status
        : undefined;
    const code = typeof rawStatus === 'number' ? rawStatus : 'unknown';
    const stderr =
      err && typeof err === 'object' && 'stderr' in err
        ? String((err as { stderr: unknown }).stderr).trim()
        : '';
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

export function runPreHook(stage: string, env: Record<string, string>): void {
  const hookPath = path.resolve('.shipper', 'hooks', `pre-${stage}`);

  if (!hookExists(hookPath)) return;
  if (!hookIsExecutable(hookPath)) return;

  try {
    execFileSync(hookPath, [], {
      stdio: ['inherit', 'inherit', 'pipe'],
      env: { ...process.env, ...env },
    });
    console.log(`  Pre-${stage} hook completed.`);
  } catch (err) {
    const rawStatus =
      err && typeof err === 'object' && 'status' in err
        ? (err as { status: unknown }).status
        : undefined;
    const code = typeof rawStatus === 'number' ? rawStatus : 'unknown';
    const stderr =
      err && typeof err === 'object' && 'stderr' in err
        ? String((err as { stderr: unknown }).stderr).trim()
        : '';
    throw new Error(`pre-${stage} hook exited with code ${code}${stderr ? ': ' + stderr : ''}`);
  }
}

export function runPostHook(stage: string, env: Record<string, string>): void {
  const hookPath = path.resolve('.shipper', 'hooks', `post-${stage}`);

  if (!hookExists(hookPath)) return;
  if (!hookIsExecutable(hookPath)) return;

  try {
    execFileSync(hookPath, [], {
      stdio: ['inherit', 'inherit', 'pipe'],
      env: { ...process.env, ...env },
    });
    console.log(`  Post-${stage} hook completed.`);
  } catch (err) {
    const rawStatus =
      err && typeof err === 'object' && 'status' in err
        ? (err as { status: unknown }).status
        : undefined;
    const code = typeof rawStatus === 'number' ? rawStatus : 'unknown';
    const stderr =
      err && typeof err === 'object' && 'stderr' in err
        ? String((err as { stderr: unknown }).stderr).trim()
        : '';
    console.warn(
      `  Warning: post-${stage} hook exited with code ${code}${stderr ? ': ' + stderr : ''}`
    );
  }
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
