import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../../../..');
const scriptPath = path.join(repoRoot, 'scripts/check-cli-version-fingerprint.mjs');
const tempRepos: string[] = [];

interface TempRepoOptions {
  cliVersion?: string;
  packageVersion?: string;
}

function createTempRepo({ cliVersion, packageVersion = '3.0.0' }: TempRepoOptions): string {
  const repo = mkdtempSync(path.join(tmpdir(), 'shipper-fingerprint-'));
  tempRepos.push(repo);

  mkdirSync(path.join(repo, '.shipper'), { recursive: true });
  mkdirSync(path.join(repo, 'packages/cli'), { recursive: true });

  const settings = cliVersion === undefined ? {} : { cliVersion };
  writeFileSync(path.join(repo, '.shipper/settings.json'), JSON.stringify(settings, null, 2));
  writeFileSync(
    path.join(repo, 'packages/cli/package.json'),
    JSON.stringify({ version: packageVersion }, null, 2)
  );

  return repo;
}

function runGuard(cwd: string) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd,
    encoding: 'utf8',
  });
}

afterEach(() => {
  for (const repo of tempRepos.splice(0)) {
    rmSync(repo, { recursive: true, force: true });
  }
});

describe('check-cli-version-fingerprint', () => {
  it('passes without output when the recorded fingerprint matches the CLI manifest', () => {
    const repo = createTempRepo({ cliVersion: '3.0.0', packageVersion: '3.0.0' });

    const result = runGuard(repo);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('fails with both values and remediation when the versions differ', () => {
    const repo = createTempRepo({ cliVersion: '3.0.0', packageVersion: '3.1.0' });

    const result = runGuard(repo);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Shipper CLI version fingerprint drift detected');
    expect(result.stderr).toContain('.shipper/settings.json cliVersion: 3.0.0');
    expect(result.stderr).toContain('packages/cli/package.json version: 3.1.0');
    expect(result.stderr).toContain('shipper init');
    expect(result.stderr).toContain('packages/cli/package.json');
  });

  it('fails with a missing placeholder and remediation when cliVersion is absent', () => {
    const repo = createTempRepo({ packageVersion: '3.0.0' });

    const result = runGuard(repo);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('.shipper/settings.json cliVersion: <missing>');
    expect(result.stderr).toContain('packages/cli/package.json version: 3.0.0');
    expect(result.stderr).toContain('shipper init');
    expect(result.stderr).toContain('revert/align `packages/cli/package.json`');
  });
});
