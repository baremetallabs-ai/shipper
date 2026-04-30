import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGh, mockExecFileAsync, mockAccess, mockMkdir } = vi.hoisted(() => ({
  mockGh: vi.fn<(args: string[]) => Promise<{ stdout: string; stderr: string }>>(),
  mockExecFileAsync:
    vi.fn<
      (
        cmd: string,
        args: string[],
        opts?: Record<string, unknown>
      ) => Promise<{ stdout: string; stderr: string }>
    >(),
  mockAccess: vi.fn<(path: string) => Promise<void>>(),
  mockMkdir: vi.fn<(path: string, opts?: { recursive?: boolean }) => Promise<string | undefined>>(),
}));

vi.mock('../../src/lib/gh.js', () => ({
  gh: (...args: unknown[]) => {
    return mockGh(...(args as [string[]]));
  },
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    access: (...args: unknown[]) => mockAccess(...(args as Parameters<typeof mockAccess>)),
    mkdir: (...args: unknown[]) => mockMkdir(...(args as Parameters<typeof mockMkdir>)),
  };
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const execFile = Object.assign(
    (...args: unknown[]) => {
      void mockExecFileAsync(...(args as Parameters<typeof mockExecFileAsync>));
    },
    {
      [promisify.custom]: (...args: unknown[]) =>
        mockExecFileAsync(...(args as Parameters<typeof mockExecFileAsync>)),
    }
  );
  return { ...actual, execFile };
});

const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
const stdoutSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
const originalGhToken = process.env.GH_TOKEN;
const originalGithubToken = process.env.GITHUB_TOKEN;

function restoreEnvVar(name: 'GH_TOKEN' | 'GITHUB_TOKEN', value: string | undefined): void {
  if (value === undefined) {
    if (name === 'GH_TOKEN') {
      delete process.env.GH_TOKEN;
    } else {
      delete process.env.GITHUB_TOKEN;
    }
  } else {
    process.env[name] = value;
  }
}

const {
  checkGhInstalled,
  checkGhAuth,
  checkGitRepo,
  checkGitHubRemote,
  checkLabels,
  checkShipperDir,
  maybeAutoSetupGit,
  runAuthPreflight,
  runPreflight,
  runPrereqChecks,
  warnTrackedOutputFiles,
} = await import('../../src/lib/prerequisites.js');

beforeEach(() => {
  mockGh.mockReset();
  mockExecFileAsync.mockReset();
  mockAccess.mockReset();
  mockMkdir.mockReset();
  stderrSpy.mockClear();
  stdoutSpy.mockClear();
  warnSpy.mockClear();
});

afterEach(() => {
  restoreEnvVar('GH_TOKEN', originalGhToken);
  restoreEnvVar('GITHUB_TOKEN', originalGithubToken);
});

describe('checkGhInstalled', () => {
  it('passes when gh --version succeeds', async () => {
    mockGh.mockResolvedValue({ stdout: 'gh version 2.0.0', stderr: '' });

    await expect(checkGhInstalled()).resolves.toEqual({
      ok: true,
      message: 'gh is installed',
    });
    expect(mockGh).toHaveBeenCalledWith(['--version']);
  });

  it('fails with the install guidance when gh --version throws', async () => {
    mockGh.mockRejectedValue(new Error('missing gh'));

    await expect(checkGhInstalled()).resolves.toEqual({
      ok: false,
      message: 'GitHub CLI (gh) is not installed. Install it from https://cli.github.com/',
    });
  });
});

describe('checkGhAuth', () => {
  it('passes when gh auth status succeeds', async () => {
    mockGh.mockResolvedValue({ stdout: 'logged in', stderr: '' });

    await expect(checkGhAuth()).resolves.toEqual({
      ok: true,
      message: 'gh is authenticated',
    });
    expect(mockGh).toHaveBeenCalledWith(['auth', 'status']);
  });

  it('fails with the auth guidance when gh auth status throws', async () => {
    mockGh.mockRejectedValue(new Error('not logged in'));

    await expect(checkGhAuth()).resolves.toEqual({
      ok: false,
      message: 'GitHub CLI is not authenticated. Run: gh auth login',
    });
  });
});

