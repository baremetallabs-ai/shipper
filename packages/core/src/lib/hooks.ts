import { spawn } from 'node:child_process';
import { access, constants, stat } from 'node:fs/promises';
import path from 'node:path';

const HOOKS_DIR = path.join('.shipper', 'hooks');
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

function spawnAsync(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env: Record<string, string>;
    shell?: boolean;
  }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const stderrChunks: string[] = [];
    const child = spawn(command, args, {
      stdio: ['inherit', 'inherit', 'pipe'],
      env: { ...process.env, ...options.env },
      cwd: options.cwd,
      shell: options.shell,
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrChunks.push(chunk.toString());
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      const err = new Error(`Process exited with code ${code ?? 'unknown'}`) as Error & {
        status: number | 'unknown';
        stderr: string;
      };
      err.status = code ?? 'unknown';
      err.stderr = stderrChunks.join('').trim();
      reject(err);
    });
  });
}

export async function runAdvisoryHook(
  label: string,
  command: string,
  env: Record<string, string>,
  cwd?: string
): Promise<void> {
  try {
    await spawnAsync(command, [], { env, cwd, shell: true });
    console.log(`  ${label} hook completed.`);
  } catch (err) {
    const { code, stderr } = extractExecError(err);
    console.warn(`  Warning: ${label} hook exited with code ${code}${stderr ? ': ' + stderr : ''}`);
  }
}

async function hookExists(hookPath: string): Promise<boolean> {
  try {
    await stat(hookPath);
    return true;
  } catch {
    return false;
  }
}

async function hookIsExecutable(hookPath: string): Promise<boolean> {
  try {
    await access(hookPath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function warnNonExecutableHook(foundPath: string, chmodPath = foundPath): void {
  console.warn(
    `  Warning: Found ${foundPath} but it is not executable — skipping. Run \`chmod +x ${chmodPath}\` to enable.`
  );
}

async function runFileHook(
  hookPath: string,
  label: string,
  env: Record<string, string>,
  options: { blocking: boolean; cwd?: string; resultLabel?: string }
): Promise<void> {
  if (!(await hookExists(hookPath))) return;

  if (!(await hookIsExecutable(hookPath))) {
    warnNonExecutableHook(hookPath);
    return;
  }

  try {
    await spawnAsync(hookPath, [], { env, cwd: options.cwd });
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

export async function runPreHook(stage: string, env: Record<string, string>): Promise<void> {
  await runFileHook(path.resolve(HOOKS_DIR, `pre-${stage}`), `Pre-${stage}`, env, {
    blocking: true,
    resultLabel: `pre-${stage}`,
  });
}

export async function runPostHook(stage: string, env: Record<string, string>): Promise<void> {
  await runFileHook(path.resolve(HOOKS_DIR, `post-${stage}`), `Post-${stage}`, env, {
    blocking: false,
    resultLabel: `post-${stage}`,
  });
}

export async function runWorktreeHook(
  event: WorktreeHookEvent,
  env: Record<string, string>,
  settingsHookCommand: string | undefined,
  cwd?: string
): Promise<void> {
  const meta = WORKTREE_HOOK_META[event];
  const displayPath = path.join(HOOKS_DIR, event);
  const hookPath = path.join(cwd ?? process.cwd(), HOOKS_DIR, event);

  if (await hookExists(hookPath)) {
    if (!(await hookIsExecutable(hookPath))) {
      warnNonExecutableHook(displayPath);
    } else {
      if (settingsHookCommand) {
        console.warn(
          `  Warning: Both ${displayPath} and settings-based hooks.${meta.settingsKey} found. Using file-based hook; settings-based hook skipped.`
        );
      }

      await runFileHook(hookPath, meta.label, env, {
        blocking: false,
        cwd,
        resultLabel: meta.label,
      });
      return;
    }
  }

  if (!settingsHookCommand) return;

  console.warn(
    `  Warning: settings-based hooks.${meta.settingsKey} is deprecated. Move your command to ${displayPath} and make it executable.`
  );
  await runAdvisoryHook(meta.label, settingsHookCommand, env, cwd);
}

export async function withStageHooks<T>(
  stage: string,
  env: { issueNumber?: string; branchName?: string },
  fn: () => Promise<T>
): Promise<T> {
  const hookEnv = {
    SHIPPER_STAGE: stage,
    SHIPPER_ISSUE_NUMBER: env.issueNumber ?? '',
    SHIPPER_BRANCH_NAME: env.branchName ?? '',
  };
  await runPreHook(stage, hookEnv);
  const result = await fn();
  await runPostHook(stage, hookEnv);
  return result;
}
