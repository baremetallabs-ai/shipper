import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

const getSettingsMock = vi.fn<() => { cliVersion?: string }>();

vi.mock('../../src/lib/settings.js', () => ({
  getSettings: () => getSettingsMock(),
}));

let savedVersion: string | undefined;
let savedSkip: string | undefined;
let warnSpy: MockInstance<typeof console.warn>;
const tempDirs: string[] = [];

function createTempGitRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), 'shipper-version-'));
  tempDirs.push(repo);
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
  return repo;
}

function writeDogfoodIdentity(repo: string): void {
  mkdirSync(path.join(repo, 'packages/cli'), { recursive: true });
  writeFileSync(
    path.join(repo, 'package.json'),
    JSON.stringify({ name: 'shipper-monorepo' }, null, 2)
  );
  writeFileSync(
    path.join(repo, 'packages/cli/package.json'),
    JSON.stringify(
      {
        name: '@baremetallabs-ai/shipper-cli',
        repository: {
          url: 'https://github.com/baremetallabs-ai/shipper.git',
        },
      },
      null,
      2
    )
  );
}

function useDogfoodRepo(): string {
  const repo = createTempGitRepo();
  writeDogfoodIdentity(repo);
  return repo;
}

function useNonDogfoodRepo(): string {
  const repo = createTempGitRepo();
  writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'user-repo' }, null, 2));
  return repo;
}

function getWarningText(): string {
  return warnSpy.mock.calls.map(([message]) => String(message)).join('\n');
}

beforeEach(() => {
  savedVersion = process.env.SHIPPER_VERSION;
  savedSkip = process.env.SHIPPER_SKIP_VERSION_CHECK;
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  delete process.env.SHIPPER_SKIP_VERSION_CHECK;
  getSettingsMock.mockReset();
  vi.resetModules();
});

afterEach(() => {
  if (savedVersion !== undefined) {
    process.env.SHIPPER_VERSION = savedVersion;
  } else {
    delete process.env.SHIPPER_VERSION;
  }
  if (savedSkip !== undefined) {
    process.env.SHIPPER_SKIP_VERSION_CHECK = savedSkip;
  } else {
    delete process.env.SHIPPER_SKIP_VERSION_CHECK;
  }
  warnSpy.mockRestore();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('checkVersionFreshness', () => {
  it('does not error when versions match', async () => {
    process.env.SHIPPER_VERSION = '1.0.0';
    const { checkVersionFreshness } = await import('../../src/lib/version.js');
    getSettingsMock.mockReturnValue({ cliVersion: '1.0.0' });
    expect(() => {
      checkVersionFreshness();
    }).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns once in Shipper dogfood mode when the running version is newer than recorded', async () => {
    const repo = useDogfoodRepo();
    process.env.SHIPPER_VERSION = '2.0.0';
    const { checkVersionFreshness } = await import('../../src/lib/version.js');
    getSettingsMock.mockReturnValue({ cliVersion: '1.0.0' });
    expect(() => {
      checkVersionFreshness({ cwd: repo });
    }).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warning = getWarningText();
    expect(warning).toContain('Shipper dogfood mode');
    expect(warning).toContain('2.0.0');
    expect(warning).toContain('1.0.0');
    expect(warning).toContain('shipper init');
    expect(warning).toContain('packages/cli/package.json');
  });

  it('warns once in Shipper dogfood mode when the running version is older than recorded', async () => {
    const repo = useDogfoodRepo();
    process.env.SHIPPER_VERSION = '1.0.0';
    const { checkVersionFreshness } = await import('../../src/lib/version.js');
    getSettingsMock.mockReturnValue({ cliVersion: '2.0.0' });
    expect(() => {
      checkVersionFreshness({ cwd: repo });
    }).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warning = getWarningText();
    expect(warning).toContain('Shipper dogfood mode');
    expect(warning).toContain('1.0.0');
    expect(warning).toContain('2.0.0');
    expect(warning).toContain('shipper init');
    expect(warning).toContain('packages/cli/package.json');
  });

  it('warns once in Shipper dogfood mode when the fingerprint is missing', async () => {
    const repo = useDogfoodRepo();
    process.env.SHIPPER_VERSION = '1.0.0';
    const { checkVersionFreshness } = await import('../../src/lib/version.js');
    getSettingsMock.mockReturnValue({});
    expect(() => {
      checkVersionFreshness({ cwd: repo });
    }).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warning = getWarningText();
    expect(warning).toContain('Shipper dogfood mode');
    expect(warning).toContain('1.0.0');
    expect(warning).toContain('<missing>');
    expect(warning).toContain('shipper init');
    expect(warning).toContain('packages/cli/package.json');
  });

  it('throws without warning in non-dogfood repos when versions mismatch', async () => {
    const repo = useNonDogfoodRepo();
    process.env.SHIPPER_VERSION = '2.0.0';
    const { checkVersionFreshness } = await import('../../src/lib/version.js');
    getSettingsMock.mockReturnValue({ cliVersion: '1.0.0' });
    expect(() => {
      checkVersionFreshness({ cwd: repo });
    }).toThrow('Installed CLI version (2.0.0)');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('throws without warning in non-dogfood repos when fingerprint is missing', async () => {
    const repo = useNonDogfoodRepo();
    process.env.SHIPPER_VERSION = '1.0.0';
    const { checkVersionFreshness } = await import('../../src/lib/version.js');
    getSettingsMock.mockReturnValue({});
    expect(() => {
      checkVersionFreshness({ cwd: repo });
    }).toThrow('No version fingerprint found');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('skips check when installed version is 0.0.0-dev', async () => {
    delete process.env.SHIPPER_VERSION;
    const { checkVersionFreshness } = await import('../../src/lib/version.js');
    getSettingsMock.mockReturnValue({ cliVersion: '1.0.0' });
    expect(() => {
      checkVersionFreshness();
    }).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('skips check when recorded version is 0.0.0-dev', async () => {
    process.env.SHIPPER_VERSION = '1.0.0';
    const { checkVersionFreshness } = await import('../../src/lib/version.js');
    getSettingsMock.mockReturnValue({ cliVersion: '0.0.0-dev' });
    expect(() => {
      checkVersionFreshness();
    }).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('skips check when SHIPPER_SKIP_VERSION_CHECK=1', async () => {
    process.env.SHIPPER_VERSION = '2.0.0';
    process.env.SHIPPER_SKIP_VERSION_CHECK = '1';
    const { checkVersionFreshness } = await import('../../src/lib/version.js');
    getSettingsMock.mockReturnValue({ cliVersion: '1.0.0' });
    expect(() => {
      checkVersionFreshness();
    }).not.toThrow();
    expect(getSettingsMock).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
