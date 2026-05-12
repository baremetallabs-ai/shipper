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
  aggregateAllIssueUsage,
  aggregateSessionUsage,
  findLatestSessionMeta,
  getSessionDir,
  getSessionPaths,
  persistNewResultForLatestSession,
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
    expect(result.resultFile).toBe(
      path.join(
        '/home/user',
        '.shipper',
        'sessions',
        'owner-repo',
        '308-implement-2026-03-15T23-25-12-345Z.result.json'
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
    expect(result.resultFile).toContain(
      '/owner-repo/unlinked-setup-2026-03-15T23-25-12-345Z.result.json'
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
        resultFile: '/tmp/308-implement.result.json',
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
        resultFile: '/tmp/308-implement.result.json',
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
  it('returns undefined without warning when the session directory does not exist', async () => {
    mockHomeDir.value = mkdtempSync(path.join(tmpdir(), 'session-home-'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await expect(
        aggregateSessionUsage('owner/repo', '308', new Date('2026-03-15T00:00:00.000Z'))
      ).resolves.toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      rmSync(mockHomeDir.value, { recursive: true, force: true });
    }
  });

  it('warns when reading the session directory fails for a non-ENOENT reason', async () => {
    const tempHome = mkdtempSync(path.join(tmpdir(), 'session-home-'));
    mockHomeDir.value = tempHome;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const sessionDir = getSessionDir('owner-repo');
      mkdirSync(path.dirname(sessionDir), { recursive: true });
      writeFileSync(sessionDir, 'not a directory', 'utf-8');

      await expect(
        aggregateSessionUsage('owner/repo', '308', new Date('2026-03-15T00:00:00.000Z'))
      ).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        '[shipper] Failed to read session directory for owner/repo/308'
      );
    } finally {
      warnSpy.mockRestore();
      rmSync(tempHome, { recursive: true, force: true });
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

describe('aggregateAllIssueUsage', () => {
  it('returns an empty map without warning when the session directory does not exist', async () => {
    mockHomeDir.value = mkdtempSync(path.join(tmpdir(), 'session-home-'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await expect(aggregateAllIssueUsage('owner/repo')).resolves.toEqual(new Map());
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      rmSync(mockHomeDir.value, { recursive: true, force: true });
    }
  });

  it('aggregates totals per issue across stages, reruns, and failed sessions', async () => {
    const tempHome = mkdtempSync(path.join(tmpdir(), 'session-home-'));
    mockHomeDir.value = tempHome;
    const sessionDir = getSessionDir('owner-repo');

    try {
      writeSessionMetaSync(
        path.join(sessionDir, '308-groomed.meta.json'),
        buildMeta({
          issue: '308',
          stage: 'groom',
          timestamp: '2026-03-15T01:00:00.000Z',
          usage: {
            inputTokens: 10,
            outputTokens: 4,
            cacheReadTokens: 3,
            cacheWriteTokens: 1,
          },
        })
      );
      writeSessionMetaSync(
        path.join(sessionDir, '308-implement-rerun.meta.json'),
        buildMeta({
          issue: '308',
          stage: 'implement',
          timestamp: '2026-03-15T02:00:00.000Z',
          exitCode: 1,
          usage: {
            inputTokens: 8,
            outputTokens: 6,
            cacheReadTokens: 2,
            cacheWriteTokens: 1,
          },
        })
      );
      writeSessionMetaSync(
        path.join(sessionDir, '309-plan.meta.json'),
        buildMeta({
          issue: '309',
          stage: 'plan',
          timestamp: '2026-03-15T03:00:00.000Z',
          usage: {
            inputTokens: 5,
            outputTokens: 2,
            cacheReadTokens: 1,
            cacheWriteTokens: 0,
          },
        })
      );
      writeSessionMetaSync(
        path.join(sessionDir, '308-pr-review.meta.json'),
        buildMeta({
          issue: '308',
          stage: 'pr-review',
          timestamp: '2026-03-15T04:00:00.000Z',
          usage: {
            inputTokens: 6,
            outputTokens: 3,
            cacheReadTokens: 5,
            cacheWriteTokens: 2,
          },
        })
      );

      await expect(aggregateAllIssueUsage('owner/repo')).resolves.toEqual(
        new Map([
          [
            '308',
            {
              inputTokens: 24,
              outputTokens: 13,
              cacheReadTokens: 10,
              cacheWriteTokens: 4,
            },
          ],
          [
            '309',
            {
              inputTokens: 5,
              outputTokens: 2,
              cacheReadTokens: 1,
              cacheWriteTokens: 0,
            },
          ],
        ])
      );
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('skips malformed and usage-less metadata when aggregating repo totals', async () => {
    const tempHome = mkdtempSync(path.join(tmpdir(), 'session-home-'));
    mockHomeDir.value = tempHome;
    const sessionDir = getSessionDir('owner-repo');

    try {
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
      writeSessionMetaSync(
        path.join(sessionDir, '308-without-usage.meta.json'),
        buildMeta({
          issue: '308',
          timestamp: '2026-03-15T01:00:00.000Z',
          usage: undefined,
        })
      );
      writeFileSync(path.join(sessionDir, '309-malformed.meta.json'), '{not valid json', 'utf-8');
      writeSessionMetaSync(path.join(sessionDir, '310-invalid-usage.meta.json'), {
        ...buildMeta({
          issue: '310',
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

      await expect(aggregateAllIssueUsage('owner/repo')).resolves.toEqual(
        new Map([
          [
            '308',
            {
              inputTokens: 7,
              outputTokens: 4,
              cacheReadTokens: 3,
              cacheWriteTokens: 1,
            },
          ],
        ])
      );
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe('findLatestSessionMeta', () => {
  it('returns undefined when the session directory does not exist', async () => {
    mockHomeDir.value = mkdtempSync(path.join(tmpdir(), 'session-home-'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await expect(
        findLatestSessionMeta({
          repoSlug: 'owner-repo',
          issue: '308',
          stage: 'implement',
          since: new Date('2026-03-15T00:00:00.000Z'),
        })
      ).resolves.toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      rmSync(mockHomeDir.value, { recursive: true, force: true });
    }
  });

  it('filters by issue, stage, and since, returning the newest valid match', async () => {
    const tempHome = mkdtempSync(path.join(tmpdir(), 'session-home-'));
    mockHomeDir.value = tempHome;
    const sessionDir = getSessionDir('owner-repo');

    try {
      writeSessionMetaSync(
        path.join(sessionDir, '307-implement-2026-03-15T03-00-00-000Z.meta.json'),
        buildMeta({
          issue: '307',
          stage: 'implement',
          timestamp: '2026-03-15T03:00:00.000Z',
        })
      );
      writeSessionMetaSync(
        path.join(sessionDir, '308-plan-2026-03-15T03-30-00-000Z.meta.json'),
        buildMeta({
          issue: '308',
          stage: 'plan',
          timestamp: '2026-03-15T03:30:00.000Z',
        })
      );
      writeSessionMetaSync(
        path.join(sessionDir, '308-implement-2026-03-14T23-59-59-000Z.meta.json'),
        buildMeta({
          issue: '308',
          stage: 'implement',
          timestamp: '2026-03-14T23:59:59.000Z',
        })
      );
      writeSessionMetaSync(
        path.join(sessionDir, '308-implement-2026-03-15T04-00-00-000Z.meta.json'),
        buildMeta({
          issue: '308',
          stage: 'implement',
          timestamp: '2026-03-15T04:00:00.000Z',
          logFile: '/tmp/current.jsonl',
        })
      );
      writeSessionMetaSync(
        path.join(sessionDir, '308-implement-2026-03-15T05-00-00-000Z.meta.json'),
        buildMeta({
          issue: '308',
          stage: 'implement',
          timestamp: '2026-03-15T05:00:00.000Z',
          logFile: '/tmp/latest.jsonl',
          resultFile: '/tmp/latest.result.json',
        })
      );

      await expect(
        findLatestSessionMeta({
          repoSlug: 'owner-repo',
          issue: '308',
          stage: 'implement',
          since: new Date('2026-03-15T00:00:00.000Z'),
        })
      ).resolves.toMatchObject({
        issue: '308',
        stage: 'implement',
        timestamp: '2026-03-15T05:00:00.000Z',
        logFile: '/tmp/latest.jsonl',
        resultFile: '/tmp/latest.result.json',
      });
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('filters by run id when supplied so concurrent sessions do not collide', async () => {
    const tempHome = mkdtempSync(path.join(tmpdir(), 'session-home-'));
    mockHomeDir.value = tempHome;
    const sessionDir = getSessionDir('owner-repo');

    try {
      writeSessionMetaSync(
        path.join(sessionDir, 'unlinked-new-2026-03-15T04-00-00-000Z.meta.json'),
        buildMeta({
          issue: 'unlinked',
          stage: 'new',
          timestamp: '2026-03-15T04:00:00.000Z',
          logFile: '/tmp/first.jsonl',
          resultFile: '/tmp/first.result.json',
          runId: 'run-a',
        })
      );
      writeSessionMetaSync(
        path.join(sessionDir, 'unlinked-new-2026-03-15T05-00-00-000Z.meta.json'),
        buildMeta({
          issue: 'unlinked',
          stage: 'new',
          timestamp: '2026-03-15T05:00:00.000Z',
          logFile: '/tmp/second.jsonl',
          resultFile: '/tmp/second.result.json',
          runId: 'run-b',
        })
      );

      await expect(
        findLatestSessionMeta({
          repoSlug: 'owner-repo',
          issue: 'unlinked',
          stage: 'new',
          since: new Date('2026-03-15T00:00:00.000Z'),
          runId: 'run-a',
        })
      ).resolves.toMatchObject({
        runId: 'run-a',
        logFile: '/tmp/first.jsonl',
        resultFile: '/tmp/first.result.json',
      });
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('ignores malformed sidecars and invalid timestamps', async () => {
    const tempHome = mkdtempSync(path.join(tmpdir(), 'session-home-'));
    mockHomeDir.value = tempHome;
    const sessionDir = getSessionDir('owner-repo');

    try {
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        path.join(sessionDir, '308-implement-2026-03-15T01-00-00-000Z.meta.json'),
        '{bad json',
        'utf-8'
      );
      writeSessionMetaSync(
        path.join(sessionDir, '308-implement-2026-03-15T02-00-00-000Z.meta.json'),
        {
          ...buildMeta({
            issue: '308',
            stage: 'implement',
            timestamp: '2026-03-15T02:00:00.000Z',
          }),
          timestamp: 'not-a-date',
        }
      );
      writeSessionMetaSync(
        path.join(sessionDir, '308-implement-2026-03-15T03-00-00-000Z.meta.json'),
        buildMeta({
          issue: '308',
          stage: 'implement',
          timestamp: '2026-03-15T03:00:00.000Z',
          logFile: '/tmp/valid.jsonl',
        })
      );

      await expect(
        findLatestSessionMeta({
          repoSlug: 'owner-repo',
          issue: '308',
          stage: 'implement',
          since: new Date('2026-03-15T00:00:00.000Z'),
        })
      ).resolves.toMatchObject({
        issue: '308',
        stage: 'implement',
        logFile: '/tmp/valid.jsonl',
      });
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe('persistNewResultForLatestSession', () => {
  const createdIssueResult = {
    created_issue: {
      number: 42,
      title: 'Add generated MCP reference pages',
      url: 'https://github.com/owner/repo/issues/42',
    },
  };

  it('finds the latest matching unlinked/new session and overwrites its result sidecar', async () => {
    const tempHome = mkdtempSync(path.join(tmpdir(), 'session-home-'));
    mockHomeDir.value = tempHome;
    const sessionDir = getSessionDir('owner-repo');
    const olderResult = path.join(sessionDir, 'unlinked-new-2026-03-15T04-00-00-000Z.result.json');
    const latestResult = path.join(sessionDir, 'unlinked-new-2026-03-15T05-00-00-000Z.result.json');

    try {
      writeSessionMetaSync(
        path.join(sessionDir, 'unlinked-new-2026-03-15T04-00-00-000Z.meta.json'),
        buildMeta({
          issue: 'unlinked',
          stage: 'new',
          timestamp: '2026-03-15T04:00:00.000Z',
          resultFile: olderResult,
          runId: 'run-a',
        })
      );
      writeSessionMetaSync(
        path.join(sessionDir, 'unlinked-new-2026-03-15T05-00-00-000Z.meta.json'),
        buildMeta({
          issue: 'unlinked',
          stage: 'new',
          timestamp: '2026-03-15T05:00:00.000Z',
          resultFile: latestResult,
          runId: 'run-a',
        })
      );
      writeFileSync(latestResult, '{"issue_draft":".shipper/output/issue-draft.json"}\n', 'utf-8');

      await expect(
        persistNewResultForLatestSession({
          repo: 'owner/repo',
          since: new Date('2026-03-15T00:00:00.000Z'),
          runId: 'run-a',
          result: createdIssueResult,
        })
      ).resolves.toBe(latestResult);

      expect(JSON.parse(readFileSync(latestResult, 'utf-8'))).toEqual(createdIssueResult);
      expect(() => readFileSync(olderResult, 'utf-8')).toThrow();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('filters by run id when persisting the final new result', async () => {
    const tempHome = mkdtempSync(path.join(tmpdir(), 'session-home-'));
    mockHomeDir.value = tempHome;
    const sessionDir = getSessionDir('owner-repo');
    const firstResult = path.join(sessionDir, 'unlinked-new-2026-03-15T04-00-00-000Z.result.json');
    const secondResult = path.join(sessionDir, 'unlinked-new-2026-03-15T05-00-00-000Z.result.json');

    try {
      writeSessionMetaSync(
        path.join(sessionDir, 'unlinked-new-2026-03-15T04-00-00-000Z.meta.json'),
        buildMeta({
          issue: 'unlinked',
          stage: 'new',
          timestamp: '2026-03-15T04:00:00.000Z',
          resultFile: firstResult,
          runId: 'run-a',
        })
      );
      writeSessionMetaSync(
        path.join(sessionDir, 'unlinked-new-2026-03-15T05-00-00-000Z.meta.json'),
        buildMeta({
          issue: 'unlinked',
          stage: 'new',
          timestamp: '2026-03-15T05:00:00.000Z',
          resultFile: secondResult,
          runId: 'run-b',
        })
      );

      await expect(
        persistNewResultForLatestSession({
          repo: 'owner/repo',
          since: new Date('2026-03-15T00:00:00.000Z'),
          runId: 'run-a',
          result: createdIssueResult,
        })
      ).resolves.toBe(firstResult);

      expect(JSON.parse(readFileSync(firstResult, 'utf-8'))).toEqual(createdIssueResult);
      expect(() => readFileSync(secondResult, 'utf-8')).toThrow();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('adds resultFile to metadata when the matched session lacks it', async () => {
    const tempHome = mkdtempSync(path.join(tmpdir(), 'session-home-'));
    mockHomeDir.value = tempHome;
    const sessionDir = getSessionDir('owner-repo');
    const metaFile = path.join(sessionDir, 'unlinked-new-2026-03-15T05-00-00-000Z.meta.json');
    const derivedResultFile = path.join(
      sessionDir,
      'unlinked-new-2026-03-15T05-00-00-000Z.result.json'
    );

    try {
      writeSessionMetaSync(
        metaFile,
        buildMeta({
          issue: 'unlinked',
          stage: 'new',
          timestamp: '2026-03-15T05:00:00.000Z',
          runId: 'run-a',
        })
      );

      await expect(
        persistNewResultForLatestSession({
          repo: 'owner/repo',
          since: new Date('2026-03-15T00:00:00.000Z'),
          runId: 'run-a',
          result: createdIssueResult,
        })
      ).resolves.toBe(derivedResultFile);

      expect(JSON.parse(readFileSync(derivedResultFile, 'utf-8'))).toEqual(createdIssueResult);
      expect(JSON.parse(readFileSync(metaFile, 'utf-8'))).toMatchObject({
        issue: 'unlinked',
        stage: 'new',
        resultFile: derivedResultFile,
      });
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('throws and does not write a sidecar when no matching metadata exists', async () => {
    const tempHome = mkdtempSync(path.join(tmpdir(), 'session-home-'));
    mockHomeDir.value = tempHome;

    try {
      await expect(
        persistNewResultForLatestSession({
          repo: 'owner/repo',
          since: new Date('2026-03-15T00:00:00.000Z'),
          runId: 'run-a',
          result: createdIssueResult,
        })
      ).rejects.toThrow('Could not find session metadata for owner/repo unlinked/new');

      expect(() => readFileSync(getSessionDir('owner-repo'), 'utf-8')).toThrow();
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
  stage?: string;
  exitCode?: number;
  logFile?: string;
  resultFile?: string;
  runId?: string;
  usage?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    repo: 'owner/repo',
    issue: overrides.issue,
    stage: overrides.stage ?? 'implement',
    agent: 'claude',
    model: 'opus',
    timestamp: overrides.timestamp,
    exitCode: overrides.exitCode ?? 0,
    ...(overrides.logFile ? { logFile: overrides.logFile } : {}),
    ...(overrides.resultFile ? { resultFile: overrides.resultFile } : {}),
    ...(overrides.runId ? { runId: overrides.runId } : {}),
    ...(overrides.usage ? { usage: overrides.usage } : {}),
  };
}
