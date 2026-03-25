import { execFile, spawn } from 'node:child_process';
import { access, mkdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { runAdvisoryHook, runWorktreeHook } from './hooks.js';
import { getSettings } from './settings.js';

const WORKTREES_DIR = path.join(homedir(), '.shipper', 'worktrees');
const execFileAsync = promisify(execFile);
const MAX_REBASE_ATTEMPTS = 3;
const MAX_PUSH_ATTEMPTS = 3;
const INSTALL_OUTPUT_MAX_BUFFER = Number.POSITIVE_INFINITY;
const PUSH_OUTPUT_MAX_BUFFER = 10 * 1024 * 1024;
const HOOK_FAILURE_PATTERN = /husky|lefthook|pre-push|simple-git-hooks|overcommit/i;
const CONFLICT_BLOCK_PATTERN = /^<{7}.*$\n[\s\S]*?^={7}$\n[\s\S]*?^>{7}.*(?:\n|$)?/gm;
const PROTECTED_SHIPPER_DIRS = ['.shipper/output/', '.shipper/input/', '.shipper/tmp/'];

interface CommandOpts {
  cwd?: string;
  env?: typeof process.env;
  maxBuffer?: number;
  shell?: boolean;
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

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  if (typeof error === 'string') {
    return new Error(error);
  }

  if (typeof error === 'undefined') {
    return new Error('Unknown child process error');
  }

  return new Error(JSON.stringify(error));
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
      shell: opts.shell,
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
        maxBuffer: opts.maxBuffer,
        shell: opts.shell,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr, code: 0 });
          return;
        }

        if (error instanceof Error) {
          const execError = error as ExecFileError;
          const capturedStdout = stdout || execError.stdout || '';
          const capturedStderr = stderr || execError.stderr || '';
          resolve({
            stdout: capturedStdout,
            stderr:
              capturedStderr || (typeof execError.code === 'number' ? '' : execError.message || ''),
            code: typeof execError.code === 'number' ? execError.code : 1,
          });
          return;
        }

        reject(toError(error));
      }
    );
  });
}

function formatCommandFailure(command: string, args: string[], result: CommandResult): string {
  const commandText = args.length > 0 ? `${command} ${args.join(' ')}` : command;
  const output = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n');
  if (!output) {
    return `${commandText} exited with code ${result.code}`;
  }
  return `${commandText} exited with code ${result.code}:\n${output}`;
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

async function stageResolvedFiles(wtPath: string): Promise<void> {
  await execAsync('git', ['add', '-u'], { cwd: wtPath });
}

function getRetryFailureText(result: CommandResult): string {
  const output = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n');
  return output || `git rebase --continue exited with code ${result.code}`;
}

async function isRebaseComplete(wtPath: string): Promise<boolean> {
  const result = await execAsync('git', ['rev-parse', '--git-dir'], { cwd: wtPath });
  if (result.code !== 0) {
    return false;
  }
  const gitDir = path.resolve(wtPath, result.stdout.trim());
  for (const dir of ['rebase-merge', 'rebase-apply']) {
    try {
      await access(path.join(gitDir, dir));
      return false;
    } catch {
      // directory doesn't exist — expected when rebase is done
    }
  }
  return true;
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
  targetRef: string,
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
      `git rebase --autostash ${targetRef} failed without unresolved files.\n${formatCommandFailure(
        'git',
        ['rebase', '--autostash', targetRef],
        result
      )}`,
      abortFailure
    )
  );
}

async function getCurrentBranch(opts: WorktreeGitOpts): Promise<string> {
  const result = await execAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: opts.wtPath,
  });
  if (result.code !== 0) {
    throw formatTransportError(
      opts,
      formatCommandFailure('git', ['rev-parse', '--abbrev-ref', 'HEAD'], result)
    );
  }

  return result.stdout.trim();
}

async function remoteRefExists(opts: WorktreeGitOpts, targetRef: string): Promise<boolean> {
  const result = await execAsync('git', ['rev-parse', '--verify', targetRef], { cwd: opts.wtPath });
  return result.code === 0;
}

export async function getGitRevParse(cwd: string, ref: string): Promise<string> {
  const result = await execAsync('git', ['rev-parse', ref], { cwd });
  if (result.code !== 0) {
    const output = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n');
    throw new Error(`git rev-parse ${ref} failed${output ? `: ${output}` : ''}`);
  }

  return result.stdout.trim();
}

