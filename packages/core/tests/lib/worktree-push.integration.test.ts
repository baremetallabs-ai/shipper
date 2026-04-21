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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pushWorktree } from '../../src/lib/worktree.js';
import { createGitFixture, sh } from '../_harness/git-fixture.js';

const activeFixtures: Array<ReturnType<typeof createGitFixture>> = [];

function makeFixture(name: string, branchName?: string): ReturnType<typeof createGitFixture> {
  const fixture = createGitFixture(name, branchName);
  activeFixtures.push(fixture);
  return fixture;
}

function remoteRefSha(fixture: ReturnType<typeof createGitFixture>, refName: string): string {
  return fixture.runGit(fixture.remoteDir, ['rev-parse', refName]).trim();
}

function readRemoteFile(
  fixture: ReturnType<typeof createGitFixture>,
  branchName: string,
  relativePath: string
): string {
  return fixture
    .runGit(fixture.remoteDir, ['show', `refs/heads/${branchName}:${relativePath}`])
    .trimEnd();
}

function pushRemoteBranchCommit(
  fixture: ReturnType<typeof createGitFixture>,
  cloneName: string,
  branchName: string,
  relativePath: string,
  content: string,
  message: string,
  existing = false
): void {
  const clone = fixture.createRemoteClone(cloneName);
  try {
    fixture.runGit(
      clone.cloneDir,
      existing ? ['checkout', branchName] : ['checkout', '-b', branchName]
    );
    fixture.commitFile(clone.cloneDir, relativePath, content, message);
    fixture.runGit(
      clone.cloneDir,
      existing ? ['push', 'origin', branchName] : ['push', '-u', 'origin', branchName]
    );
  } finally {
    clone.cleanup();
  }
}

afterEach(() => {
  for (const fixture of activeFixtures.splice(0)) {
    fixture.cleanup();
  }
  for (const tempDir of manualTempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
  for (const key of [
    'HOOK_MARKER_FILE',
    'HOOK_TEMP_REPO',
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0',
    'GIT_CONFIG_VALUE_0',
    'GIT_CONFIG_PARAMETERS',
  ]) {
    Reflect.deleteProperty(process.env, key);
  }
});

const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith('GIT_') && key !== 'SHIPPER_ORIGINAL_PRE_PUSH'
  )
);
const manualTempDirs: string[] = [];

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: cleanEnv,
    stdio: 'pipe',
    encoding: 'utf8',
  });
}

