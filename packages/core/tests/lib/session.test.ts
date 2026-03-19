import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const mockHomeDir = vi.hoisted(() => ({ value: '/home/user' }));

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
  return { ...actual, homedir: () => mockHomeDir.value };
});

const {
  aggregateSessionUsage,
  getSessionDir,
  getSessionPaths,
  resolveSessionRepo,
  writeSessionMeta,
} = await import('../../src/lib/session.js');

afterEach(() => {
  mockHomeDir.value = '/home/user';
});

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
        usage: {
          inputTokens: 45,
          outputTokens: 12,
          cacheReadTokens: 8,
          cacheWriteTokens: 2,
        },
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
        usage: {
          inputTokens: 45,
          outputTokens: 12,
          cacheReadTokens: 8,
          cacheWriteTokens: 2,
        },
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('aggregateSessionUsage', () => {
  it('returns undefined when the session directory does not exist', async () => {
    mockHomeDir.value = mkdtempSync(path.join(tmpdir(), 'session-home-'));

    try {
      await expect(
        aggregateSessionUsage('owner/repo', '308', new Date('2026-03-15T00:00:00.000Z'))
      ).resolves.toBeUndefined();
    } finally {
      rmSync(mockHomeDir.value, { recursive: true, force: true });
    }
  });

  it('aggregates matching usage from multiple stage sidecars', async () => {
    const tempHome = mkdtempSync(path.join(tmpdir(), 'session-home-'));
    mockHomeDir.value = tempHome;
    const sessionDir = getSessionDir('owner-repo');
    const since = new Date('2026-03-15T00:00:00.000Z');

    try {
      writeSessionMetaSync(
        path.join(sessionDir, '308-implement.meta.json'),
        buildMeta({
          issue: '308',
          timestamp: '2026-03-15T01:00:00.000Z',
          usage: {
            inputTokens: 10,
            outputTokens: 3,
            cacheReadTokens: 4,
            cacheWriteTokens: 1,
          },
        })
      );
      writeSessionMetaSync(
        path.join(sessionDir, '308-pr-open.meta.json'),
        buildMeta({
          issue: '308',
          timestamp: '2026-03-15T02:00:00.000Z',
          usage: {
            inputTokens: 8,
            outputTokens: 5,
            cacheReadTokens: 2,
            cacheWriteTokens: 0,
          },
        })
      );

      await expect(aggregateSessionUsage('owner/repo', '308', since)).resolves.toEqual({
        inputTokens: 18,
        outputTokens: 8,
        cacheReadTokens: 6,
        cacheWriteTokens: 1,
      });
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('filters by issue number and lower-bound timestamp', async () => {
    const tempHome = mkdtempSync(path.join(tmpdir(), 'session-home-'));
    mockHomeDir.value = tempHome;
    const sessionDir = getSessionDir('owner-repo');

    try {
      writeSessionMetaSync(
        path.join(sessionDir, '307-implement.meta.json'),
        buildMeta({
          issue: '307',
          timestamp: '2026-03-15T02:00:00.000Z',
          usage: {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 25,
            cacheWriteTokens: 10,
          },
        })
      );
      writeSessionMetaSync(
        path.join(sessionDir, '308-old.meta.json'),
        buildMeta({
          issue: '308',
          timestamp: '2026-03-14T23:59:59.000Z',
          usage: {
            inputTokens: 40,
            outputTokens: 10,
            cacheReadTokens: 5,
            cacheWriteTokens: 2,
          },
        })
      );
      writeSessionMetaSync(
        path.join(sessionDir, '308-current.meta.json'),
        buildMeta({
          issue: '308',
          timestamp: '2026-03-15T03:00:00.000Z',
          usage: {
            inputTokens: 4,
            outputTokens: 2,
            cacheReadTokens: 1,
            cacheWriteTokens: 0,
          },
        })
      );

      await expect(
        aggregateSessionUsage('owner/repo', '308', new Date('2026-03-15T00:00:00.000Z'))
      ).resolves.toEqual({
        inputTokens: 4,
        outputTokens: 2,
        cacheReadTokens: 1,
        cacheWriteTokens: 0,
      });
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('skips older sidecars without usage and malformed or unreadable metadata', async () => {
    const tempHome = mkdtempSync(path.join(tmpdir(), 'session-home-'));
    mockHomeDir.value = tempHome;
    const sessionDir = getSessionDir('owner-repo');

    try {
      writeSessionMetaSync(
        path.join(sessionDir, '308-without-usage.meta.json'),
        buildMeta({
          issue: '308',
          timestamp: '2026-03-15T01:00:00.000Z',
          usage: undefined,
        })
      );
      writeSessionMetaSync(
        path.join(sessionDir, '308-valid.meta.json'),
        buildMeta({
          issue: '308',
          timestamp: '2026-03-15T02:00:00.000Z',
          usage: {
            inputTokens: 7,
            outputTokens: 4,
            cacheReadTokens: 3,
            cacheWriteTokens: 1,
          },
        })
      );
      writeFileSync(path.join(sessionDir, '308-malformed.meta.json'), '{not valid json', 'utf-8');
      writeSessionMetaSync(path.join(sessionDir, '308-invalid-usage.meta.json'), {
        ...buildMeta({
          issue: '308',
          timestamp: '2026-03-15T03:00:00.000Z',
          usage: {
            inputTokens: 9,
            outputTokens: 2,
            cacheReadTokens: 1,
            cacheWriteTokens: 0,
          },
        }),
        usage: {
          inputTokens: 'bad',
          outputTokens: 2,
          cacheReadTokens: 1,
          cacheWriteTokens: 0,
        },
      });
      mkdirSync(path.join(sessionDir, '308-unreadable.meta.json'), { recursive: true });

      await expect(
        aggregateSessionUsage('owner/repo', '308', new Date('2026-03-15T00:00:00.000Z'))
      ).resolves.toEqual({
        inputTokens: 7,
        outputTokens: 4,
        cacheReadTokens: 3,
        cacheWriteTokens: 1,
      });
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

function writeSessionMetaSync(metaFile: string, meta: Record<string, unknown>): void {
  mkdirSync(path.dirname(metaFile), { recursive: true });
  writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`, 'utf-8');
}

function buildMeta(overrides: {
  issue: string;
  timestamp: string;
  usage?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    repo: 'owner/repo',
    issue: overrides.issue,
    stage: 'implement',
    agent: 'claude',
    model: 'opus',
    timestamp: overrides.timestamp,
    exitCode: 0,
    ...(overrides.usage ? { usage: overrides.usage } : {}),
  };
}