export async function getCommitsAheadCount(wtPath: string, baseBranch: string): Promise<number> {
  const args = ['rev-list', '--count', `origin/${baseBranch}..HEAD`];
  const result = await execAsync('git', args, { cwd: wtPath });
  if (result.code !== 0) {
    throw new Error(formatCommandFailure('git', args, result));
  }

  const trimmedStdout = result.stdout.trim();
  const commitsAhead = Number.parseInt(trimmedStdout, 10);
  if (Number.isNaN(commitsAhead)) {
    const output = [result.stderr.trim(), trimmedStdout].filter(Boolean).join('\n');
    throw new Error(
      `git ${args.join(' ')} returned a non-numeric commit count${output ? `:\n${output}` : ''}`
    );
  }

  return commitsAhead;
}

async function syncWithRemoteBranch(opts: WorktreeGitOpts): Promise<void> {
  const currentBranch = await getCurrentBranch(opts);
  const remoteRef = `origin/${currentBranch}`;
  if (await remoteRefExists(opts, remoteRef)) {
    const args = ['reset', '--hard', remoteRef];
    const result = await execAsync('git', args, { cwd: opts.wtPath });
    if (result.code !== 0) {
      throw formatTransportError(
        opts,
        `Failed to sync with remote branch ${remoteRef}.\n${formatCommandFailure('git', args, result)}`
      );
    }
  }
}