describe('maybeAutoSetupGit', () => {
  it('runs setup-git and logs when GH_TOKEN is set and no helper exists', async () => {
    process.env.GH_TOKEN = 'token';
    delete process.env.GITHUB_TOKEN;
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
    mockGh.mockResolvedValue({ stdout: '', stderr: '' });

    await expect(maybeAutoSetupGit()).resolves.toBeUndefined();

    expect(mockExecFileAsync).toHaveBeenCalledWith('git', [
      'config',
      '--get-urlmatch',
      'credential.helper',
      'https://github.com',
    ]);
    expect(mockGh).toHaveBeenCalledWith(['auth', 'setup-git']);
    expect(warnSpy).toHaveBeenCalledWith(
      '[shipper] Ran `gh auth setup-git` (token auth detected, no git credential helper was configured).'
    );
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('runs setup-git when only GITHUB_TOKEN is set and no helper exists', async () => {
    delete process.env.GH_TOKEN;
    process.env.GITHUB_TOKEN = 'token';
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
    mockGh.mockResolvedValue({ stdout: '', stderr: '' });

    await maybeAutoSetupGit();

    expect(mockGh).toHaveBeenCalledWith(['auth', 'setup-git']);
    expect(warnSpy).toHaveBeenCalledWith(
      '[shipper] Ran `gh auth setup-git` (token auth detected, no git credential helper was configured).'
    );
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('falls back to GITHUB_TOKEN when GH_TOKEN is empty', async () => {
    process.env.GH_TOKEN = '';
    process.env.GITHUB_TOKEN = 'token';
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
    mockGh.mockResolvedValue({ stdout: '', stderr: '' });

    await maybeAutoSetupGit();

    expect(mockExecFileAsync).toHaveBeenCalledWith('git', [
      'config',
      '--get-urlmatch',
      'credential.helper',
      'https://github.com',
    ]);
    expect(mockGh).toHaveBeenCalledWith(['auth', 'setup-git']);
  });

  it('skips setup-git when a credential helper already exists', async () => {
    process.env.GH_TOKEN = 'token';
    mockExecFileAsync.mockResolvedValue({ stdout: 'osxkeychain\n', stderr: '' });

    await maybeAutoSetupGit();

    expect(mockGh).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('skips setup-git when a GitHub URL-scoped credential helper already exists', async () => {
    process.env.GH_TOKEN = 'token';
    mockExecFileAsync.mockResolvedValue({ stdout: '!gh auth git-credential\n', stderr: '' });

    await maybeAutoSetupGit();

    expect(mockExecFileAsync).toHaveBeenCalledWith('git', [
      'config',
      '--get-urlmatch',
      'credential.helper',
      'https://github.com',
    ]);
    expect(mockGh).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('skips the git config probe when no token env var is set', async () => {
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;

    await maybeAutoSetupGit();

    expect(mockExecFileAsync).not.toHaveBeenCalled();
    expect(mockGh).not.toHaveBeenCalled();
  });

  it('runs setup-git when git config throws because no helper is configured', async () => {
    process.env.GH_TOKEN = 'token';
    mockExecFileAsync.mockRejectedValue(new Error('unset'));
    mockGh.mockResolvedValue({ stdout: '', stderr: '' });

    await maybeAutoSetupGit();

    expect(mockGh).toHaveBeenCalledWith(['auth', 'setup-git']);
  });

  it('warns and resolves when setup-git fails', async () => {
    process.env.GH_TOKEN = 'token';
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
    mockGh.mockRejectedValue(new Error('setup failed'));

    await expect(maybeAutoSetupGit()).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      '[shipper] Could not auto-configure git credential helper (setup failed). Run: gh auth setup-git'
    );
  });
});

describe('runAuthPreflight', () => {
  it('rejects with install guidance when gh is missing', async () => {
    mockGh.mockRejectedValue(new Error('missing gh'));

    await expect(runAuthPreflight()).rejects.toThrow(
      'GitHub CLI (gh) is not installed. Install it from https://cli.github.com/'
    );
  });

  it('rejects with the two-path auth message when gh auth status fails', async () => {
    mockGh.mockImplementation((args: string[]) => {
      if (args[0] === '--version') {
        return Promise.resolve({ stdout: 'gh version 2.0.0', stderr: '' });
      }
      return Promise.reject(new Error(`Unexpected gh call: ${args.join(' ')}`));
    });

    await expect(runAuthPreflight()).rejects.toThrow(/gh auth login/);
    await expect(runAuthPreflight()).rejects.toThrow(/GH_TOKEN/);
    await expect(runAuthPreflight()).rejects.toThrow(/GITHUB_TOKEN/);
    await expect(runAuthPreflight()).rejects.toThrow(
      /https:\/\/shipper\.baremetallabs\.ai\/reference\/containers\//
    );
  });

  it('does not run setup-git when auth fails', async () => {
    mockGh.mockImplementation((args: string[]) => {
      if (args[0] === '--version') {
        return Promise.resolve({ stdout: 'gh version 2.0.0', stderr: '' });
      }
      return Promise.reject(new Error('not logged in'));
    });

    await expect(runAuthPreflight()).rejects.toThrow(/GitHub CLI is not authenticated/);

    expect(mockGh).not.toHaveBeenCalledWith(['auth', 'setup-git']);
  });

  it('runs setup-git after successful install and auth checks when token auth has no helper', async () => {
    process.env.GH_TOKEN = 'token';
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
    mockGh.mockImplementation((args: string[]) => {
      if (args[0] === '--version') {
        return Promise.resolve({ stdout: 'gh version 2.0.0', stderr: '' });
      }
      if (args[0] === 'auth' && args[1] === 'status') {
        return Promise.resolve({ stdout: 'logged in', stderr: '' });
      }
      if (args[0] === 'auth' && args[1] === 'setup-git') {
        return Promise.resolve({ stdout: '', stderr: '' });
      }
      return Promise.reject(new Error(`Unexpected gh call: ${args.join(' ')}`));
    });

    await runAuthPreflight();

    expect(mockGh).toHaveBeenCalledWith(['auth', 'setup-git']);
  });
});

describe('checkGitRepo', () => {
  it('passes when git rev-parse succeeds', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '.git\n', stderr: '' });

    await expect(checkGitRepo()).resolves.toEqual({
      ok: true,
      message: 'Inside a git repository',
    });
    expect(mockExecFileAsync).toHaveBeenCalledWith('git', ['rev-parse', '--git-dir']);
  });

  it('fails when git rev-parse throws', async () => {
    mockExecFileAsync.mockRejectedValue(new Error('not a repo'));

    await expect(checkGitRepo()).resolves.toEqual({
      ok: false,
      message: 'Not inside a git repository. Run: git init',
    });
  });
});

describe('checkGitHubRemote', () => {
  it('passes when gh repo view returns a repository name', async () => {
    mockGh.mockResolvedValue({ stdout: 'my-repo\n', stderr: '' });

    await expect(checkGitHubRemote()).resolves.toEqual({
      ok: true,
      message: 'GitHub remote found: my-repo',
    });
    expect(mockGh).toHaveBeenCalledWith(['repo', 'view', '--json', 'name', '-q', '.name']);
  });

  it('forwards the repo flag when a repository is provided', async () => {
    mockGh.mockResolvedValue({ stdout: 'my-repo\n', stderr: '' });

    await expect(checkGitHubRemote('owner/repo')).resolves.toEqual({
      ok: true,
      message: 'GitHub remote found: my-repo',
    });
    expect(mockGh).toHaveBeenCalledWith([
      'repo',
      'view',
      '-R',
      'owner/repo',
      '--json',
      'name',
      '-q',
      '.name',
    ]);
  });

  it('fails when gh repo view returns empty output', async () => {
    mockGh.mockResolvedValue({ stdout: '\n', stderr: '' });

    await expect(checkGitHubRemote()).resolves.toEqual({
      ok: false,
      message: 'No GitHub remote found. Add a GitHub remote to this repository.',
    });
  });

  it('fails when gh repo view throws', async () => {
    mockGh.mockRejectedValue(new Error('gh failed'));

    await expect(checkGitHubRemote()).resolves.toEqual({
      ok: false,
      message: 'No GitHub remote found. Add a GitHub remote to this repository.',
    });
  });
});

describe('checkShipperDir', () => {
  it('passes when the .shipper directory exists', async () => {
    mockAccess.mockResolvedValue();

    await expect(checkShipperDir()).resolves.toEqual({
      ok: true,
      message: '.shipper directory exists',
    });
    expect(mockAccess).toHaveBeenCalledWith(path.resolve('.shipper'));
  });

  it('fails with guidance when the .shipper directory is missing', async () => {
    mockAccess.mockRejectedValue(new Error('ENOENT'));

    await expect(checkShipperDir()).resolves.toEqual({
      ok: false,
      message: '.shipper directory not found. Run: shipper init',
    });
  });
});

describe('checkLabels', () => {
  it('fails when shipper:pr-reviewed is the only missing workflow label', async () => {
    mockGh.mockResolvedValue({
      stdout: [
        'shipper:new',
        'shipper:groomed',
        'shipper:designed',
        'shipper:planned',
        'shipper:implemented',
        'shipper:pr-open',
        'shipper:ready',
      ].join('\n'),
      stderr: '',
    });

    await expect(checkLabels()).resolves.toEqual({
      ok: false,
      message: 'Missing label(s): shipper:pr-reviewed',
    });
  });

  it('passes when all workflow labels exist', async () => {
    mockGh.mockResolvedValue({
      stdout: [
        'shipper:new',
        'shipper:groomed',
        'shipper:designed',
        'shipper:planned',
        'shipper:implemented',
        'shipper:pr-open',
        'shipper:pr-reviewed',
        'shipper:ready',
      ].join('\n'),
      stderr: '',
    });

    await expect(checkLabels()).resolves.toEqual({
      ok: true,
      message: 'All required labels exist',
    });
  });

  it('does not pass --search to gh label list', async () => {
    // Regression: GitHub's label search treats `key:value` as a qualifier and
    // returns zero results, which made every shipper-initialized repo look
    // uninitialized in the desktop app.
    mockGh.mockResolvedValue({ stdout: '', stderr: '' });

    await checkLabels('owner/repo');

    expect(mockGh).toHaveBeenCalledTimes(1);
    const args = mockGh.mock.calls[0]?.[0] ?? [];
    expect(args).not.toContain('--search');
    expect(args).toEqual([
      'label',
      'list',
      '-R',
      'owner/repo',
      '-L',
      '200',
      '--json',
      'name',
      '-q',
      '.[].name',
    ]);
  });
});

describe('warnTrackedOutputFiles', () => {
  it('writes one warning per tracked output or input file', async () => {
    mockExecFileAsync.mockResolvedValue({
      stdout: '.shipper/output/result.json\r\n.shipper/input/example.txt\r\n',
      stderr: '',
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await warnTrackedOutputFiles();

    expect(mockExecFileAsync).toHaveBeenCalledWith('git', [
      'ls-files',
      '--',
      '.shipper/output/',
      '.shipper/input/',
    ]);
    expect(stderrSpy).toHaveBeenCalledTimes(2);
    expect(stderrSpy).toHaveBeenNthCalledWith(
      1,
      "⚠ .shipper/output/result.json is tracked by git but should be gitignored. Run 'shipper init' and commit the result to fix this.\n"
    );
    expect(stderrSpy).toHaveBeenNthCalledWith(
      2,
      "⚠ .shipper/input/example.txt is tracked by git but should be gitignored. Run 'shipper init' and commit the result to fix this.\n"
    );

    stderrSpy.mockRestore();
  });

  it('stays silent when no tracked files are returned', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await warnTrackedOutputFiles();

    expect(stderrSpy).not.toHaveBeenCalled();

    stderrSpy.mockRestore();
  });

  it('ignores .gitkeep entries', async () => {
    mockExecFileAsync.mockResolvedValue({
      stdout:
        '.shipper/output/.gitkeep\r\n.shipper/input/.gitkeep\r\n.shipper/output/result.json\r\n',
      stderr: '',
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await warnTrackedOutputFiles();

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      "⚠ .shipper/output/result.json is tracked by git but should be gitignored. Run 'shipper init' and commit the result to fix this.\n"
    );

    stderrSpy.mockRestore();
  });

  it('returns without writing when git ls-files fails', async () => {
    mockExecFileAsync.mockRejectedValue(new Error('git failed'));
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await warnTrackedOutputFiles();

    expect(stderrSpy).not.toHaveBeenCalled();

    stderrSpy.mockRestore();
  });
});

describe('runPrereqChecks', () => {
  it('logs the failing prerequisite message and returns false', async () => {
    const result = await runPrereqChecks([
      () => Promise.resolve({ ok: true, message: 'fine' }),
      () => Promise.resolve({ ok: false, message: 'gh is not installed' }),
    ]);

    expect(result).toBe(false);
    expect(stderrSpy).toHaveBeenCalledWith('[shipper] Prereq failed: gh is not installed');
  });

  it('returns true without logging when all prerequisites pass', async () => {
    const result = await runPrereqChecks([
      () => Promise.resolve({ ok: true, message: 'fine' }),
      () => Promise.resolve({ ok: true, message: 'also fine' }),
    ]);

    expect(result).toBe(true);
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

describe('runPreflight', () => {
  it('creates .shipper/tmp when all checks pass', async () => {
    mockAccess.mockResolvedValue();
    mockMkdir.mockResolvedValue(undefined);
    mockGh.mockImplementation((args: string[]) => {
      if (args[0] === 'label' && args[1] === 'list') {
        return Promise.resolve({
          stdout: [
            'shipper:new',
            'shipper:groomed',
            'shipper:designed',
            'shipper:planned',
            'shipper:implemented',
            'shipper:pr-open',
            'shipper:pr-reviewed',
            'shipper:ready',
          ].join('\n'),
          stderr: '',
        });
      }
      return Promise.reject(new Error(`Unexpected gh call: ${args.join(' ')}`));
    });

    await expect(runPreflight()).resolves.toBeUndefined();
    expect(mockGh).not.toHaveBeenCalledWith(['--version']);
    expect(mockGh).not.toHaveBeenCalledWith(['auth', 'status']);
    expect(mockMkdir).toHaveBeenCalledWith(path.resolve('.shipper', 'tmp'), {
      recursive: true,
    });
  });

  it('throws with the failing prerequisite when a single check fails', async () => {
    mockAccess.mockRejectedValue(new Error('ENOENT'));
    mockGh.mockImplementation((args: string[]) => {
      if (args[0] === 'label' && args[1] === 'list') {
        return Promise.resolve({
          stdout: [
            'shipper:new',
            'shipper:groomed',
            'shipper:designed',
            'shipper:planned',
            'shipper:implemented',
            'shipper:pr-open',
            'shipper:pr-reviewed',
            'shipper:ready',
          ].join('\n'),
          stderr: '',
        });
      }
      return Promise.reject(new Error(`Unexpected gh call: ${args.join(' ')}`));
    });

    await expect(runPreflight()).rejects.toThrow(
      '  ✗ .shipper directory not found. Run: shipper init\n\nRun `shipper init` to fix these issues.'
    );
  });

  it('aggregates multiple failures into a single error message', async () => {
    mockAccess.mockRejectedValue(new Error('ENOENT'));
    mockGh.mockImplementation((args: string[]) => {
      if (args[0] === 'label' && args[1] === 'list') {
        return Promise.reject(new Error('gh label list failed'));
      }
      return Promise.reject(new Error(`Unexpected gh call: ${args.join(' ')}`));
    });

    await expect(runPreflight()).rejects.toThrow(
      '  ✗ .shipper directory not found. Run: shipper init\n' +
        '  ✗ Could not check labels (gh label list failed)\n\n' +
        'Run `shipper init` to fix these issues.'
    );
  });
});
