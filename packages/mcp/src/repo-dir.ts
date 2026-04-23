import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const REPO_DIR_PATH_ERROR_CODES = ['EACCES', 'ENOENT', 'ENOTDIR', 'EPERM'] as const;

function getMissingPathError(subject: string, resolvedRepoDir: string): Error {
  return new Error(`${subject} path does not exist: ${resolvedRepoDir}`);
}

function hasErrorCode(error: unknown, codes: readonly string[]): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    codes.includes(error.code)
  );
}

export async function resolveAndEnterRepoDir(): Promise<string> {
  const startupCwd = process.cwd();
  const rawRepoDir = process.env.SHIPPER_REPO_DIR;
  const trimmedRepoDir = rawRepoDir?.trim() ?? '';
  const hasEnvRepoDir = trimmedRepoDir.length > 0;
  const resolvedRepoDir = hasEnvRepoDir ? path.resolve(startupCwd, trimmedRepoDir) : startupCwd;
  const subject = hasEnvRepoDir ? 'SHIPPER_REPO_DIR' : 'repo dir';

  try {
    const stats = await stat(resolvedRepoDir);
    if (!stats.isDirectory()) {
      throw getMissingPathError(subject, resolvedRepoDir);
    }
  } catch (error) {
    if (hasErrorCode(error, REPO_DIR_PATH_ERROR_CODES)) {
      throw getMissingPathError(subject, resolvedRepoDir);
    }

    throw error;
  }

  try {
    await access(resolvedRepoDir, fsConstants.R_OK | fsConstants.X_OK);
  } catch (error) {
    if (hasErrorCode(error, REPO_DIR_PATH_ERROR_CODES)) {
      throw getMissingPathError(subject, resolvedRepoDir);
    }

    throw error;
  }

  try {
    await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd: resolvedRepoDir,
    });
  } catch (error) {
    if (hasErrorCode(error, ['EACCES', 'ENOTDIR', 'EPERM'])) {
      throw getMissingPathError(subject, resolvedRepoDir);
    }

    throw new Error(`${subject} is not a git repository: ${resolvedRepoDir}`);
  }

  try {
    process.chdir(resolvedRepoDir);
  } catch (error) {
    if (hasErrorCode(error, REPO_DIR_PATH_ERROR_CODES)) {
      throw getMissingPathError(subject, resolvedRepoDir);
    }

    throw error;
  }

  process.stderr.write(`shipper mcp: repo dir = ${resolvedRepoDir}\n`);
  return resolvedRepoDir;
}
