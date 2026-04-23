import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function getMissingPathError(subject: string, resolvedRepoDir: string): Error {
  return new Error(`${subject} path does not exist: ${resolvedRepoDir}`);
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
    if (
      error instanceof Error &&
      error.message === getMissingPathError(subject, resolvedRepoDir).message
    ) {
      throw error;
    }

    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'ENOTDIR')
    ) {
      throw getMissingPathError(subject, resolvedRepoDir);
    }

    throw error;
  }

  try {
    await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd: resolvedRepoDir,
    });
  } catch {
    throw new Error(`${subject} is not a git repository: ${resolvedRepoDir}`);
  }

  process.chdir(resolvedRepoDir);
  process.stderr.write(`shipper mcp: repo dir = ${resolvedRepoDir}\n`);
  return resolvedRepoDir;
}
