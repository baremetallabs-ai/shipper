import { execFile, spawn } from 'node:child_process';

export const MAX_REBASE_ATTEMPTS = 3;
export const MAX_PUSH_ATTEMPTS = 3;
export const INSTALL_OUTPUT_MAX_BUFFER = Number.POSITIVE_INFINITY;
export const PUSH_OUTPUT_MAX_BUFFER = 10 * 1024 * 1024;

export interface CommandOpts {
  cwd?: string;
  env?: typeof process.env;
  maxBuffer?: number;
  shell?: boolean;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface ExecFileError extends Error {
  code?: number | string;
  stdout?: string;
  stderr?: string;
}

export interface ErrnoError extends Error {
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

export function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  if (typeof error === 'string') {
    return new Error(error);
  }

  if (typeof error === 'undefined') {
    return new Error('Unknown child process error');
  }

  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error(Object.prototype.toString.call(error));
  }
}

export function spawnAsync(command: string, args: string[], opts: CommandOpts = {}): Promise<void> {
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

export async function execAsync(
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

export function formatCommandFailure(
  command: string,
  args: string[],
  result: CommandResult
): string {
  const commandText = args.length > 0 ? `${command} ${args.join(' ')}` : command;
  const output = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n');
  if (!output) {
    return `${commandText} exited with code ${result.code}`;
  }
  return `${commandText} exited with code ${result.code}:\n${output}`;
}

export function formatTransportError(opts: WorktreeGitOpts, detail: string): Error {
  return new Error(`Git transport failed in ${opts.wtPath} for repo ${opts.repoRoot}: ${detail}`);
}

export async function getCurrentBranch(opts: WorktreeGitOpts): Promise<string> {
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

export async function remoteRefExists(opts: WorktreeGitOpts, targetRef: string): Promise<boolean> {
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

export async function syncWithRemoteBranch(opts: WorktreeGitOpts): Promise<void> {
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

export async function fetchOriginOrThrow(opts: WorktreeGitOpts): Promise<void> {
  try {
    await spawnAsync('git', ['fetch', 'origin'], { cwd: opts.wtPath });
  } catch (error) {
    throw formatTransportError(
      opts,
      `git fetch origin failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
