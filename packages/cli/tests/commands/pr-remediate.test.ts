import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getSettingsMock = vi.fn();
const fetchChecksMock = vi.fn();
const classifyChecksMock = vi.fn();
const resolveRefMock = vi.fn();
const autoSelectPrForStageMock = vi.fn();
const formatConflictContextMock = vi.fn(() => 'formatted conflict context');
const runPromptMock = vi.fn();
const syncWorktreeMock = vi.fn(async () => {});
const pushWorktreeMock = vi.fn(async () => {});
const withStageHooksMock = vi.fn(
  async (_stage: unknown, _env: unknown, fn: () => Promise<unknown>) => await fn()
);
const withIssueLockMock = vi.fn(
  async (_repo: unknown, _issue: unknown, fn: () => Promise<unknown>) => await fn()
);
const withWorktreeMock = vi.fn(
  async (_opts: unknown, fn: (wtPath: string) => Promise<unknown>) => await fn('/tmp/fake-wt')
);
const getBranchForPRMock = vi.fn(async () => 'shipper/10-feature');
const getRepoRootMock = vi.fn(async () => '/tmp/fake-repo');
const ghMock = vi.fn();
const sleepMsMock = vi.fn(async () => {});
const setupProtocolDirsMock = vi.fn(async () => {});
const writeContextFileMock = vi.fn(async () => {});
const scrubOutputDirMock = vi.fn(async () => {});
const readResultFileMock = vi.fn();
const postRepliesMock = vi.fn(async () => {});
const postCommentMock = vi.fn(async () => {});
const executeTransitionMock = vi.fn(async () => {});
const handleAgentCrashMock = vi.fn(async () => {});
const resolveTransitionMock = vi.fn(() => ({
  add: ['shipper:ready'],
  remove: ['shipper:pr-reviewed'],
}));

const repo = 'owner/repo';
const PASS_CHECKS = [{ name: 'build', state: 'COMPLETED', bucket: 'pass' }];
const FAIL_CHECKS = [{ name: 'build', state: 'COMPLETED', bucket: 'fail' }];

vi.mock('@dnsquared/shipper-core', () => ({
  resolveRef: resolveRefMock,
  autoSelectPrForStage: autoSelectPrForStageMock,
  formatConflictContext: formatConflictContextMock,
  runPrompt: runPromptMock,
  syncWorktree: syncWorktreeMock,
  pushWorktree: pushWorktreeMock,
  withStageHooks: withStageHooksMock,
  withIssueLock: withIssueLockMock,
  withWorktree: withWorktreeMock,
  getBranchForPR: getBranchForPRMock,
  getRepoRoot: getRepoRootMock,
  gh: ghMock,
  sleepMs: sleepMsMock,
  getSettings: () => getSettingsMock(),
  fetchChecks: (...args: unknown[]) => fetchChecksMock(...args),
  classifyChecks: (...args: unknown[]) => classifyChecksMock(...args),
  setupProtocolDirs: setupProtocolDirsMock,
  writeContextFile: writeContextFileMock,
  scrubOutputDir: scrubOutputDirMock,
  readResultFile: readResultFileMock,
  postReplies: postRepliesMock,
  postComment: postCommentMock,
  executeTransition: executeTransitionMock,
  handleAgentCrash: handleAgentCrashMock,
  resolveTransition: resolveTransitionMock,
  FAILED_LABEL: 'shipper:failed',
  PR_REVIEWED_LABEL: 'shipper:pr-reviewed',
  PROTOCOL_OUTPUT_DIR: '.shipper/output',
}));

function classifyChecksImpl(checks: Array<{ bucket: string }>) {
  return {
    pending: checks.filter((check) => check.bucket === 'pending'),
    failed: checks.filter((check) => check.bucket === 'fail' || check.bucket === 'cancel'),
    passed: checks.filter((check) => check.bucket === 'pass'),
    total: checks.length,
  };
}

