import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConflictContext } from '../../src/lib/worktree.js';
import { cleanupGitFixtures, createGitFixture, hasPath, sh } from '../_harness/git-fixture.js';

function writeExecutable(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  chmodSync(filePath, 0o755);
}

function createInstallCommand(tempDir: string, name: string, bodyLines: string[]): string {
  const scriptPath = path.join(tempDir, name);
  writeExecutable(scriptPath, ['#!/bin/sh', 'set -eu', ...bodyLines, ''].join('\n'));
  return `sh ${sh(scriptPath)}`;
}

function advanceMain(
  fixture: ReturnType<typeof createGitFixture>,
  relativePath: string,
  content: string,
  message: string
): void {
  fixture.commitFile(fixture.repoDir, relativePath, content, message);
  fixture.runGit(fixture.repoDir, ['push', 'origin', 'main']);
}

function createTextConflict(
  fixture: ReturnType<typeof createGitFixture>,
  relativePath = 'src/conflict.txt'
): string {
  fixture.commitFile(fixture.worktreeDir, relativePath, 'feature change\n', 'feature conflict');
  advanceMain(fixture, relativePath, 'main change\n', 'main conflict');
  return relativePath;
}

function remoteRefSha(fixture: ReturnType<typeof createGitFixture>, refName: string): string {
  return fixture.runGit(fixture.remoteDir, ['rev-parse', refName]).trim();
}

afterEach(() => {
  cleanupGitFixtures();
  for (const key of ['HOOK_MARKER_FILE', 'HOOK_TEMP_REPO']) {
    Reflect.deleteProperty(process.env, key);
  }
});

