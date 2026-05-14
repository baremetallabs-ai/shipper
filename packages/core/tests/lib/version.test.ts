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

function getThrownMessage(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return (error as Error).message;
  }

  throw new Error('Expected function to throw');
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
  it('does not error or warn in non-dogfood repos when parsed versions match', async () => {
    const repo = useNonDogfoodRepo();
    process.env.SHIPPER_VERSION = '1.0.0';
    const { checkVersionFreshness } = await import('../../src/lib/version.js');
    getSettingsMock.mockReturnValue({ cliVersion: '1.0.0' });
    expect(() => {
      checkVersionFreshness({ cwd: repo });
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

  it('warns once in Shipper dogfood mode when the version state is unparseable', async () => {
    const repo = useDogfoodRepo();
    process.env.SHIPPER_VERSION = 'not-a-version';
    const { checkVersionFreshness } = await import('../../src/lib/version.js');
    getSettingsMock.mockReturnValue({ cliVersion: '3.0.1' });
    expect(() => {
      checkVersionFreshness({ cwd: repo });
    }).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warning = getWarningText();
    expect(warning).toContain('Shipper dogfood mode');
    expect(warning).toContain('not-a-version');
    expect(warning).toContain('3.0.1');
    expect(warning).toContain('shipper init');
    expect(warning).toContain('packages/cli/package.json');
  });

  it.each([
    { recorded: '3.0.1', installed: '3.0.2' },
    { recorded: '3.0.1', installed: '3.2.0' },
  ])(
    'warns and proceeds in non-dogfood repos when installed $installed is newer than recorded $recorded within the same major version',
    async ({ recorded, installed }) => {
      const repo = useNonDogfoodRepo();
      process.env.SHIPPER_VERSION = installed;
      const { checkVersionFreshness } = await import('../../src/lib/version.js');
      getSettingsMock.mockReturnValue({ cliVersion: recorded });

      expect(() => {
        checkVersionFreshness({ cwd: repo });
      }).not.toThrow();

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const warning = getWarningText();
      expect(warning).toContain(installed);
      expect(warning).toContain(recorded);
      expect(warning).toContain('shipper init');
    }
  );

  it('warns again on repeated same-major drift without refreshing the recorded fingerprint', async () => {
    const repo = useNonDogfoodRepo();
    process.env.SHIPPER_VERSION = '3.2.0';
    const { checkVersionFreshness } = await import('../../src/lib/version.js');
    getSettingsMock.mockReturnValue({ cliVersion: '3.0.1' });

    expect(() => {
      checkVersionFreshness({ cwd: repo });
      checkVersionFreshness({ cwd: repo });
    }).not.toThrow();

    expect(warnSpy).toHaveBeenCalledTimes(2);
    const warning = getWarningText();
    expect(warning).toContain('3.2.0');
    expect(warning).toContain('3.0.1');
    expect(warning).toContain('shipper init');
  });

  it.each([
    {
      name: 'newer major drift',
      recorded: '3.0.1',
      installed: '4.0.0',
      expected: 'major',
    },
    {
      name: 'patch downgrade',
      recorded: '3.2.1',
      installed: '3.2.0',
      expected: 'Downgrades are blocked',
    },
    {
      name: 'minor downgrade',
      recorded: '3.2.0',
      installed: '3.1.5',
      expected: 'Downgrades are blocked',
    },
    {
      name: 'major downgrade',
      recorded: '4.0.0',
      installed: '3.9.9',
      expected: 'Downgrades are blocked',
    },
  ])(
    'throws without warning in non-dogfood repos for $name',
    async ({ recorded, installed, expected }) => {
      const repo = useNonDogfoodRepo();
      process.env.SHIPPER_VERSION = installed;
      const { checkVersionFreshness } = await import('../../src/lib/version.js');
      getSettingsMock.mockReturnValue({ cliVersion: recorded });

      const message = getThrownMessage(() => {
        checkVersionFreshness({ cwd: repo });
      });

      expect(message).toContain(installed);
      expect(message).toContain(recorded);
      expect(message).toContain(expected);
      expect(message).toContain('shipper init');
      expect(warnSpy).not.toHaveBeenCalled();
    }
  );

  it('throws without warning in non-dogfood repos when fingerprint is missing', async () => {
    const repo = useNonDogfoodRepo();
    process.env.SHIPPER_VERSION = '1.0.0';
    const { checkVersionFreshness } = await import('../../src/lib/version.js');
    getSettingsMock.mockReturnValue({});

    const message = getThrownMessage(() => {
      checkVersionFreshness({ cwd: repo });
    });

    expect(message).toContain('Cannot verify Shipper CLI version freshness');
    expect(message).toContain('1.0.0');
    expect(message).toContain('<missing>');
    expect(message).toContain('major.minor.patch');
    expect(message).toContain('shipper init');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'recorded fingerprint is unparseable',
      recorded: 'not-a-version',
      installed: '3.0.1',
    },
    {
      name: 'installed version is unparseable',
      recorded: '3.0.1',
      installed: 'not-a-version',
    },
    {
      name: 'both sides are equal but unparseable',
      recorded: 'not-a-version',
      installed: 'not-a-version',
    },
  ])('throws without warning in non-dogfood repos when $name', async ({ recorded, installed }) => {
    const repo = useNonDogfoodRepo();
    process.env.SHIPPER_VERSION = installed;
    const { checkVersionFreshness } = await import('../../src/lib/version.js');
    getSettingsMock.mockReturnValue({ cliVersion: recorded });

    const message = getThrownMessage(() => {
      checkVersionFreshness({ cwd: repo });
    });

    expect(message).toContain('Cannot verify Shipper CLI version freshness');
    expect(message).toContain(installed);
    expect(message).toContain(recorded);
    expect(message).toContain('major.minor.patch');
    expect(message).toContain('shipper init');
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
