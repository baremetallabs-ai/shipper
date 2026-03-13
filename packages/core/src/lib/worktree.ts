import { execFile, spawn } from 'node:child_process';
import { access, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { runAdvisoryHook, runWorktreeHook } from './hooks.js';
import { getSettings } from './settings.js';

const WORKTREES_DIR = path.join(homedir(), '.shipper', 'worktrees');
const execFileAsync = promisify(execFile);
const MAX_REBASE_ATTEMPTS = 3;
const CONFLICT_BLOCK_PATTERN = /^<{7}.*$\n[\s\S]*?^={7}$\n[\s\S]*?^>{7}.*(?:\n|$)?/gm;

interface CommandOpts {
  cwd?: string;
  env?: typeof process.env;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

interface ExecFileError extends Error {
  code?: number | string;
  stdout?: string;
  stderr?: string;
}

interface ErrnoError extends Error {
  code?: string;
}

export interface WorktreeGitOpts {
  wtPath: string;
  repoRoot: string;
  baseBranch: string;
  pushMode: 'new-branch' | 'force-with-lease';
}

export interface ConflictContext {
  files: string[];
  conflicts: Array<{
    path: string;
    markers: string[];
  }>;
  continueError?: string;
}

function spawnAsync(command: string, args: string[], opts: CommandOpts = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code ?? 'unknown'}`));
    });
  });
}

async function execAsync(
  command: string,
  args: string[],
  opts: CommandOpts = {}
): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr, code: 0 });
          return;
        }

        if (error instanceof Error) {
          const execError = error as ExecFileError;
          resolve({
            stdout: stdout || execError.stdout || '',
            stderr: stderr || execError.stderr || '',
            code: typeof execError.code === 'number' ? execError.code : 1,
          });
          return;
        }

        reject(error);
      }
    );
  });
}

function formatCommandFailure(command: string, args: string[], result: CommandResult): string {
  const output = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n');
  if (!output) {
    return `${command} ${args.join(' ')} exited with code ${result.code}`;
  }
  return `${command} ${args.join(' ')} exited with code ${result.code}:\n${output}`;
}

function formatTransportError(opts: WorktreeGitOpts, detail: string): Error {
  return new Error(`Git transport failed in ${opts.wtPath} for repo ${opts.repoRoot}: ${detail}`);
}

async function listConflictedFiles(wtPath: string): Promise<string[]> {
  const result = await execAsync('git', ['diff', '--name-only', '--diff-filter=U'], {
    cwd: wtPath,
  });
  if (result.code !== 0) {
    throw new Error(
      formatCommandFailure('git', ['diff', '--name-only', '--diff-filter=U'], result)
    );
  }

  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function extractConflictMarkers(wtPath: string, relativePath: string): Promise<string[]> {
  const filePath = path.join(wtPath, relativePath);
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (error) {
    if ((error as ErrnoError).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const matches = [...content.matchAll(CONFLICT_BLOCK_PATTERN)].map((match) => match[0].trimEnd());
  return matches;
}

async function buildConflictContext(
  wtPath: string,
  continueError?: string
): Promise<ConflictContext | undefined> {
  const files = await listConflictedFiles(wtPath);
  if (files.length === 0) {
    return undefined;
  }

  const conflicts: ConflictContext['conflicts'] = [];
  for (const file of files) {
    conflicts.push({
      path: file,
      markers: await extractConflictMarkers(wtPath, file),
    });
  }

  return { files, conflicts, continueError };
}

function getRetryFailureText(result: CommandResult): string {
  const output = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n');
  return output || `git rebase --continue exited with code ${result.code}`;
}

async function abortRebase(wtPath: string): Promise<string | undefined> {
  try {
    await spawnAsync('git', ['rebase', '--abort'], { cwd: wtPath });
    return undefined;
  } catch (error) {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}

function appendAbortFailure(detail: string, abortFailure?: string): string {
  if (!abortFailure) {
    return detail;
  }

  return `${detail}\nA best-effort git rebase --abort also failed: ${abortFailure}`;
}

async function getConflictContextOrThrow(
  opts: WorktreeGitOpts,
  result: CommandResult,
  continueError?: string
): Promise<ConflictContext> {
  const conflictContext = await buildConflictContext(opts.wtPath, continueError);
  if (conflictContext) {
    return conflictContext;
  }

  const abortFailure = await abortRebase(opts.wtPath);
  throw formatTransportError(
    opts,
    appendAbortFailure(
      `git rebase origin/${opts.baseBranch} failed without unresolved files.\n${formatCommandFailure(
        'git',
        ['rebase', `origin/${opts.baseBranch}`],
        result
      )}`,
      abortFailure
    )
  );
}

async function pushWorktreeBranch(opts: WorktreeGitOpts): Promise<void> {
  const args =
    opts.pushMode === 'new-branch'
      ? ['push', '-u', 'origin', 'HEAD']
      : ['push', '--force-with-lease'];
  await spawnAsync('git', args, { cwd: opts.wtPath });
}

export function formatConflictContext(conflictContext: ConflictContext): string {
  const lines = [
    '## Merge Conflict Resolution Required',
    '',
    'The following files still have merge conflicts that must be resolved before the rebase can continue:',
    '',
    ...conflictContext.files.map((file) => `- ${file}`),
  ];

  if (conflictContext.continueError) {
    lines.push(
      '',
      'A previous `git rebase --continue` attempt failed with:',
      '',
      '```text',
      conflictContext.continueError,
      '```'
    );
  }

  for (const conflict of conflictContext.conflicts) {
    lines.push('', `### ${conflict.path}`);
    if (conflict.markers.length === 0) {
      lines.push(
        '',
        'No inline conflict markers were found for this path. It may be a binary or delete/modify conflict. Resolve the file state directly, then stage it with `git add`.'
      );
      continue;
    }

    for (const marker of conflict.markers) {
      lines.push('', '```diff', marker, '```');
    }
  }

  lines.push(
    '',
    'Resolve all conflicts, then use `git add` to stage the resolved files and `git commit` if Git asks for it. Do not run `git rebase --continue`, `git rebase --abort`, or `git push` yourself.'
  );

  return lines.join('\n');
}

