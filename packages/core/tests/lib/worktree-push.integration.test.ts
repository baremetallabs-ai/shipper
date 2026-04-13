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

const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith('GIT_') && key !== 'SHIPPER_ORIGINAL_PRE_PUSH'
  )
);

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
  }, 15_000);

  it('does not loop when leaked GIT_CONFIG_* points core.hooksPath at a prior wrapper', async () => {
    // Regression: when shipper's outer push runs `git -c core.hooksPath=<wrapper>`,
    // git propagates that override to subprocess git invocations via
    // GIT_CONFIG_COUNT/KEY/VALUE env vars. A nested pushWorktree must not let
    // those leak into its own `git rev-parse --git-path hooks` call — otherwise
    // it resolves the outer wrapper as the "real" hook, sets
    // SHIPPER_ORIGINAL_PRE_PUSH to that path, and the wrapper exec's itself
    // forever.
    const tempDir = mkdtempSync(path.join(tmpdir(), 'shipper-worktree-push-leak-'));
    tempDirs.push(tempDir);

    const remoteDir = path.join(tempDir, 'remote.git');
    const repoDir = path.join(tempDir, 'repo');
    const worktreeDir = path.join(tempDir, 'worktree');
    const markerFile = path.join(tempDir, 'hook-marker.txt');
    const tempHookRepo = path.join(tempDir, 'hook-temp-repo');
    const leakedHooksDir = path.join(tempDir, 'leaked-wrapper');

    mkdirSync(leakedHooksDir, { recursive: true });
    // A pre-push that would re-exec itself if mistakenly resolved as the "real" hook.
    writeFileSync(
      path.join(leakedHooksDir, 'pre-push'),
      ['#!/bin/sh', 'exec "$0" "$@"', ''].join('\n')
    );
    chmodSync(path.join(leakedHooksDir, 'pre-push'), 0o755);

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

    const previousEnv = {
      GIT_DIR: process.env.GIT_DIR,
      GIT_WORK_TREE: process.env.GIT_WORK_TREE,
      GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
      GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
      GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0,
      GIT_CONFIG_PARAMETERS: process.env.GIT_CONFIG_PARAMETERS,
    };
    process.env.HOOK_MARKER_FILE = markerFile;
    process.env.HOOK_TEMP_REPO = tempHookRepo;
    Reflect.deleteProperty(process.env, 'GIT_DIR');
    Reflect.deleteProperty(process.env, 'GIT_WORK_TREE');
    // Simulate an outer `git -c core.hooksPath=<leakedHooksDir> push` propagating
    // its override to this subprocess.
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'core.hooksPath';
    process.env.GIT_CONFIG_VALUE_0 = leakedHooksDir;
    process.env.GIT_CONFIG_PARAMETERS = `'core.hooksPath=${leakedHooksDir}'`;

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
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) {
          Reflect.deleteProperty(process.env, key);
        } else {
          process.env[key] = value;
        }
      }
    }

    // The repo's actual hook ran (proves we resolved the right hooksPath),
    // not the leaked self-recursing one.
    expect(existsSync(path.join(tempHookRepo, '.git'))).toBe(true);
    expect(readFileSync(markerFile, 'utf8')).toBe('hook-ran\n');
    expect(runGit(worktreeDir, ['rev-list', '--count', 'HEAD']).trim()).toBe('2');
  }, 15_000);
});
