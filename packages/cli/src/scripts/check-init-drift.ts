import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { toErrorMessage } from '@baremetallabs-ai/shipper-core';

import { initCommand } from '../commands/init.js';

const execFileAsync = promisify(execFile);
const DIFF_MAX_BUFFER_BYTES = 1024 * 1024;
const DIFF_OMITTED_MESSAGE =
  'Diff omitted because it exceeded 1048576 bytes. Git status above identifies the affected files.';

const silentLogger = {
  log(_message: string) {
    void _message;
    // Keep the guard silent on a clean pass.
  },
  error(_message: string) {
    void _message;
    // Keep expected offline init warnings out of the guard output.
  },
};

export type InitDriftResult =
  | {
      ok: true;
      status: '';
      diff: '';
    }
  | {
      ok: false;
      status: string;
      diff: string;
    };

export interface CheckInitDriftOptions {
  repoRoot?: string;
}

function parseGitPathList(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((file) => file.trim())
    .filter(Boolean);
}

function isMaxBufferError(error: unknown): boolean {
  return (
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') ||
    toErrorMessage(error).includes('maxBuffer')
  );
}

async function execGit(args: string[], cwd: string, maxBuffer?: number): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf-8',
    ...(maxBuffer === undefined ? {} : { maxBuffer }),
  });
  return stdout;
}

async function markUntrackedShipperFilesIntentToAdd(worktreePath: string): Promise<void> {
  const output = await execGit(
    ['ls-files', '--others', '--exclude-standard', '--', '.shipper/'],
    worktreePath
  );
  const files = parseGitPathList(output);
  if (files.length === 0) {
    return;
  }

  await execGit(['add', '--intent-to-add', '--', ...files], worktreePath);
}

async function readBoundedShipperDiff(worktreePath: string): Promise<string> {
  try {
    return await execGit(
      ['diff', '--no-ext-diff', 'HEAD', '--', '.shipper/'],
      worktreePath,
      DIFF_MAX_BUFFER_BYTES
    );
  } catch (error) {
    if (isMaxBufferError(error)) {
      return DIFF_OMITTED_MESSAGE;
    }
    throw error;
  }
}

async function resolveRepoRoot(repoRoot?: string): Promise<string> {
  if (repoRoot) {
    return path.resolve(repoRoot);
  }

  return (await execGit(['rev-parse', '--show-toplevel'], process.cwd())).trim();
}

export async function checkInitDrift(
  options: CheckInitDriftOptions = {}
): Promise<InitDriftResult> {
  const repoRoot = await resolveRepoRoot(options.repoRoot);
  const tempDir = await mkdtemp(path.join(tmpdir(), 'shipper-init-drift-'));
  const worktreePath = path.join(tempDir, 'worktree');
  let removeWorktree = false;

  try {
    await execGit(['worktree', 'add', '--detach', worktreePath, 'HEAD'], repoRoot);
    removeWorktree = true;

    const previousCwd = process.cwd();
    try {
      process.chdir(worktreePath);
      await initCommand({ offline: true, logger: silentLogger });
    } finally {
      process.chdir(previousCwd);
    }

    await markUntrackedShipperFilesIntentToAdd(worktreePath);
    const status = await execGit(['status', '--porcelain', '--', '.shipper/'], worktreePath);
    const diff = await readBoundedShipperDiff(worktreePath);

    if (status === '' && diff === '') {
      return { ok: true, status: '', diff: '' };
    }

    return { ok: false, status, diff };
  } finally {
    if (removeWorktree) {
      try {
        await execGit(['worktree', 'remove', '--force', worktreePath], repoRoot);
      } catch {
        // The temp directory cleanup below is the fallback.
      }
    }

    await rm(tempDir, { recursive: true, force: true });
  }
}

export function formatInitDriftFailure(result: InitDriftResult): string {
  const sections = ['Shipper init drift detected.'];

  if (result.status) {
    sections.push(`Git status:\n${result.status.trimEnd()}`);
  }

  if (result.diff) {
    sections.push(`Diff:\n${result.diff.trimEnd()}`);
  }

  sections.push('Run `shipper init` and commit the resulting changes.');

  return `${sections.join('\n\n')}\n`;
}

async function main(): Promise<void> {
  try {
    const result = await checkInitDrift();
    if (!result.ok) {
      process.stderr.write(formatInitDriftFailure(result));
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${toErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
