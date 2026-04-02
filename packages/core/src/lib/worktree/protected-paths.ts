import path from 'node:path';
import { logger } from '../logger.js';
import {
  PUSH_OUTPUT_MAX_BUFFER,
  execAsync,
  formatCommandFailure,
  formatTransportError,
  type WorktreeGitOpts,
} from './helpers.js';

const PROTECTED_SHIPPER_DIRS = ['.shipper/output/', '.shipper/input/', '.shipper/tmp/'];

export async function listProtectedTrackedFiles(opts: WorktreeGitOpts): Promise<string[]> {
  const lsFilesArgs = ['ls-files', '--', ...PROTECTED_SHIPPER_DIRS];
  const lsFilesResult = await execAsync('git', lsFilesArgs, {
    cwd: opts.wtPath,
    maxBuffer: PUSH_OUTPUT_MAX_BUFFER,
  });
  if (lsFilesResult.code !== 0) {
    throw formatTransportError(opts, formatCommandFailure('git', lsFilesArgs, lsFilesResult));
  }

  return lsFilesResult.stdout
    .trim()
    .split('\n')
    .filter((file) => file && path.basename(file) !== '.gitkeep');
}

export async function stripProtectedPaths(opts: WorktreeGitOpts): Promise<void> {
  const trackedFiles = await listProtectedTrackedFiles(opts);

  if (trackedFiles.length === 0) {
    return;
  }

  const resetArgs = ['reset', 'HEAD', '--', '.'];
  const resetResult = await execAsync('git', resetArgs, {
    cwd: opts.wtPath,
  });
  if (resetResult.code !== 0) {
    throw formatTransportError(opts, formatCommandFailure('git', resetArgs, resetResult));
  }

  const committedTrackedFiles = await listProtectedTrackedFiles(opts);
  if (committedTrackedFiles.length === 0) {
    return;
  }

  const rmArgs = ['rm', '--cached', '--', ...committedTrackedFiles];
  const rmResult = await execAsync('git', rmArgs, {
    cwd: opts.wtPath,
  });
  if (rmResult.code !== 0) {
    throw formatTransportError(opts, formatCommandFailure('git', rmArgs, rmResult));
  }

  const amendArgs = [
    'commit',
    '--amend',
    '--allow-empty',
    '--no-edit',
    '--no-verify',
    '--no-gpg-sign',
  ];
  const amendResult = await execAsync('git', amendArgs, {
    cwd: opts.wtPath,
    env: { GIT_EDITOR: 'true' },
  });
  if (amendResult.code !== 0) {
    throw formatTransportError(opts, formatCommandFailure('git', amendArgs, amendResult));
  }

  logger.error(
    `Stripped ${committedTrackedFiles.length} tracked .shipper/ artifact files from git index before push`
  );
}