export async function withGitTransport(
  opts: WorktreeGitOpts,
  runAgent: (conflictContext?: ConflictContext) => Promise<number>
): Promise<number> {
  await spawnAsync('git', ['fetch', 'origin'], { cwd: opts.wtPath });

  const initialRebase = await execAsync('git', ['rebase', `origin/${opts.baseBranch}`], {
    cwd: opts.wtPath,
  });

  if (initialRebase.code === 0) {
    const agentCode = await runAgent();
    if (agentCode !== 0) {
      return agentCode;
    }

    await pushWorktreeBranch(opts);
    return 0;
  }

  let conflictContext = await getConflictContextOrThrow(opts, initialRebase);

  for (let attempt = 1; attempt <= MAX_REBASE_ATTEMPTS; attempt++) {
    const agentCode = await runAgent(conflictContext);
    if (agentCode !== 0) {
      return agentCode;
    }

    const continueResult = await execAsync('git', ['rebase', '--continue'], {
      cwd: opts.wtPath,
      env: { GIT_EDITOR: 'true' },
    });
    if (continueResult.code === 0) {
      await pushWorktreeBranch(opts);
      return 0;
    }

    const continueError = getRetryFailureText(continueResult);
    if (attempt === MAX_REBASE_ATTEMPTS) {
      const abortFailure = await abortRebase(opts.wtPath);
      throw formatTransportError(
        opts,
        appendAbortFailure(
          `Could not complete rebase onto origin/${opts.baseBranch} after ${MAX_REBASE_ATTEMPTS} conflict resolution attempts.\n${continueError}`,
          abortFailure
        )
      );
    }

    const nextConflictContext = await buildConflictContext(opts.wtPath, continueError);
    if (!nextConflictContext) {
      const abortFailure = await abortRebase(opts.wtPath);
      throw formatTransportError(
        opts,
        appendAbortFailure(
          `git rebase --continue failed without unresolved files.\n${formatCommandFailure(
            'git',
            ['rebase', '--continue'],
            continueResult
          )}`,
          abortFailure
        )
      );
    }
    conflictContext = nextConflictContext;
  }

  throw formatTransportError(
    opts,
    `Could not complete rebase onto origin/${opts.baseBranch} after ${MAX_REBASE_ATTEMPTS} conflict resolution attempts.`
  );
}

