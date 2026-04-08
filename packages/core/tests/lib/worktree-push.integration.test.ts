import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pushWorktree } from '../../src/lib/worktree.js';

const { GIT_DIR: _gitDir, GIT_WORK_TREE: _gitWorkTree, ...cleanEnv } = process.env;

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: cleanEnv,
    stdio: 'pipe',
    encoding: 'utf8',
  });
}

describe('pushWorktree integration', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    Reflect.deleteProperty(process.env, 'HOOK_MARKER_FILE');
    Reflect.deleteProperty(process.env, 'HOOK_TEMP_REPO');
  });

  it('sanitizes pre-push hook git env while preserving a relative core.hooksPath hook', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'shipper-worktree-push-'));
    tempDirs.push(tempDir);

    const remoteDir = path.join(tempDir, 'remote.git');
    const repoDir = path.join(tempDir, 'repo');
    const worktreeDir = path.join(tempDir, 'worktree');
    const markerFile = path.join(tempDir, 'hook-marker.txt');
    const tempHookRepo = path.join(tempDir, 'hook-temp-repo');

    runGit(tempDir, ['init', '--bare', remoteDir]);
    mkdirSync(repoDir, { recursive: true });
    runGit(tempDir, ['init', repoDir]);
    runGit(repoDir, ['checkout', '-b', 'main']);
    runGit(repoDir, ['config', 'user.name', 'Test User']);
    runGit(repoDir, ['config', 'user.email', 'test@example.com']);

    mkdirSync(path.join(repoDir, '.husky'), { recursive: true });
    writeFileSync(
      path.join(repoDir, '.husky', 'pre-push'),
      [
        '#!/bin/sh',
        'set -eu',
        'git init "$HOOK_TEMP_REPO" >/dev/null 2>&1',
        'test -d "$HOOK_TEMP_REPO/.git"',
        'printf "hook-ran\\n" > "$HOOK_MARKER_FILE"',
        '',
      ].join('\n')
    );
    chmodSync(path.join(repoDir, '.husky', 'pre-push'), 0o755);
    writeFileSync(path.join(repoDir, 'README.md'), '# fixture\n');
    runGit(repoDir, ['add', 'README.md', '.husky/pre-push']);
    runGit(repoDir, ['commit', '-m', 'init']);
    runGit(repoDir, ['remote', 'add', 'origin', remoteDir]);
    runGit(repoDir, ['push', '-u', 'origin', 'main']);
    runGit(repoDir, ['config', 'core.hooksPath', '.husky']);
    runGit(repoDir, ['worktree', 'add', '-b', 'feature', worktreeDir]);

    writeFileSync(path.join(worktreeDir, 'feature.txt'), 'feature change\n');
    runGit(worktreeDir, ['add', 'feature.txt']);
    runGit(worktreeDir, ['commit', '-m', 'feature']);

    const previousGitDir = process.env.GIT_DIR;
    const previousGitWorkTree = process.env.GIT_WORK_TREE;
    process.env.HOOK_MARKER_FILE = markerFile;
    process.env.HOOK_TEMP_REPO = tempHookRepo;
    Reflect.deleteProperty(process.env, 'GIT_DIR');
    Reflect.deleteProperty(process.env, 'GIT_WORK_TREE');

    try {
      await expect(
        pushWorktree({
          wtPath: worktreeDir,
          repoRoot: repoDir,
          baseBranch: 'main',
          pushMode: 'new-branch',
        })
      ).resolves.toBeUndefined();
    } finally {
      if (previousGitDir === undefined) {
        Reflect.deleteProperty(process.env, 'GIT_DIR');
      } else {
        process.env.GIT_DIR = previousGitDir;
      }
      if (previousGitWorkTree === undefined) {
        Reflect.deleteProperty(process.env, 'GIT_WORK_TREE');
      } else {
        process.env.GIT_WORK_TREE = previousGitWorkTree;
      }
    }

    expect(existsSync(path.join(tempHookRepo, '.git'))).toBe(true);
    expect(readFileSync(markerFile, 'utf8')).toBe('hook-ran\n');
    expect(runGit(worktreeDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('feature');
    expect(runGit(worktreeDir, ['rev-list', '--count', 'HEAD']).trim()).toBe('2');
  });
});
