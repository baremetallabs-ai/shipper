import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const tempRepos: string[] = [];
const originalVersion = process.env.SHIPPER_VERSION;
const originalPath = process.env.PATH;
const originalSentinel = process.env.SHIPPER_TEST_GH_SENTINEL;

const silentLogger = {
  log(_message: string) {
    void _message;
  },
  error(_message: string) {
    void _message;
  },
};

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
}

function gitEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) {
      Reflect.deleteProperty(env, key);
    }
  }
  return env;
}

async function withCleanGitEnv<T>(callback: () => Promise<T>): Promise<T> {
  const previousGitEnv = new Map<string, string | undefined>();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('GIT_')) {
      previousGitEnv.set(key, process.env[key]);
      Reflect.deleteProperty(process.env, key);
    }
  }

  try {
    return await callback();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('GIT_') && !previousGitEnv.has(key)) {
        Reflect.deleteProperty(process.env, key);
      }
    }
    for (const [key, value] of previousGitEnv) {
      restoreEnvValue(key, value);
    }
  }
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    env: gitEnv(),
    encoding: 'utf-8',
  });
}

function createTempRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), 'shipper-init-drift-repo-'));
  tempRepos.push(repo);

  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'shipper@example.test']);
  git(repo, ['config', 'user.name', 'Shipper Test']);

  return repo;
}

async function loadInitCommand(version: string) {
  vi.resetModules();
  process.env.SHIPPER_VERSION = version;
  return await import('../../src/commands/init.js');
}

async function loadChecker(version: string) {
  vi.resetModules();
  process.env.SHIPPER_VERSION = version;
  return await import('../../src/scripts/check-init-drift.js');
}

async function seedInitializedRepo(version = '3.0.1'): Promise<string> {
  const repo = createTempRepo();
  const { initCommand } = await loadInitCommand(version);
  const previousCwd = process.cwd();

  try {
    process.chdir(repo);
    await initCommand({ agent: 'codex', offline: true, logger: silentLogger });
  } finally {
    process.chdir(previousCwd);
  }

  git(repo, ['add', '--', '.shipper']);
  git(repo, ['commit', '-m', 'seed shipper init']);

  return repo;
}

async function runCheck(repo: string, version = '3.0.1') {
  const { checkInitDrift } = await loadChecker(version);
  return await withCleanGitEnv(() => checkInitDrift({ repoRoot: repo }));
}

afterEach(() => {
  restoreEnvValue('SHIPPER_VERSION', originalVersion);
  restoreEnvValue('PATH', originalPath);
  restoreEnvValue('SHIPPER_TEST_GH_SENTINEL', originalSentinel);
  vi.resetModules();

  for (const repo of tempRepos.splice(0)) {
    rmSync(repo, { recursive: true, force: true });
  }
});