async function fetchOriginOrThrow(opts: WorktreeGitOpts): Promise<void> {
  try {
    await spawnAsync('git', ['fetch', 'origin'], { cwd: opts.wtPath });
  } catch (error) {
    throw formatTransportError(
      opts,
      `git fetch origin failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function runPostRebaseInstall(cwd: string): Promise<string | undefined> {
  const { installCommand } = getSettings();
  if (!installCommand) {
    return undefined;
  }

  const result = await execAsync(installCommand, [], {
    cwd,
    shell: true,
    maxBuffer: INSTALL_OUTPUT_MAX_BUFFER,
  });
  if (result.code === 0) {
    return undefined;
  }

  return formatCommandFailure(installCommand, [], result);
}

async function installWithRemediation(
  cwd: string,
  remediate?: (installError: string) => Promise<number>
): Promise<number | undefined> {
  let installError = await runPostRebaseInstall(cwd);
  if (!installError) {
    return undefined;
  }

  if (!remediate) {
    throw new Error(`Post-rebase install failed:\n${installError}`);
  }

  for (let attempt = 1; attempt <= MAX_REBASE_ATTEMPTS; attempt++) {
    const agentCode = await remediate(installError);
    if (agentCode !== 0) {
      return agentCode;
    }

    installError = await runPostRebaseInstall(cwd);
    if (!installError) {
      return undefined;
    }
  }

  throw new Error(
    `Post-rebase install failed after ${MAX_REBASE_ATTEMPTS} remediation attempts:\n${installError}`
  );
}

function getPushArgs(pushMode: WorktreeGitOpts['pushMode'], forcePushBranch?: string): string[] {
  return pushMode === 'new-branch'
    ? ['push', '-u', 'origin', 'HEAD']
    : forcePushBranch
      ? ['push', '--force-with-lease', 'origin', `HEAD:refs/heads/${forcePushBranch}`]
      : ['push', '--force-with-lease'];
}

async function stripProtectedPaths(opts: WorktreeGitOpts): Promise<void> {
  const lsFilesArgs = ['ls-files', '--', ...PROTECTED_SHIPPER_DIRS];
  const lsFilesResult = await execAsync('git', lsFilesArgs, {
    cwd: opts.wtPath,
  });
  if (lsFilesResult.code !== 0) {
    return;
  }

  const trackedFiles = lsFilesResult.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((file) => path.basename(file) !== '.gitkeep');

  if (trackedFiles.length === 0) {
    return;
  }

  const rmArgs = ['rm', '--cached', '--', ...trackedFiles];
  const rmResult = await execAsync('git', rmArgs, {
    cwd: opts.wtPath,
  });
  if (rmResult.code !== 0) {
    throw formatTransportError(opts, formatCommandFailure('git', rmArgs, rmResult));
  }

  const amendArgs = ['commit', '--amend', '--allow-empty', '--no-edit'];
  const amendResult = await execAsync('git', amendArgs, {
    cwd: opts.wtPath,
    env: { GIT_EDITOR: 'true' },
  });
  if (amendResult.code !== 0) {
    throw formatTransportError(opts, formatCommandFailure('git', amendArgs, amendResult));
  }

  console.error(
    `Stripped ${trackedFiles.length} tracked .shipper/ artifact files from git index before push`
  );
}

async function pushWorktreeBranch(
  opts: WorktreeGitOpts,
  pushMode: WorktreeGitOpts['pushMode'],
  forcePushBranch?: string
): Promise<CommandResult> {
  if (pushMode === 'force-with-lease') {
    let commitsAhead: number | undefined;

    try {
      commitsAhead = await getCommitsAheadCount(opts.wtPath, opts.baseBranch);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(
        `Commit-count safety check failed before force-push; proceeding with push.\n${errorMessage}`
      );
    }

    if (commitsAhead === 0) {
      throw formatTransportError(
        opts,
        'Refusing to push: branch has 0 commits ahead of base branch'
      );
    }
  }

  await stripProtectedPaths(opts);

  const checkoutResult = await execAsync('git', ['checkout', 'HEAD', '--', '.'], {
    cwd: opts.wtPath,
  });
  if (checkoutResult.code !== 0) {
    throw formatTransportError(
      opts,
      `Failed to clean tracked files before push: ${formatCommandFailure('git', ['checkout', 'HEAD', '--', '.'], checkoutResult)}`
    );
  }

  const cleanResult = await execAsync('git', ['clean', '-fd', '--exclude=.shipper'], {
    cwd: opts.wtPath,
    maxBuffer: PUSH_OUTPUT_MAX_BUFFER,
  });
  if (cleanResult.code !== 0) {
    throw formatTransportError(
      opts,
      `Failed to remove untracked files before push: ${formatCommandFailure('git', ['clean', '-fd', '--exclude=.shipper'], cleanResult)}`
    );
  }

  return await execAsync('git', getPushArgs(pushMode, forcePushBranch), {
    cwd: opts.wtPath,
    maxBuffer: PUSH_OUTPUT_MAX_BUFFER,
  });
}

export async function pushWithRetry(
  opts: WorktreeGitOpts,
  runAgent: (
    conflictContext?: ConflictContext,
    pushError?: string,
    installError?: string
  ) => Promise<number>
): Promise<number> {
  let retries = 0;
  let pushMode = opts.pushMode;
  let forcePushBranch: string | undefined;
  if (pushMode === 'force-with-lease') {
    forcePushBranch = await getCurrentBranch(opts);
  }

  for (;;) {
    const pushArgs = getPushArgs(pushMode, forcePushBranch);
    const pushResult = await pushWorktreeBranch(opts, pushMode, forcePushBranch);
    if (pushResult.code === 0) {
      return 0;
    }

    const pushOutput = [pushResult.stderr.trim(), pushResult.stdout.trim()]
      .filter(Boolean)
      .join('\n');
    const pushError = formatCommandFailure('git', pushArgs, pushResult);
    if (retries === MAX_PUSH_ATTEMPTS) {
      throw formatTransportError(
        opts,
        `Push failed after ${MAX_PUSH_ATTEMPTS} retry attempts.\n${pushError}`
      );
    }

    if (!HOOK_FAILURE_PATTERN.test(pushOutput)) {
      await fetchOriginOrThrow(opts);

      const currentBranch = await getCurrentBranch(opts);
      const targetRef = `origin/${currentBranch}`;
      if (await remoteRefExists(opts, targetRef)) {
        const rebaseResult = await execAsync('git', ['rebase', '--autostash', targetRef], {
          cwd: opts.wtPath,
        });

        if (rebaseResult.code !== 0) {
          let conflictContext = await getConflictContextOrThrow(opts, targetRef, rebaseResult);

          for (let attempt = 1; attempt <= MAX_REBASE_ATTEMPTS; attempt++) {
            const agentCode = await runAgent(conflictContext);
            if (agentCode !== 0) {
              console.error(`Agent exited with code ${agentCode} — skipping push.`);
              return agentCode;
            }

            await stageResolvedFiles(opts.wtPath);
            const continueResult = await execAsync('git', ['rebase', '--continue'], {
              cwd: opts.wtPath,
              env: { GIT_EDITOR: 'true' },
            });
            if (continueResult.code === 0) {
              break;
            }

            const continueError = getRetryFailureText(continueResult);
            if (attempt === MAX_REBASE_ATTEMPTS) {
              const abortFailure = await abortRebase(opts.wtPath);
              throw formatTransportError(
                opts,
                appendAbortFailure(
                  `Could not complete rebase onto ${targetRef} after ${MAX_REBASE_ATTEMPTS} conflict resolution attempts.\n${continueError}`,
                  abortFailure
                )
              );
            }

            const nextConflictContext = await buildConflictContext(opts.wtPath, continueError);
            if (!nextConflictContext) {
              if (await isRebaseComplete(opts.wtPath)) {
                break;
              }

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
        }

        if (pushMode === 'new-branch') {
          pushMode = 'force-with-lease';
          forcePushBranch = currentBranch;
        }
      }
    }

    const agentCode = await runAgent(undefined, pushError);
    if (agentCode !== 0) {
      console.error(`Agent exited with code ${agentCode} while handling push failure; retrying.`);
    }

    retries += 1;
  }
}

export async function syncWorktree(
  opts: WorktreeGitOpts,
  resolveConflicts: (conflictContext: ConflictContext) => Promise<number>,
  remediateInstallError?: (installError: string) => Promise<number>
): Promise<void> {
  await spawnAsync('git', ['fetch', 'origin'], { cwd: opts.wtPath });
  await syncWithRemoteBranch(opts);

  const initialRebase = await execAsync(
    'git',
    ['rebase', '--autostash', `origin/${opts.baseBranch}`],
    { cwd: opts.wtPath }
  );
  if (initialRebase.code === 0) {
    const installCode = await installWithRemediation(opts.wtPath, remediateInstallError);
    if (installCode !== undefined) {
      throw formatTransportError(opts, `Install remediation agent exited with code ${installCode}`);
    }
    return;
  }

  let conflictContext = await getConflictContextOrThrow(
    opts,
    `origin/${opts.baseBranch}`,
    initialRebase
  );

  for (let attempt = 1; attempt <= MAX_REBASE_ATTEMPTS; attempt++) {
    const agentCode = await resolveConflicts(conflictContext);
    if (agentCode !== 0) {
      const abortFailure = await abortRebase(opts.wtPath);
      throw formatTransportError(
        opts,
        appendAbortFailure(`Conflict resolution exited with code ${agentCode}`, abortFailure)
      );
    }

    const continueResult = await execAsync('git', ['rebase', '--continue'], {
      cwd: opts.wtPath,
      env: { GIT_EDITOR: 'true' },
    });
    if (continueResult.code === 0) {
      const installCode = await installWithRemediation(opts.wtPath, remediateInstallError);
      if (installCode !== undefined) {
        throw formatTransportError(
          opts,
          `Install remediation agent exited with code ${installCode}`
        );
      }
      return;
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
      if (await isRebaseComplete(opts.wtPath)) {
        const installCode = await installWithRemediation(opts.wtPath, remediateInstallError);
        if (installCode !== undefined) {
          throw formatTransportError(
            opts,
            `Install remediation agent exited with code ${installCode}`
          );
        }
        return;
      }

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

export async function pushWorktree(opts: WorktreeGitOpts): Promise<void> {
  let pushMode = opts.pushMode;
  let forcePushBranch: string | undefined;
  if (pushMode === 'force-with-lease') {
    forcePushBranch = await getCurrentBranch(opts);
  }
  let retries = 0;

  for (;;) {
    const pushArgs = getPushArgs(pushMode, forcePushBranch);
    const pushResult = await pushWorktreeBranch(opts, pushMode, forcePushBranch);
    if (pushResult.code === 0) {
      return;
    }

    if (retries >= MAX_PUSH_ATTEMPTS) {
      throw formatTransportError(opts, formatCommandFailure('git', pushArgs, pushResult));
    }

    await fetchOriginOrThrow(opts);

    const currentBranch = await getCurrentBranch(opts);
    const targetRef = `origin/${currentBranch}`;
    if (!(await remoteRefExists(opts, targetRef))) {
      retries += 1;
      continue;
    }

    const rebaseResult = await execAsync('git', ['rebase', '--autostash', targetRef], {
      cwd: opts.wtPath,
    });
    if (rebaseResult.code !== 0) {
      const abortFailure = await abortRebase(opts.wtPath);
      throw formatTransportError(
        opts,
        appendAbortFailure(
          `git rebase --autostash ${targetRef} failed.\n${formatCommandFailure(
            'git',
            ['rebase', '--autostash', targetRef],
            rebaseResult
          )}`,
          abortFailure
        )
      );
    }

    if (pushMode === 'new-branch') {
      pushMode = 'force-with-lease';
      forcePushBranch = currentBranch;
    }

    retries += 1;
  }
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
    'Resolve all conflicts, then stage the resolved files with `git add`. Do not run `git commit`, `git rebase --continue`, `git rebase --abort`, or `git push` yourself.'
  );

  return lines.join('\n');
}

export async function withGitTransport(
  opts: WorktreeGitOpts,
  runAgent: (
    conflictContext?: ConflictContext,
    pushError?: string,
    installError?: string
  ) => Promise<number>
): Promise<number> {
  await spawnAsync('git', ['fetch', 'origin'], { cwd: opts.wtPath });
  await syncWithRemoteBranch(opts);

  const initialRebase = await execAsync(
    'git',
    ['rebase', '--autostash', `origin/${opts.baseBranch}`],
    { cwd: opts.wtPath }
  );

  if (initialRebase.code !== 0) {
    let conflictContext = await getConflictContextOrThrow(
      opts,
      `origin/${opts.baseBranch}`,
      initialRebase
    );

    for (let attempt = 1; attempt <= MAX_REBASE_ATTEMPTS; attempt++) {
      const agentCode = await runAgent(conflictContext);
      if (agentCode !== 0) {
        console.error(`Agent exited with code ${agentCode} — skipping push.`);
        return agentCode;
      }

      await stageResolvedFiles(opts.wtPath);
      const continueResult = await execAsync('git', ['rebase', '--continue'], {
        cwd: opts.wtPath,
        env: { GIT_EDITOR: 'true' },
      });
      if (continueResult.code === 0) {
        const installCode = await installWithRemediation(opts.wtPath, (installError) =>
          runAgent(undefined, undefined, installError)
        );
        if (installCode !== undefined) {
          console.error(`Agent exited with code ${installCode} — skipping push.`);
          return installCode;
        }
        return await pushWithRetry(opts, runAgent);
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
        // The agent may have run `git commit` itself, which completes the rebase
        // step and (if it was the last step) finishes the rebase entirely. Detect
        // this by checking whether the rebase state directories still exist.
        if (await isRebaseComplete(opts.wtPath)) {
          const installCode = await installWithRemediation(opts.wtPath, (installError) =>
            runAgent(undefined, undefined, installError)
          );
          if (installCode !== undefined) {
            console.error(`Agent exited with code ${installCode} — skipping push.`);
            return installCode;
          }
          return await pushWithRetry(opts, runAgent);
        }

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
  }

  const installCode = await installWithRemediation(opts.wtPath, (installError) =>
    runAgent(undefined, undefined, installError)
  );
  if (installCode !== undefined) {
    console.error(`Agent exited with code ${installCode} — skipping push.`);
    return installCode;
  }

  const agentCode = await runAgent();
  if (agentCode !== 0) {
    console.error(`Agent exited with code ${agentCode} — proceeding to push.`);
  }

  return await pushWithRetry(opts, runAgent);
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

  // Prune stale worktree registrations whose directories no longer exist
  await execAsync('git', ['worktree', 'prune'], { cwd: opts.repoRoot });

  try {
    await access(wtPath);
    // Clean up stale worktree from a previous crashed run
    try {
      await spawnAsync('git', ['worktree', 'remove', '--force', wtPath], { cwd: opts.repoRoot });
    } catch {
      // If git worktree remove fails (orphaned directory), delete it directly
      await rm(wtPath, { recursive: true, force: true });
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
    // Not a registered worktree — remove the orphaned directory
    await rm(wtPath, { recursive: true, force: true });
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
    NPM_CONFIG_CACHE: path.join(wtPath, '.shipper', 'tmp', '.npm-cache'),
    XDG_CACHE_HOME: path.join(wtPath, '.shipper', 'tmp', '.cache'),
    ...(settings.worktreeEnv ?? {}),
  };
  const originalEnv = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(worktreeEnv)) {
    originalEnv.set(key, process.env[key]);
    process.env[key] = value;
  }

  let cleanupPromise: Promise<void> | undefined;
  const cleanup = async () => {
    cleanupPromise ??= (async () => {
      try {
        await runWorktreeHook('worktree-teardown', hookEnv, wtPath);
        await removeWorktree(opts.repoRoot, wtPath);
      } finally {
        for (const [key, value] of originalEnv) {
          if (value === undefined) {
            Reflect.deleteProperty(process.env, key);
            continue;
          }
          process.env[key] = value;
        }
      }
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

    await runWorktreeHook('worktree-setup', hookEnv, wtPath);
    return await fn(wtPath);
  } finally {
    process.removeListener('SIGINT', cleanupWithoutAwait);
    process.removeListener('SIGTERM', cleanupWithoutAwait);
    await cleanup();
  }
}
