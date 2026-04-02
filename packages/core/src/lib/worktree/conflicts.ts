import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  execAsync,
  formatCommandFailure,
  formatTransportError,
  type CommandResult,
  type ConflictContext,
  type ErrnoError,
  type WorktreeGitOpts,
  spawnAsync,
} from './helpers.js';

const CONFLICT_BLOCK_PATTERN = /^<{7}.*$\n[\s\S]*?^={7}$\n[\s\S]*?^>{7}.*(?:\n|$)?/gm;

export async function listConflictedFiles(wtPath: string): Promise<string[]> {
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

export async function extractConflictMarkers(
  wtPath: string,
  relativePath: string
): Promise<string[]> {
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

export async function buildConflictContext(
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

export async function stageResolvedFiles(wtPath: string): Promise<void> {
  await execAsync('git', ['add', '-u'], { cwd: wtPath });
}

export function getRetryFailureText(result: CommandResult): string {
  const output = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n');
  return output || `git rebase --continue exited with code ${result.code}`;
}

export async function isRebaseComplete(wtPath: string): Promise<boolean> {
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

export async function abortRebase(wtPath: string): Promise<string | undefined> {
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

export function appendAbortFailure(detail: string, abortFailure?: string): string {
  if (!abortFailure) {
    return detail;
  }

  return `${detail}\nA best-effort git rebase --abort also failed: ${abortFailure}`;
}

export async function getConflictContextOrThrow(
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