describe('syncWorktree integration', () => {
  it('reruns installCommand after a clean rebase before returning', async () => {
    const fixture = createGitFixture('transport-sync-clean-rebase');
    fixture.commitFile(fixture.worktreeDir, 'feature.txt', 'feature work\n', 'feature work');
    advanceMain(fixture, 'main.txt', 'main work\n', 'main work');

    const installLog = path.join(fixture.tempDir, 'install.log');
    const installCommand = createInstallCommand(fixture.tempDir, 'install-once.sh', [
      `printf 'install\\n' >> ${sh(installLog)}`,
    ]);
    const { syncWorktree } = await fixture.importWorktreeModule({ installCommand });
    const resolveConflicts = vi.fn();

    await expect(
      syncWorktree(
        {
          wtPath: fixture.worktreeDir,
          repoRoot: fixture.repoDir,
          baseBranch: 'main',
          pushMode: 'force-with-lease',
        },
        resolveConflicts
      )
    ).resolves.toBeUndefined();

    expect(resolveConflicts).not.toHaveBeenCalled();
    expect(fixture.readFile(fixture.worktreeDir, 'feature.txt')).toBe('feature work\n');
    expect(fixture.readFile(fixture.worktreeDir, 'main.txt')).toBe('main work\n');
    expect(readFileSync(installLog, 'utf8')).toBe('install\n');
  }, 20_000);

  it('stages resolved files before rebase --continue and reruns installCommand after conflict resolution', async () => {
    const fixture = createGitFixture('transport-sync-conflict');
    const conflictPath = createTextConflict(fixture);
    const installLog = path.join(fixture.tempDir, 'install.log');
    const installCommand = createInstallCommand(fixture.tempDir, 'install-after-conflict.sh', [
      `printf 'install\\n' >> ${sh(installLog)}`,
    ]);
    const { syncWorktree } = await fixture.importWorktreeModule({ installCommand });
    const resolveConflicts = vi.fn((conflictContext: ConflictContext) => {
      expect(conflictContext.files).toEqual([conflictPath]);
      expect(conflictContext.conflicts[0]?.markers[0]).toContain('<<<<<<< HEAD');
      fixture.writeFile(
        fixture.worktreeDir,
        conflictPath,
        ['resolved line', 'main change', 'feature change', ''].join('\n')
      );
      return Promise.resolve(0);
    });

    await expect(
      syncWorktree(
        {
          wtPath: fixture.worktreeDir,
          repoRoot: fixture.repoDir,
          baseBranch: 'main',
          pushMode: 'force-with-lease',
        },
        resolveConflicts
      )
    ).resolves.toBeUndefined();

    expect(resolveConflicts).toHaveBeenCalledTimes(1);
    expect(fixture.readFile(fixture.worktreeDir, conflictPath)).toContain('resolved line');
    expect(
      fixture.runGit(fixture.worktreeDir, ['diff', '--name-only', '--diff-filter=U']).trim()
    ).toBe('');
    expect(readFileSync(installLog, 'utf8')).toBe('install\n');
  }, 20_000);

  it('reruns installCommand when the conflict callback already completed the rebase', async () => {
    const fixture = createGitFixture('transport-sync-complete-rebase');
    const conflictPath = createTextConflict(fixture);
    const installLog = path.join(fixture.tempDir, 'install.log');
    const installCommand = createInstallCommand(
      fixture.tempDir,
      'install-after-agent-continue.sh',
      [`printf 'install\\n' >> ${sh(installLog)}`]
    );
    const { syncWorktree } = await fixture.importWorktreeModule({ installCommand });

    await expect(
      syncWorktree(
        {
          wtPath: fixture.worktreeDir,
          repoRoot: fixture.repoDir,
          baseBranch: 'main',
          pushMode: 'force-with-lease',
        },
        () => {
          fixture.writeFile(
            fixture.worktreeDir,
            conflictPath,
            ['resolved by callback', 'main change', 'feature change', ''].join('\n')
          );
          fixture.runGit(fixture.worktreeDir, ['add', conflictPath]);
          fixture.runGit(fixture.worktreeDir, ['rebase', '--continue'], {
            env: { GIT_EDITOR: 'true' },
          });
          return Promise.resolve(0);
        }
      )
    ).resolves.toBeUndefined();

    expect(fixture.readFile(fixture.worktreeDir, conflictPath)).toContain('resolved by callback');
    expect(readFileSync(installLog, 'utf8')).toBe('install\n');
  }, 20_000);

  it('passes install failure output to the remediation callback and retries successfully', async () => {
    const fixture = createGitFixture('transport-sync-install-retry');
    fixture.commitFile(fixture.worktreeDir, 'feature.txt', 'feature work\n', 'feature work');
    advanceMain(fixture, 'main.txt', 'main work\n', 'main work');

    const allowFile = path.join(fixture.tempDir, 'install-allowed');
    const installCommand = createInstallCommand(fixture.tempDir, 'install-flaky.sh', [
      `if [ -f ${sh(allowFile)} ]; then`,
      `  printf 'recovered\\n'`,
      '  exit 0',
      'fi',
      `printf 'lock mismatch\\n' >&2`,
      `printf 'npm notice\\n'`,
      'exit 1',
    ]);
    const { syncWorktree } = await fixture.importWorktreeModule({ installCommand });
    const remediateInstallError = vi.fn((installError: string) => {
      expect(installError).toContain('lock mismatch');
      writeFileSync(allowFile, 'ok\n');
      return Promise.resolve(0);
    });

    await expect(
      syncWorktree(
        {
          wtPath: fixture.worktreeDir,
          repoRoot: fixture.repoDir,
          baseBranch: 'main',
          pushMode: 'force-with-lease',
        },
        vi.fn(),
        remediateInstallError
      )
    ).resolves.toBeUndefined();

    expect(remediateInstallError).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('throws after exhausting install remediation attempts', async () => {
    const fixture = createGitFixture('transport-sync-install-exhaust');
    fixture.commitFile(fixture.worktreeDir, 'feature.txt', 'feature work\n', 'feature work');
    advanceMain(fixture, 'main.txt', 'main work\n', 'main work');

    const installCommand = createInstallCommand(fixture.tempDir, 'install-always-fails.sh', [
      `printf 'still broken\\n' >&2`,
      'exit 1',
    ]);
    const { syncWorktree } = await fixture.importWorktreeModule({ installCommand });
    const remediateInstallError = vi.fn().mockResolvedValue(0);

    await expect(
      syncWorktree(
        {
          wtPath: fixture.worktreeDir,
          repoRoot: fixture.repoDir,
          baseBranch: 'main',
          pushMode: 'force-with-lease',
        },
        vi.fn(),
        remediateInstallError
      )
    ).rejects.toThrow('Post-rebase install failed after 3 remediation attempts');

    expect(remediateInstallError).toHaveBeenCalledTimes(3);
  }, 20_000);

  it('throws on the first install failure when no remediation callback is provided', async () => {
    const fixture = createGitFixture('transport-sync-install-no-remediation');
    fixture.commitFile(fixture.worktreeDir, 'feature.txt', 'feature work\n', 'feature work');
    advanceMain(fixture, 'main.txt', 'main work\n', 'main work');

    const installCommand = createInstallCommand(fixture.tempDir, 'install-fails.sh', [
      `printf 'lock mismatch\\n' >&2`,
      `printf 'npm notice\\n'`,
      'exit 1',
    ]);
    const { syncWorktree } = await fixture.importWorktreeModule({ installCommand });

    await expect(
      syncWorktree(
        {
          wtPath: fixture.worktreeDir,
          repoRoot: fixture.repoDir,
          baseBranch: 'main',
          pushMode: 'force-with-lease',
        },
        vi.fn()
      )
    ).rejects.toThrow('Post-rebase install failed:');
  }, 20_000);

  it('resets to the remote branch before rebasing when origin/current-branch exists', async () => {
    const fixture = createGitFixture('transport-sync-reset-remote');
    fixture.commitFile(fixture.worktreeDir, 'kept.txt', 'keep me\n', 'keep me');
    fixture.runGit(fixture.worktreeDir, ['push', '-u', 'origin', 'HEAD']);
    fixture.commitFile(fixture.worktreeDir, 'discarded.txt', 'discard me\n', 'discard me');
    advanceMain(fixture, 'main.txt', 'main work\n', 'main work');
    const { syncWorktree } = await fixture.importWorktreeModule();

    await expect(
      syncWorktree(
        {
          wtPath: fixture.worktreeDir,
          repoRoot: fixture.repoDir,
          baseBranch: 'main',
          pushMode: 'force-with-lease',
        },
        vi.fn()
      )
    ).resolves.toBeUndefined();

    expect(hasPath(fixture.worktreeDir, 'discarded.txt')).toBe(false);
    expect(hasPath(fixture.worktreeDir, 'kept.txt')).toBe(true);
    expect(hasPath(fixture.worktreeDir, 'main.txt')).toBe(true);
  }, 20_000);

  it('surfaces unresolved and thrown conflict-resolution callbacks', async () => {
    const fixture = createGitFixture('transport-sync-unresolved');
    createTextConflict(fixture);
    const { syncWorktree } = await fixture.importWorktreeModule();

    await expect(
      syncWorktree(
        {
          wtPath: fixture.worktreeDir,
          repoRoot: fixture.repoDir,
          baseBranch: 'main',
          pushMode: 'force-with-lease',
        },
        vi.fn().mockResolvedValue(2)
      )
    ).rejects.toThrow('Conflict resolution exited with code 2');

    await expect(
      syncWorktree(
        {
          wtPath: fixture.worktreeDir,
          repoRoot: fixture.repoDir,
          baseBranch: 'main',
          pushMode: 'force-with-lease',
        },
        vi.fn(() => Promise.reject(new Error('resolver exploded')))
      )
    ).rejects.toThrow('resolver exploded');
  }, 20_000);
});

describe('withGitTransport integration', () => {
  it('runs install before the first agent invocation and still pushes after a non-zero initial agent exit', async () => {
    const fixture = createGitFixture('transport-with-install-before-agent');
    fixture.commitFile(fixture.worktreeDir, 'feature.txt', 'feature work\n', 'feature work');
    advanceMain(fixture, 'main.txt', 'main work\n', 'main work');

    const installLog = path.join(fixture.tempDir, 'install.log');
    const installCommand = createInstallCommand(fixture.tempDir, 'install-before-agent.sh', [
      `printf 'install\\n' >> ${sh(installLog)}`,
    ]);
    const { withGitTransport } = await fixture.importWorktreeModule({ installCommand });
    const runAgent = vi.fn(() => {
      expect(readFileSync(installLog, 'utf8')).toBe('install\n');
      return Promise.resolve(2);
    });

    await expect(
      withGitTransport(
        {
          wtPath: fixture.worktreeDir,
          repoRoot: fixture.repoDir,
          baseBranch: 'main',
          pushMode: 'new-branch',
        },
        runAgent
      )
    ).resolves.toBe(0);

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(remoteRefSha(fixture, `refs/heads/${fixture.branchName}`)).toBe(
      fixture.currentHead(fixture.worktreeDir)
    );
  }, 20_000);

  it('passes install failure output to the agent, retries, and continues before push', async () => {
    const fixture = createGitFixture('transport-with-install-remediation');
    fixture.commitFile(fixture.worktreeDir, 'feature.txt', 'feature work\n', 'feature work');
    advanceMain(fixture, 'main.txt', 'main work\n', 'main work');

    const allowFile = path.join(fixture.tempDir, 'allow-install');
    const installCommand = createInstallCommand(fixture.tempDir, 'install-remediate.sh', [
      `if [ -f ${sh(allowFile)} ]; then`,
      '  exit 0',
      'fi',
      `printf 'lock mismatch\\n' >&2`,
      `printf 'npm notice\\n'`,
      'exit 1',
    ]);
    const { withGitTransport } = await fixture.importWorktreeModule({ installCommand });
    const runAgent = vi.fn(
      (
        _conflictContext: ConflictContext | undefined,
        _pushError: string | undefined,
        installError?: string
      ) => {
        if (installError) {
          expect(installError).toContain('lock mismatch');
          writeFileSync(allowFile, 'ok\n');
          return Promise.resolve(0);
        }
        return Promise.resolve(0);
      }
    );

    await expect(
      withGitTransport(
        {
          wtPath: fixture.worktreeDir,
          repoRoot: fixture.repoDir,
          baseBranch: 'main',
          pushMode: 'new-branch',
        },
        runAgent
      )
    ).resolves.toBe(0);

    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(runAgent.mock.calls[0]?.[2]).toContain('lock mismatch');
    expect(runAgent.mock.calls[1]).toEqual([]);
    expect(remoteRefSha(fixture, `refs/heads/${fixture.branchName}`)).toBe(
      fixture.currentHead(fixture.worktreeDir)
    );
  }, 20_000);

  it('returns the install remediation agent exit code before the main agent runs', async () => {
    const fixture = createGitFixture('transport-with-install-agent-exit');
    fixture.commitFile(fixture.worktreeDir, 'feature.txt', 'feature work\n', 'feature work');
    advanceMain(fixture, 'main.txt', 'main work\n', 'main work');

    const installCommand = createInstallCommand(fixture.tempDir, 'install-always-fails.sh', [
      `printf 'lock mismatch\\n' >&2`,
      'exit 1',
    ]);
    const { withGitTransport } = await fixture.importWorktreeModule({ installCommand });
    const runAgent = vi.fn().mockResolvedValue(7);

    await expect(
      withGitTransport(
        {
          wtPath: fixture.worktreeDir,
          repoRoot: fixture.repoDir,
          baseBranch: 'main',
          pushMode: 'new-branch',
        },
        runAgent
      )
    ).resolves.toBe(7);

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(runAgent.mock.calls[0]?.[2]).toContain('lock mismatch');
    expect(() => remoteRefSha(fixture, `refs/heads/${fixture.branchName}`)).toThrow();
  }, 20_000);

  it('retries the original push after a pre-push hook failure', async () => {
    const fixture = createGitFixture('transport-with-hook-retry');
    fixture.commitFile(fixture.worktreeDir, 'feature.txt', 'feature work\n', 'feature work');
    advanceMain(fixture, 'main.txt', 'main work\n', 'main work');

    const hookCounter = path.join(fixture.tempDir, 'hook-count');
    fixture.writeRemotePreReceiveHook(
      [
        '#!/bin/sh',
        'set -eu',
        `count=$(cat ${sh(hookCounter)} 2>/dev/null || printf '0')`,
        'count=$((count + 1))',
        `printf '%s' "$count" > ${sh(hookCounter)}`,
        'if [ "$count" -eq 1 ]; then',
        `  printf 'husky - pre-push hook exited with code 1\\n' >&2`,
        '  exit 1',
        'fi',
        '',
      ].join('\n')
    );
    const { withGitTransport } = await fixture.importWorktreeModule();
    const runAgent = vi.fn().mockResolvedValue(0);

    await expect(
      withGitTransport(
        {
          wtPath: fixture.worktreeDir,
          repoRoot: fixture.repoDir,
          baseBranch: 'main',
          pushMode: 'new-branch',
        },
        runAgent
      )
    ).resolves.toBe(0);

    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(runAgent.mock.calls[1]?.[1]).toContain('husky - pre-push hook exited with code 1');
    expect(readFileSync(hookCounter, 'utf8')).toBe('2');
    expect(remoteRefSha(fixture, `refs/heads/${fixture.branchName}`)).toBe(
      fixture.currentHead(fixture.worktreeDir)
    );
  }, 20_000);

  it('passes conflicts without inline markers through to the agent', async () => {
    const fixture = createGitFixture('transport-with-binary-conflict');
    const binaryPath = 'assets/logo.png';
    mkdirSync(path.dirname(path.join(fixture.worktreeDir, binaryPath)), { recursive: true });
    writeFileSync(path.join(fixture.worktreeDir, binaryPath), Buffer.from([0, 1, 2, 3]));
    fixture.runGit(fixture.worktreeDir, ['add', binaryPath]);
    fixture.runGit(fixture.worktreeDir, ['commit', '-m', 'local binary']);
    mkdirSync(path.dirname(path.join(fixture.repoDir, binaryPath)), { recursive: true });
    writeFileSync(path.join(fixture.repoDir, binaryPath), Buffer.from([9, 8, 7, 6]));
    fixture.runGit(fixture.repoDir, ['add', binaryPath]);
    fixture.runGit(fixture.repoDir, ['commit', '-m', 'main binary']);
    fixture.runGit(fixture.repoDir, ['push', 'origin', 'main']);
    const { withGitTransport } = await fixture.importWorktreeModule();
    const runAgent = vi.fn().mockResolvedValue(2);

    await expect(
      withGitTransport(
        {
          wtPath: fixture.worktreeDir,
          repoRoot: fixture.repoDir,
          baseBranch: 'main',
          pushMode: 'force-with-lease',
        },
        runAgent
      )
    ).resolves.toBe(2);

    expect(runAgent).toHaveBeenCalledTimes(1);
    const [conflictContext] = runAgent.mock.calls[0] as [ConflictContext | undefined];
    expect(conflictContext?.conflicts[0]?.markers).toEqual([]);
  }, 20_000);

  it('returns the agent exit code without pushing when the initial rebase conflict is unresolved', async () => {
    const fixture = createGitFixture('transport-with-rebase-abort');
    createTextConflict(fixture);
    const { withGitTransport } = await fixture.importWorktreeModule();
    const runAgent = vi.fn().mockResolvedValue(2);

    await expect(
      withGitTransport(
        {
          wtPath: fixture.worktreeDir,
          repoRoot: fixture.repoDir,
          baseBranch: 'main',
          pushMode: 'force-with-lease',
        },
        runAgent
      )
    ).resolves.toBe(2);

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(() => remoteRefSha(fixture, `refs/heads/${fixture.branchName}`)).toThrow();
  }, 20_000);
});