describe('checkInitDrift', () => {
  it('passes without output details when committed init output is current', async () => {
    const repo = await seedInitializedRepo();

    const result = await runCheck(repo);

    expect(result).toEqual({ ok: true, status: '', diff: '' });
  });

  it('fails with settings drift and remediation when the CLI version changes', async () => {
    const repo = await seedInitializedRepo('3.0.1');
    const { formatInitDriftFailure } = await loadChecker('3.0.2');

    const result = await withCleanGitEnv(async () => {
      const { checkInitDrift } = await import('../../src/scripts/check-init-drift.js');
      return await checkInitDrift({ repoRoot: repo });
    });

    expect(result.ok).toBe(false);
    const output = formatInitDriftFailure(result);
    expect(output).toContain('.shipper/settings.json');
    expect(output).toContain('Run `shipper init` and commit the resulting changes.');
  });

  it('fails with script drift and remediation when an init-managed script changes', async () => {
    const repo = await seedInitializedRepo();
    const scriptPath = path.join(repo, '.shipper/scripts/install-deps.sh');
    writeFileSync(scriptPath, '#!/usr/bin/env bash\necho drift\n');
    chmodSync(scriptPath, 0o755);
    git(repo, ['add', '--', '.shipper/scripts/install-deps.sh']);
    git(repo, ['commit', '-m', 'drift install deps']);
    const { formatInitDriftFailure } = await loadChecker('3.0.1');

    const result = await withCleanGitEnv(async () => {
      const { checkInitDrift } = await import('../../src/scripts/check-init-drift.js');
      return await checkInitDrift({ repoRoot: repo });
    });

    expect(result.ok).toBe(false);
    const output = formatInitDriftFailure(result);
    expect(output).toContain('.shipper/scripts/install-deps.sh');
    expect(output).toContain('Run `shipper init` and commit the resulting changes.');
  });

  it('includes a diff for an init-managed file that init would add', async () => {
    const repo = await seedInitializedRepo();
    git(repo, ['rm', '--', '.shipper/scripts/install-deps.sh']);
    git(repo, ['commit', '-m', 'remove install deps']);
    const { formatInitDriftFailure } = await loadChecker('3.0.1');

    const result = await withCleanGitEnv(async () => {
      const { checkInitDrift } = await import('../../src/scripts/check-init-drift.js');
      return await checkInitDrift({ repoRoot: repo });
    });

    expect(result.ok).toBe(false);
    expect(result.diff).toContain('new file mode');
    expect(result.diff).toContain('.shipper/scripts/install-deps.sh');
    const output = formatInitDriftFailure(result);
    expect(output).toContain('.shipper/scripts/install-deps.sh');
    expect(output).toContain('Run `shipper init` and commit the resulting changes.');
  });

  it('still reports affected files and remediation when the diff exceeds the capture buffer', async () => {
    const repo = await seedInitializedRepo();
    const largePath = path.join(repo, '.shipper/input/large.txt');
    writeFileSync(largePath, `${'x'.repeat(1024 * 1024 + 1)}\n`);
    git(repo, ['add', '--force', '--', '.shipper/input/large.txt']);
    git(repo, ['commit', '-m', 'track large input artifact']);
    const { formatInitDriftFailure } = await loadChecker('3.0.1');

    const result = await withCleanGitEnv(async () => {
      const { checkInitDrift } = await import('../../src/scripts/check-init-drift.js');
      return await checkInitDrift({ repoRoot: repo });
    });

    expect(result.ok).toBe(false);
    const output = formatInitDriftFailure(result);
    expect(output).toContain('.shipper/input/large.txt');
    expect(output).toContain('Diff omitted because it exceeded 1048576 bytes.');
    expect(output).toContain('Run `shipper init` and commit the resulting changes.');
  });

  it.each(['.shipper/.gitignore', '.shipper/input/.gitkeep', '.shipper/output/.gitkeep'])(
    'fails with remediation when %s drifts',
    async (relativePath) => {
      const repo = await seedInitializedRepo();
      writeFileSync(path.join(repo, relativePath), 'drift\n');
      git(repo, ['add', '--', relativePath]);
      git(repo, ['commit', '-m', `drift ${relativePath}`]);
      const { formatInitDriftFailure } = await loadChecker('3.0.1');

      const result = await withCleanGitEnv(async () => {
        const { checkInitDrift } = await import('../../src/scripts/check-init-drift.js');
        return await checkInitDrift({ repoRoot: repo });
      });

      expect(result.ok).toBe(false);
      const output = formatInitDriftFailure(result);
      expect(output).toContain(relativePath);
      expect(output).toContain('Run `shipper init` and commit the resulting changes.');
    }
  );

  it('does not call gh while checking a clean repo', async () => {
    const repo = await seedInitializedRepo();
    const binDir = mkdtempSync(path.join(tmpdir(), 'shipper-fake-gh-'));
    tempRepos.push(binDir);
    const sentinelPath = path.join(binDir, 'gh-called');
    const ghPath = path.join(binDir, 'gh');
    writeFileSync(
      ghPath,
      '#!/bin/sh\n' +
        'echo "fake gh should not be called" >&2\n' +
        'printf "%s\\n" called > "$SHIPPER_TEST_GH_SENTINEL"\n' +
        'exit 99\n'
    );
    chmodSync(ghPath, 0o755);
    process.env.SHIPPER_TEST_GH_SENTINEL = sentinelPath;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`;

    const result = await runCheck(repo);

    expect(result).toEqual({ ok: true, status: '', diff: '' });
    expect(existsSync(sentinelPath)).toBe(false);
  });
});