export function getWorktreePath(repoRoot: string, branch: string): string {
  const repoName = path.basename(repoRoot);
  const safeBranch = branch.replace(/\//g, '-');
  return path.join(WORKTREES_DIR, `${repoName}--wt--${safeBranch}`);
}

export interface CreateWorktreeOpts {
  repoRoot: string;
  branch: string;
  createBranch: boolean;
  issueNumber?: string;
  stage?: string;
}

export async function createWorktree(opts: CreateWorktreeOpts): Promise<string> {
  const wtPath = getWorktreePath(opts.repoRoot, opts.branch);

  try {
    await access(wtPath);
    // Clean up stale worktree from a previous crashed run
    try {
      await spawnAsync('git', ['worktree', 'remove', '--force', wtPath], { cwd: opts.repoRoot });
    } catch {
      // If git worktree remove fails, try just deleting the directory
    }
  } catch {
    // Worktree doesn't exist
  }

  await mkdir(WORKTREES_DIR, { recursive: true });

  const args = ['worktree', 'add'];
  if (opts.createBranch) {
    // Check if branch already exists (e.g. from a previous crashed run)
    let branchExists = false;
    try {
      await execFileAsync('git', ['rev-parse', '--verify', opts.branch], {
        cwd: opts.repoRoot,
      });
      branchExists = true;
    } catch {
      // Branch doesn't exist — create it
      args.push('-b', opts.branch);
    }
    args.push(wtPath);
    if (branchExists) {
      args.push(opts.branch);
    }
  } else {
    args.push(wtPath, opts.branch);
  }

  await spawnAsync('git', args, { cwd: opts.repoRoot });

  return wtPath;
}

export async function removeWorktree(repoRoot: string, wtPath: string): Promise<void> {
  try {
    await spawnAsync('git', ['worktree', 'remove', '--force', wtPath], { cwd: repoRoot });
  } catch {
    // Idempotent — ignore errors if already removed
  }
}

export async function withWorktree<T>(
  opts: CreateWorktreeOpts,
  fn: (wtPath: string) => Promise<T>
): Promise<T> {
  const wtPath = await createWorktree(opts);
  const hookEnv = {
    SHIPPER_STAGE: opts.stage ?? '',
    SHIPPER_WORKTREE_PATH: wtPath,
    SHIPPER_ISSUE_NUMBER: opts.issueNumber ?? '',
    SHIPPER_BRANCH_NAME: opts.branch,
  };

  const settings = getSettings();
  const worktreeEnv = {
    NPM_CONFIG_CACHE: path.join(wtPath, '.npm-cache'),
    ...(settings.worktreeEnv ?? {}),
  };
  const originalEnv = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(worktreeEnv)) {
    originalEnv.set(key, process.env[key]);
    process.env[key] = value;
  }

  const { worktreeSetup, worktreeTeardown } = settings.hooks;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = async () => {
    cleanupPromise ??= (async () => {
      for (const [key, value] of originalEnv) {
        if (value === undefined) {
          Reflect.deleteProperty(process.env, key);
          continue;
        }
        process.env[key] = value;
      }

      await runWorktreeHook('worktree-teardown', hookEnv, worktreeTeardown, wtPath);
      await removeWorktree(opts.repoRoot, wtPath);
    })();

    await cleanupPromise;
  };

  const cleanupWithoutAwait = () => {
    void cleanup();
  };

  process.on('SIGINT', cleanupWithoutAwait);
  process.on('SIGTERM', cleanupWithoutAwait);

  const { installCommand } = settings;
  try {
    if (installCommand) {
      await runAdvisoryHook('Install dependencies', installCommand, hookEnv, wtPath);
    }

    await runWorktreeHook('worktree-setup', hookEnv, worktreeSetup, wtPath);
    return await fn(wtPath);
  } finally {
    process.removeListener('SIGINT', cleanupWithoutAwait);
    process.removeListener('SIGTERM', cleanupWithoutAwait);
    await cleanup();
  }
}
