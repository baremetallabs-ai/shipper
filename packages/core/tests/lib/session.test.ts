import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => '/home/user' };
});

const { getSessionDir, getSessionPaths, writeSessionMeta } =
  await import('../../src/lib/session.js');

describe('session helpers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-15T14:00:01.234Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('builds repo-backed session directories under ~/.shipper/sessions', () => {
    expect(getSessionDir('owner/repo')).toBe(
      path.join('/home/user', '.shipper', 'sessions', 'owner-repo')
    );
  });

  it('falls back to the cwd basename when repo is absent', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/repos/local-checkout');

    expect(getSessionDir()).toBe(path.join('/home/user', '.shipper', 'sessions', 'local-checkout'));
  });

  it('uses one sanitized timestamp for both log and metadata paths', () => {
    const paths = getSessionPaths('owner/repo', undefined, 'plan');

    expect(paths.logFile).toBe(
      path.join(
        '/home/user',
        '.shipper',
        'sessions',
        'owner-repo',
        'unlinked-plan-2026-03-15T14-00-01-234Z.jsonl'
      )
    );
    expect(paths.metaFile).toBe(
      path.join(
        '/home/user',
        '.shipper',
        'sessions',
        'owner-repo',
        'unlinked-plan-2026-03-15T14-00-01-234Z.meta.json'
      )
    );
  });

  it('writes session metadata and creates parent directories', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'shipper-session-meta-'));
    const metaFile = path.join(tempDir, 'nested', 'session.meta.json');

    await writeSessionMeta(metaFile, {
      repo: 'owner/repo',
      issue: '308',
      stage: 'implement',
      agent: 'claude',
      model: 'sonnet',
      timestamp: '2026-03-15T14:00:01.234Z',
      exitCode: 0,
      logFile: '/tmp/session.jsonl',
    });

    await expect(readFile(metaFile, 'utf-8')).resolves.toBe(
      JSON.stringify(
        {
          repo: 'owner/repo',
          issue: '308',
          stage: 'implement',
          agent: 'claude',
          model: 'sonnet',
          timestamp: '2026-03-15T14:00:01.234Z',
          exitCode: 0,
          logFile: '/tmp/session.jsonl',
        },
        null,
        2
      )
    );

    await rm(tempDir, { recursive: true, force: true });
  });
});