describe('prRemediateCommand', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  const originalSkipPrRemediateWait = process.env.SHIPPER_SKIP_PR_REMEDIATE_WAIT;

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    delete process.env.SHIPPER_SKIP_PR_REMEDIATE_WAIT;
    resolveRefMock.mockResolvedValue({ prNumber: '42', issueNumber: '10' });
    runPromptMock.mockResolvedValue(0);
    syncWorktreeMock.mockResolvedValue(undefined);
    pushWorktreeMock.mockResolvedValue(undefined);
    setupProtocolDirsMock.mockResolvedValue(undefined);
    writeContextFileMock.mockResolvedValue(undefined);
    scrubOutputDirMock.mockResolvedValue(undefined);
    postRepliesMock.mockResolvedValue(undefined);
    postCommentMock.mockResolvedValue(undefined);
    executeTransitionMock.mockResolvedValue(undefined);
    handleAgentCrashMock.mockResolvedValue(undefined);
    resolveTransitionMock.mockReturnValue({
      add: ['shipper:ready'],
      remove: ['shipper:pr-reviewed'],
    });
    classifyChecksMock.mockImplementation(classifyChecksImpl);
    ghMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('baseRefName')) {
        return {
          stdout: JSON.stringify({ baseRefName: 'release/2026' }),
          stderr: '',
        };
      }

      if (args[0] === 'pr' && args[1] === 'view' && args.includes('createdAt')) {
        return {
          stdout: JSON.stringify({ createdAt: new Date().toISOString() }),
          stderr: '',
        };
      }

      if (args[0] === 'pr' && args[1] === 'diff') {
        return { stdout: 'diff --git a/file b/file\n', stderr: '' };
      }

      if (args[0] === 'api' && args[1] === 'graphql') {
        return { stdout: '[]', stderr: '' };
      }

      return { stdout: '', stderr: '' };
    });
    getSettingsMock.mockReturnValue({
      prReviewWait: { mode: 'timer', timeoutMinutes: 0 },
    });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    });
  });

  afterEach(() => {
    process.exitCode = undefined;
    if (originalSkipPrRemediateWait === undefined) {
      delete process.env.SHIPPER_SKIP_PR_REMEDIATE_WAIT;
    } else {
      process.env.SHIPPER_SKIP_PR_REMEDIATE_WAIT = originalSkipPrRemediateWait;
    }
    vi.useRealTimers();
    exitSpy.mockRestore();
  });

  it('reports timer readiness only after the deadline passes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-12T10:00:00Z'));
    ghMock.mockResolvedValue({
      stdout: JSON.stringify({ createdAt: '2026-03-12T09:50:00Z' }),
      stderr: '',
    });

    const { buildReadyCheck } = await import('../../src/commands/pr-remediate.js');
    const readyCheck = await buildReadyCheck(repo, '42', {
      mode: 'timer',
      timeoutMinutes: 15,
    });

    await expect(readyCheck()).resolves.toBe(false);

    vi.setSystemTime(new Date('2026-03-12T10:05:01Z'));
    await expect(readyCheck()).resolves.toBe(true);
  });

  it('reports checks readiness as false while checks are pending', async () => {
    fetchChecksMock
      .mockResolvedValueOnce([{ name: 'build', state: 'IN_PROGRESS', bucket: 'pending' }])
      .mockResolvedValueOnce([{ name: 'build', state: 'IN_PROGRESS', bucket: 'pending' }]);

    const { buildReadyCheck } = await import('../../src/commands/pr-remediate.js');
    const readyCheck = await buildReadyCheck(repo, '42', {
      mode: 'checks',
      timeoutMinutes: 15,
    });

    await expect(readyCheck()).resolves.toBe(false);
  });

  it('reports checks readiness once pending checks clear', async () => {
    fetchChecksMock
      .mockResolvedValueOnce([{ name: 'build', state: 'IN_PROGRESS', bucket: 'pending' }])
      .mockResolvedValueOnce([{ name: 'build', state: 'COMPLETED', bucket: 'pass' }]);

    const { buildReadyCheck } = await import('../../src/commands/pr-remediate.js');
    const readyCheck = await buildReadyCheck(repo, '42', {
      mode: 'checks',
      timeoutMinutes: 15,
    });

    await expect(readyCheck()).resolves.toBe(true);
  });

  it('keeps the zero-check grace window before reporting ready', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-12T10:00:00Z'));
    fetchChecksMock.mockResolvedValue([]);

    const { buildReadyCheck } = await import('../../src/commands/pr-remediate.js');
    const readyCheck = await buildReadyCheck(repo, '42', {
      mode: 'checks',
      timeoutMinutes: 15,
    });

    await expect(readyCheck()).resolves.toBe(false);

    vi.setSystemTime(new Date('2026-03-12T10:00:20Z'));
    await expect(readyCheck()).resolves.toBe(false);

    vi.setSystemTime(new Date('2026-03-12T10:00:31Z'));
    await expect(readyCheck()).resolves.toBe(true);
  });

  it('accepts on the first pass, posts artifacts in order, and transitions to ready on green CI', async () => {
    const events: string[] = [];
    fetchChecksMock.mockImplementation(async () => {
      events.push('fetchChecks');
      return PASS_CHECKS;
    });
    readResultFileMock.mockResolvedValue({
      verdict: 'accept',
      comment: '.shipper/output/comment-10.md',
      replies: '.shipper/output/replies',
    });
    pushWorktreeMock.mockImplementation(async () => {
      events.push('pushWorktree');
    });
    postRepliesMock.mockImplementation(async () => {
      events.push('postReplies');
    });
    postCommentMock.mockImplementation(async () => {
      events.push('postComment');
    });
    executeTransitionMock.mockImplementation(async () => {
      events.push('executeTransition');
    });

    const { prRemediateCommand } = await import('../../src/commands/pr-remediate.js');

    await expect(prRemediateCommand(repo, '42')).resolves.toBeUndefined();

    expect(process.exitCode).toBe(0);
    expect(runPromptMock).toHaveBeenCalledWith(
      'pr_remediate',
      expect.objectContaining({
        repo,
        issueRef: '10',
        prRef: '42',
        cwd: '/tmp/fake-wt',
      })
    );
    expect(syncWorktreeMock).toHaveBeenCalledTimes(1);
    expect(setupProtocolDirsMock).toHaveBeenCalledWith('/tmp/fake-wt');
    expect(writeContextFileMock.mock.calls).toEqual([
      ['/tmp/fake-wt', 'review-threads.json', '[]'],
      ['/tmp/fake-wt', 'ci-status.json', JSON.stringify(classifyChecksImpl(PASS_CHECKS), null, 2)],
      ['/tmp/fake-wt', 'pr-diff.patch', 'diff --git a/file b/file\n'],
      ['/tmp/fake-wt', 'pass-info.json', JSON.stringify({ pass: 1, maxPasses: 5 }, null, 2)],
    ]);
    expect(writeContextFileMock.mock.invocationCallOrder[3]).toBeLessThan(
      syncWorktreeMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    expect(readResultFileMock).toHaveBeenCalledWith('/tmp/fake-wt/.shipper/output');
    expect(events).toEqual([
      'fetchChecks',
      'pushWorktree',
      'postReplies',
      'postComment',
      'fetchChecks',
      'fetchChecks',
      'fetchChecks',
      'executeTransition',
    ]);
    expect(postCommentMock).toHaveBeenCalledWith(
      'owner/repo',
      '10',
      '/tmp/fake-wt/.shipper/output/comment-10.md'
    );
    expect(postRepliesMock).toHaveBeenCalledWith(
      'owner/repo',
      '42',
      '/tmp/fake-wt',
      '.shipper/output/replies'
    );
    expect(resolveTransitionMock).toHaveBeenCalledWith('pr_remediate', 'accept');
    expect(executeTransitionMock).toHaveBeenCalledWith('owner/repo', '10', {
      add: ['shipper:ready'],
      remove: ['shipper:pr-reviewed'],
    });
  });

  it('retries after red CI, refreshes preflight context, and succeeds on a later green pass', async () => {
    let fetchCall = 0;
    fetchChecksMock.mockImplementation(async () => {
      fetchCall += 1;
      return fetchCall <= 4 ? FAIL_CHECKS : PASS_CHECKS;
    });
    readResultFileMock
      .mockResolvedValueOnce({
        verdict: 'accept',
        comment: '.shipper/output/comment-10.md',
      })
      .mockResolvedValueOnce({
        verdict: 'accept',
        comment: '.shipper/output/comment-10.md',
      });

    const { prRemediateCommand } = await import('../../src/commands/pr-remediate.js');

    await expect(prRemediateCommand(repo, '42')).resolves.toBeUndefined();

    expect(syncWorktreeMock).toHaveBeenCalledTimes(2);
    expect(scrubOutputDirMock).toHaveBeenCalledTimes(2);
    expect(runPromptMock).toHaveBeenCalledTimes(2);
    expect(pushWorktreeMock).toHaveBeenCalledTimes(2);
    expect(postCommentMock).toHaveBeenCalledTimes(2);
    expect(postRepliesMock).toHaveBeenCalledTimes(2);
    expect(writeContextFileMock.mock.calls).toEqual([
      ['/tmp/fake-wt', 'review-threads.json', '[]'],
      ['/tmp/fake-wt', 'ci-status.json', JSON.stringify(classifyChecksImpl(FAIL_CHECKS), null, 2)],
      ['/tmp/fake-wt', 'pr-diff.patch', 'diff --git a/file b/file\n'],
      ['/tmp/fake-wt', 'pass-info.json', JSON.stringify({ pass: 1, maxPasses: 5 }, null, 2)],
      ['/tmp/fake-wt', 'review-threads.json', '[]'],
      ['/tmp/fake-wt', 'ci-status.json', JSON.stringify(classifyChecksImpl(PASS_CHECKS), null, 2)],
      ['/tmp/fake-wt', 'pr-diff.patch', 'diff --git a/file b/file\n'],
      ['/tmp/fake-wt', 'pass-info.json', JSON.stringify({ pass: 2, maxPasses: 5 }, null, 2)],
    ]);
    expect(executeTransitionMock).toHaveBeenCalledTimes(1);
    expect(executeTransitionMock).toHaveBeenCalledWith('owner/repo', '10', {
      add: ['shipper:ready'],
      remove: ['shipper:pr-reviewed'],
    });
  });

  it('posts the reject comment, marks the issue failed, and never pushes', async () => {
    fetchChecksMock.mockResolvedValue(PASS_CHECKS);
    readResultFileMock.mockResolvedValue({
      verdict: 'reject',
      comment: '.shipper/output/comment-10.md',
    });

    const { prRemediateCommand } = await import('../../src/commands/pr-remediate.js');

    await expect(prRemediateCommand(repo, '42')).resolves.toBeUndefined();

    expect(pushWorktreeMock).not.toHaveBeenCalled();
    expect(postRepliesMock).not.toHaveBeenCalled();
    expect(postCommentMock).toHaveBeenCalledWith(
      'owner/repo',
      '10',
      '/tmp/fake-wt/.shipper/output/comment-10.md'
    );
    expect(executeTransitionMock).toHaveBeenCalledWith('owner/repo', '10', {
      add: ['shipper:failed'],
      remove: ['shipper:pr-reviewed'],
    });
    expect(resolveTransitionMock).not.toHaveBeenCalled();
  });

  it('exits after five red-CI passes without changing labels', async () => {
    fetchChecksMock.mockResolvedValue(FAIL_CHECKS);
    readResultFileMock.mockResolvedValue({
      verdict: 'accept',
      comment: '.shipper/output/comment-10.md',
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { prRemediateCommand } = await import('../../src/commands/pr-remediate.js');

    await expect(prRemediateCommand(repo, '42')).resolves.toBeUndefined();

    expect(syncWorktreeMock).toHaveBeenCalledTimes(5);
    expect(pushWorktreeMock).toHaveBeenCalledTimes(5);
    expect(postCommentMock).toHaveBeenCalledTimes(5);
    expect(executeTransitionMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith('Remediation exhausted 5 passes without green CI.');

    errorSpy.mockRestore();
  });

  it('handles invalid or missing result files as agent crashes', async () => {
    fetchChecksMock.mockResolvedValue(PASS_CHECKS);
    readResultFileMock.mockRejectedValue(
      new Error('Missing result.json at /tmp/fake-wt/.shipper/output/result.json')
    );

    const { prRemediateCommand } = await import('../../src/commands/pr-remediate.js');

    await expect(prRemediateCommand(repo, '42')).resolves.toBeUndefined();

    expect(handleAgentCrashMock).toHaveBeenCalledWith(
      'owner/repo',
      '10',
      'pr_remediate',
      'Missing result.json at /tmp/fake-wt/.shipper/output/result.json'
    );
    expect(process.exitCode).toBe(1);
    expect(pushWorktreeMock).not.toHaveBeenCalled();
    expect(executeTransitionMock).not.toHaveBeenCalled();
  });

  it('handles sync failures as agent crashes', async () => {
    fetchChecksMock.mockResolvedValue(PASS_CHECKS);
    syncWorktreeMock.mockRejectedValue(new Error('rebase failed'));

    const { prRemediateCommand } = await import('../../src/commands/pr-remediate.js');

    await expect(prRemediateCommand(repo, '42')).resolves.toBeUndefined();

    expect(handleAgentCrashMock).toHaveBeenCalledWith(
      'owner/repo',
      '10',
      'pr_remediate',
      'rebase failed'
    );
    expect(process.exitCode).toBe(1);
    expect(runPromptMock).not.toHaveBeenCalled();
    expect(pushWorktreeMock).not.toHaveBeenCalled();
  });

  it('does not transition to ready when no checks have appeared yet', async () => {
    fetchChecksMock.mockResolvedValue([]);
    readResultFileMock.mockResolvedValue({
      verdict: 'accept',
      comment: '.shipper/output/comment-10.md',
    });

    const { prRemediateCommand } = await import('../../src/commands/pr-remediate.js');

    await expect(prRemediateCommand(repo, '42')).resolves.toBeUndefined();

    expect(syncWorktreeMock).toHaveBeenCalledTimes(5);
    expect(pushWorktreeMock).toHaveBeenCalledTimes(5);
    expect(executeTransitionMock).not.toHaveBeenCalled();
  });
});
