import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const execFileMock =
  vi.fn<
    (
      command: string,
      args: string[],
      options: Record<string, unknown>,
      callback: (error: Error | null, stdout: string, stderr: string) => void
    ) => void
  >();

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFile: (...args: unknown[]) => {
      execFileMock(...args);
    },
  };
});

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => '/home/user' };
});

const { getSessionDir, getSessionPaths, resolveSessionRepo, writeSessionMeta } =
  await import('../../src/lib/session.js');

describe('getSessionDir', () => {
  it('places sessions under ~/.shipper/sessions/<owner-repo>', () => {
    expect(getSessionDir('owner-repo')).toBe(
      path.join('/home/user', '.shipper', 'sessions', 'owner-repo')
    );
  });
});

describe('getSessionPaths', () => {
  it('generates paired jsonl and metadata files with a shared timestamp token', () => {
    const timestamp = new Date('2026-03-15T23:25:12.345Z');
    const result = getSessionPaths('owner-repo', '308', 'implement', timestamp);

    expect(result.logFile).toBe(
      path.join(
        '/home/user',
        '.shipper',
        'sessions',
        'owner-repo',
        '308-implement-2026-03-15T23-25-12-345Z.jsonl'
      )
    );
    expect(result.metaFile).toBe(
      path.join(
        '/home/user',
        '.shipper',
        'sessions',
        'owner-repo',
        '308-implement-2026-03-15T23-25-12-345Z.meta.json'
      )
    );
  });

  it('uses the unlinked fallback when no issue number is provided', () => {
    const timestamp = new Date('2026-03-15T23:25:12.345Z');
    const result = getSessionPaths('owner-repo', undefined, 'setup', timestamp);

    expect(result.logFile).toContain('/owner-repo/unlinked-setup-2026-03-15T23-25-12-345Z.jsonl');
    expect(result.metaFile).toContain(
      '/owner-repo/unlinked-setup-2026-03-15T23-25-12-345Z.meta.json'
    );
  });
});

describe('resolveSessionRepo', () => {
  afterEach(() => {
    execFileMock.mockReset();
  });

  it('uses the explicit repo when provided', async () => {
    await expect(resolveSessionRepo({ repo: 'owner/repo' })).resolves.toEqual({
      repo: 'owner/repo',
      repoSlug: 'owner-repo',
    });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('normalizes every slash when building an explicit repo slug', async () => {
    await expect(resolveSessionRepo({ repo: 'enterprise/team/repo' })).resolves.toEqual({
      repo: 'enterprise/team/repo',
      repoSlug: 'enterprise-team-repo',
    });
  });

  it('falls back to git remote resolution when repo is omitted', async () => {
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(null, 'git@github.com:owner/repo.git\n', '');
    });

    await expect(resolveSessionRepo({ cwd: '/repo' })).resolves.toEqual({
      repo: 'owner/repo',
      repoSlug: 'owner-repo',
    });
    expect(execFileMock).toHaveBeenCalledWith(
      'git',
      ['remote', 'get-url', 'origin'],
      { cwd: '/repo' },
      expect.any(Function)
    );
  });

  it('returns the unlinked sentinel when git resolution fails', async () => {
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(new Error('fatal: not a git repository'), '', '');
    });

    await expect(resolveSessionRepo({ cwd: '/tmp/no-repo' })).resolves.toEqual({
      repo: '_unlinked',
      repoSlug: '_unlinked',
    });
  });

  it('preserves non-Error git failures when resolving the remote URL', async () => {
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback('fatal: access denied' as unknown as Error, '', '');
    });

    await expect(resolveSessionRepo({ cwd: '/tmp/no-repo' })).resolves.toEqual({
      repo: '_unlinked',
      repoSlug: '_unlinked',
    });
  });
});

describe('writeSessionMeta', () => {
  it('creates parent directories and writes newline-terminated json', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'session-meta-'));

    try {
      const metaFile = path.join(tempDir, 'nested', '308-implement.meta.json');
      await writeSessionMeta(metaFile, {
        repo: 'owner/repo',
        issue: '308',
        stage: 'implement',
        agent: 'claude',
        model: 'opus',
        timestamp: '2026-03-15T23:25:12.345Z',
        exitCode: 0,
        logFile: '/tmp/308-implement.jsonl',
      });

      const contents = readFileSync(metaFile, 'utf-8');
      expect(contents.endsWith('\n')).toBe(true);
      expect(JSON.parse(contents)).toEqual({
        repo: 'owner/repo',
        issue: '308',
        stage: 'implement',
        agent: 'claude',
        model: 'opus',
        timestamp: '2026-03-15T23:25:12.345Z',
        exitCode: 0,
        logFile: '/tmp/308-implement.jsonl',
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