describe('pushWorktree integration', () => {
  it('sanitizes pre-push hook git env while preserving a relative core.hooksPath hook', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'shipper-worktree-push-'));
    manualTempDirs.push(tempDir);

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
    process.env.HOOK_MARKER_FILE = markerFile;
    process.env.HOOK_TEMP_REPO = tempHookRepo;
    const previousGitDir = process.env.GIT_DIR;
    const previousGitWorkTree = process.env.GIT_WORK_TREE;
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

    expect(readFileSync(markerFile, 'utf8')).toBe('hook-ran\n');
    expect(existsSync(path.join(tempHookRepo, '.git'))).toBe(true);
    expect(runGit(worktreeDir, ['rev-list', '--count', 'HEAD']).trim()).toBe('2');
  }, 20_000);

  it('does not loop when leaked GIT_CONFIG_* points core.hooksPath at a prior wrapper', async () => {
    // Regression: when shipper's outer push runs `git -c core.hooksPath=<wrapper>`,
    // git propagates that override to subprocess git invocations via
    // GIT_CONFIG_COUNT/KEY/VALUE env vars. A nested pushWorktree must not let
    // those leak into its own `git rev-parse --git-path hooks` call — otherwise
    // it resolves the outer wrapper as the "real" hook, sets
    // SHIPPER_ORIGINAL_PRE_PUSH to that path, and the wrapper exec's itself
    // forever.
    const tempDir = mkdtempSync(path.join(tmpdir(), 'shipper-worktree-push-leak-'));
    manualTempDirs.push(tempDir);

    const remoteDir = path.join(tempDir, 'remote.git');
    const repoDir = path.join(tempDir, 'repo');
    const worktreeDir = path.join(tempDir, 'worktree');
    const markerFile = path.join(tempDir, 'hook-marker.txt');
    const tempHookRepo = path.join(tempDir, 'hook-temp-repo');
    const leakedHooksDir = path.join(tempDir, 'leaked-wrapper');

    mkdirSync(leakedHooksDir, { recursive: true });
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
    process.env.HOOK_MARKER_FILE = markerFile;
    process.env.HOOK_TEMP_REPO = tempHookRepo;
    const previousEnv = {
      GIT_DIR: process.env.GIT_DIR,
      GIT_WORK_TREE: process.env.GIT_WORK_TREE,
      GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
      GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
      GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0,
      GIT_CONFIG_PARAMETERS: process.env.GIT_CONFIG_PARAMETERS,
    };
    Reflect.deleteProperty(process.env, 'GIT_DIR');
    Reflect.deleteProperty(process.env, 'GIT_WORK_TREE');
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
    expect(readFileSync(markerFile, 'utf8')).toBe('hook-ran\n');
  }, 20_000);

  it('pushes a new branch successfully', async () => {
    const fixture = makeFixture('push-new-branch');
    const hookContent = ['#!/bin/sh', 'exit 0', ''].join('\n');
    fixture.writeRelativePrePushHook(hookContent);
    fixture.writeFile(fixture.worktreeDir, '.husky/pre-push', hookContent);
    chmodSync(path.join(fixture.worktreeDir, '.husky', 'pre-push'), 0o755);
    fixture.runGit(fixture.worktreeDir, ['config', 'core.hooksPath', '.husky']);
    fixture.commitFile(fixture.worktreeDir, 'feature.txt', 'feature change\n', 'feature');
    await expect(
      pushWorktree({
        wtPath: fixture.worktreeDir,
        repoRoot: fixture.repoDir,
        baseBranch: 'main',
        pushMode: 'new-branch',
      })
    ).resolves.toBeUndefined();

    expect(remoteRefSha(fixture, `refs/heads/${fixture.branchName}`)).toBe(
      fixture.currentHead(fixture.worktreeDir)
    );
  }, 20_000);

  it('fetches, rebases onto the remote branch, and force-pushes after a failed new-branch push', async () => {
    const fixture = makeFixture('push-recovery-rebase');
    fixture.commitFile(fixture.worktreeDir, 'feature.txt', 'local feature\n', 'local feature');
    pushRemoteBranchCommit(
      fixture,
      'remote-feature-clone',
      fixture.branchName,
      'remote.txt',
      'remote feature\n',
      'remote feature'
    );
    await expect(
      pushWorktree({
        wtPath: fixture.worktreeDir,
        repoRoot: fixture.repoDir,
        baseBranch: 'main',
        pushMode: 'new-branch',
      })
    ).resolves.toBeUndefined();

    expect(readRemoteFile(fixture, fixture.branchName, 'feature.txt')).toBe('local feature');
    expect(readRemoteFile(fixture, fixture.branchName, 'remote.txt')).toBe('remote feature');
    expect(remoteRefSha(fixture, `refs/heads/${fixture.branchName}`)).toBe(
      fixture.currentHead(fixture.worktreeDir)
    );
  }, 20_000);

  it('retries the original push args when the remote branch does not exist yet', async () => {
    const fixture = makeFixture('push-remote-absent-retry');
    fixture.commitFile(fixture.worktreeDir, 'feature.txt', 'feature change\n', 'feature');
    const rejectCounter = path.join(fixture.tempDir, 'reject-count');
    fixture.writeRemotePreReceiveHook(
      [
        '#!/bin/sh',
        'set -eu',
        `count=$(cat ${sh(rejectCounter)} 2>/dev/null || printf '0')`,
        'count=$((count + 1))',
        `printf '%s' "$count" > ${sh(rejectCounter)}`,
        'if [ "$count" -eq 1 ]; then',
        `  printf 'temporary push failure\\n' >&2`,
        '  exit 1',
        'fi',
        '',
      ].join('\n')
    );
    await expect(
      pushWorktree({
        wtPath: fixture.worktreeDir,
        repoRoot: fixture.repoDir,
        baseBranch: 'main',
        pushMode: 'new-branch',
      })
    ).resolves.toBeUndefined();

    expect(readFileSync(rejectCounter, 'utf8')).toBe('2');
    expect(remoteRefSha(fixture, `refs/heads/${fixture.branchName}`)).toBe(
      fixture.currentHead(fixture.worktreeDir)
    );
  }, 20_000);

  it('stops after repeated push failures and throws the final error', async () => {
    const fixture = makeFixture('push-retry-exhaustion');
    fixture.commitFile(fixture.worktreeDir, 'feature.txt', 'feature change\n', 'feature');
    const rejectCounter = path.join(fixture.tempDir, 'reject-count');
    fixture.writeRemotePreReceiveHook(
      [
        '#!/bin/sh',
        'set -eu',
        `count=$(cat ${sh(rejectCounter)} 2>/dev/null || printf '0')`,
        'count=$((count + 1))',
        `printf '%s' "$count" > ${sh(rejectCounter)}`,
        `printf 'attempt %s\\n' "$count" >&2`,
        'exit 1',
        '',
      ].join('\n')
    );
    await expect(
      pushWorktree({
        wtPath: fixture.worktreeDir,
        repoRoot: fixture.repoDir,
        baseBranch: 'main',
        pushMode: 'new-branch',
      })
    ).rejects.toThrow('git push -u origin HEAD exited with code 1');

    expect(readFileSync(rejectCounter, 'utf8')).toBe('4');
  }, 20_000);

  it('refuses to force-push when the branch has no commits ahead of the base branch', async () => {
    const fixture = makeFixture('push-force-no-ahead');
    fixture.runGit(fixture.worktreeDir, ['push', '-u', 'origin', 'HEAD']);
    await expect(
      pushWorktree({
        wtPath: fixture.worktreeDir,
        repoRoot: fixture.repoDir,
        baseBranch: 'main',
        pushMode: 'force-with-lease',
      })
    ).rejects.toThrow('Refusing to push: branch has 0 commits ahead of base branch');
  }, 20_000);

  it('logs and proceeds with force-push when the commit-count safety check fails', async () => {
    const fixture = makeFixture('push-force-count-check-fails');
    fixture.commitFile(fixture.worktreeDir, 'feature.txt', 'feature change\n', 'feature');
    fixture.runGit(fixture.worktreeDir, ['push', '-u', 'origin', 'HEAD']);
    fixture.commitFile(fixture.worktreeDir, 'feature-2.txt', 'second change\n', 'feature 2');
    fixture.runGit(fixture.worktreeDir, ['update-ref', '-d', 'refs/remotes/origin/main']);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(
        pushWorktree({
          wtPath: fixture.worktreeDir,
          repoRoot: fixture.repoDir,
          baseBranch: 'main',
          pushMode: 'force-with-lease',
        })
      ).resolves.toBeUndefined();
    } finally {
      consoleErrorSpy.mockRestore();
    }

    expect(remoteRefSha(fixture, `refs/heads/${fixture.branchName}`)).toBe(
      fixture.currentHead(fixture.worktreeDir)
    );
  }, 20_000);

  it('strips tracked protected files, preserves .gitkeep files, and pushes the amended commit', async () => {
    const fixture = makeFixture('push-strip-protected');
    fixture.commitFile(fixture.worktreeDir, 'feature.txt', 'feature change\n', 'feature');
    fixture.writeFile(fixture.worktreeDir, '.shipper/output/result.json', '{"ok":true}\n');
    fixture.writeFile(fixture.worktreeDir, '.shipper/input/request.json', '{"issue":653}\n');
    fixture.writeFile(fixture.worktreeDir, '.shipper/tmp/debug.log', 'debug\n');
    fixture.writeFile(fixture.worktreeDir, '.shipper/output/.gitkeep', '');
    fixture.writeFile(fixture.worktreeDir, '.shipper/input/.gitkeep', '');
    fixture.runGit(fixture.worktreeDir, ['add', '.shipper', 'feature.txt']);
    fixture.runGit(fixture.worktreeDir, ['commit', '-m', 'tracked artifacts']);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(
        pushWorktree({
          wtPath: fixture.worktreeDir,
          repoRoot: fixture.repoDir,
          baseBranch: 'main',
          pushMode: 'new-branch',
        })
      ).resolves.toBeUndefined();
    } finally {
      consoleErrorSpy.mockRestore();
    }

    expect(() =>
      readRemoteFile(fixture, fixture.branchName, '.shipper/output/result.json')
    ).toThrow();
    expect(() =>
      readRemoteFile(fixture, fixture.branchName, '.shipper/input/request.json')
    ).toThrow();
    expect(() => readRemoteFile(fixture, fixture.branchName, '.shipper/tmp/debug.log')).toThrow();
    expect(readRemoteFile(fixture, fixture.branchName, '.shipper/output/.gitkeep')).toBe('');
    expect(readRemoteFile(fixture, fixture.branchName, '.shipper/input/.gitkeep')).toBe('');
  }, 20_000);

  it('resets the index before push and skips amend when only staged protected files were present', async () => {
    const fixture = makeFixture('push-staged-protected');
    fixture.commitFile(fixture.worktreeDir, 'feature.txt', 'feature change\n', 'feature');
    const headBefore = fixture.currentHead(fixture.worktreeDir);
    fixture.writeFile(fixture.worktreeDir, '.shipper/output/result.json', '{"ok":true}\n');
    fixture.runGit(fixture.worktreeDir, ['add', '.shipper/output/result.json']);
    await expect(
      pushWorktree({
        wtPath: fixture.worktreeDir,
        repoRoot: fixture.repoDir,
        baseBranch: 'main',
        pushMode: 'new-branch',
      })
    ).resolves.toBeUndefined();

    expect(fixture.currentHead(fixture.worktreeDir)).toBe(headBefore);
    expect(remoteRefSha(fixture, `refs/heads/${fixture.branchName}`)).toBe(headBefore);
    expect(() =>
      readRemoteFile(fixture, fixture.branchName, '.shipper/output/result.json')
    ).toThrow();
  }, 20_000);
});
