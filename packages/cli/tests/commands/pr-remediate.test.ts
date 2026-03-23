import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CheckClassification,
  LabelTransition,
  PRChecksLine,
  ResultJson,
} from '@dnsquared/shipper-core';

const getSettingsMock =
  vi.fn<() => { prReviewWait: { mode: 'timer' | 'checks'; timeoutMinutes: number } }>();
const fetchChecksMock = vi.fn<(repo: string, pr: string) => Promise<PRChecksLine[]>>();
const classifyChecksMock = vi.fn<(checks: PRChecksLine[]) => CheckClassification>();
const enrichFailedChecksMock =
  vi.fn<(repo: string, failedChecks: PRChecksLine[]) => Promise<Map<string, string>>>();
const resolveRefMock = vi.fn();
const autoSelectPrForStageMock = vi.fn();
const formatConflictContextMock = vi.fn(() => 'formatted conflict context');
const runPromptMock = vi.fn();
const syncWorktreeMock = vi.fn(() => Promise.resolve());
const pushWorktreeMock = vi.fn(() => Promise.resolve());
const withStageHooksMock = vi.fn((_stage: unknown, _env: unknown, fn: () => Promise<unknown>) =>
  fn()
);
const withIssueLockMock = vi.fn((_repo: unknown, _issue: unknown, fn: () => Promise<unknown>) =>
  fn()
);
const withWorktreeMock = vi.fn((_opts: unknown, fn: (wtPath: string) => Promise<unknown>) =>
  fn('/tmp/fake-wt')
);
const getBranchForPRMock = vi.fn(() => Promise.resolve('shipper/10-feature'));
const getRepoRootMock = vi.fn(() => Promise.resolve('/tmp/fake-repo'));
const ghMock = vi.fn<(args: string[]) => Promise<{ stdout: string; stderr: string }>>();
const sleepMsMock = vi.fn(() => Promise.resolve());
const setupProtocolDirsMock = vi.fn(() => Promise.resolve());
const writeContextFileMock = vi.fn(() => Promise.resolve());
const scrubOutputDirMock = vi.fn(() => Promise.resolve());
const readResultFileMock = vi.fn<() => Promise<ResultJson>>();
const retryOnInvalidOutputMock = vi.fn<
  (opts: {
    cwd: string;
    stage: string;
    retry: (message: string) => Promise<number>;
  }) => Promise<ResultJson>
>(() => Promise.resolve({ verdict: 'accept', comment: '.shipper/output/comment-10.md' }));
const postRepliesMock = vi.fn(() => Promise.resolve());
const postCommentMock = vi.fn(() => Promise.resolve());
const executeTransitionMock = vi.fn(() => Promise.resolve());
const handleAgentCrashMock = vi.fn(() => Promise.resolve());
const resolveTransitionMock = vi.fn<() => LabelTransition>(() => ({
  add: ['shipper:ready'],
  remove: ['shipper:pr-reviewed'],
}));

const repo = 'owner/repo';
const PASS_CHECKS = [{ name: 'build', state: 'COMPLETED', bucket: 'pass' }];
const FAIL_CHECKS = [{ name: 'build', state: 'COMPLETED', bucket: 'fail' }];
type WriteContextFileCall = [string, string, string];

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
  getSettings: getSettingsMock,
  fetchChecks: fetchChecksMock,
  classifyChecks: classifyChecksMock,
  enrichFailedChecks: enrichFailedChecksMock,
  setupProtocolDirs: setupProtocolDirsMock,
  writeContextFile: writeContextFileMock,
  scrubOutputDir: scrubOutputDirMock,
  readResultFile: readResultFileMock,
  retryOnInvalidOutput: retryOnInvalidOutputMock,
  postReplies: postRepliesMock,
  postComment: postCommentMock,
  executeTransition: executeTransitionMock,
  handleAgentCrash: handleAgentCrashMock,
  resolveTransition: resolveTransitionMock,
  FAILED_LABEL: 'shipper:failed',
  PR_REVIEWED_LABEL: 'shipper:pr-reviewed',
  PROTOCOL_OUTPUT_DIR: '.shipper/output',
}));

function classifyChecksImpl(checks: PRChecksLine[]): CheckClassification {
  return {
    pending: checks.filter((check) => check.bucket === 'pending'),
    failed: checks.filter((check) => check.bucket === 'fail' || check.bucket === 'cancel'),
    passed: checks.filter((check) => check.bucket === 'pass'),
    total: checks.length,
  };
}

function getWriteContextFileCalls(): WriteContextFileCall[] {
  return writeContextFileMock.mock.calls as WriteContextFileCall[];
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
    retryOnInvalidOutputMock.mockResolvedValue({
      verdict: 'accept',
      comment: '.shipper/output/comment-10.md',
    });
    postRepliesMock.mockResolvedValue(undefined);
    postCommentMock.mockResolvedValue(undefined);
    executeTransitionMock.mockResolvedValue(undefined);
    handleAgentCrashMock.mockResolvedValue(undefined);
    resolveTransitionMock.mockReturnValue({
      add: ['shipper:ready'],
      remove: ['shipper:pr-reviewed'],
    });
    classifyChecksMock.mockImplementation(classifyChecksImpl);
    enrichFailedChecksMock.mockResolvedValue(new Map());
    ghMock.mockImplementation((args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('baseRefName')) {
        return Promise.resolve({
          stdout: JSON.stringify({ baseRefName: 'release/2026' }),
          stderr: '',
        });
      }

      if (args[0] === 'pr' && args[1] === 'view' && args.includes('createdAt')) {
        return Promise.resolve({
          stdout: JSON.stringify({ createdAt: new Date().toISOString() }),
          stderr: '',
        });
      }

      if (args[0] === 'pr' && args[1] === 'diff') {
        return Promise.resolve({ stdout: 'diff --git a/file b/file\n', stderr: '' });
      }

      if (args[0] === 'api' && args[1] === 'graphql') {
        return Promise.resolve({ stdout: '[]', stderr: '' });
      }

      return Promise.resolve({ stdout: '', stderr: '' });
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
    fetchChecksMock.mockImplementation(() => {
      events.push('fetchChecks');
      return Promise.resolve(PASS_CHECKS);
    });
    readResultFileMock.mockResolvedValue({
      verdict: 'accept',
      comment: '.shipper/output/comment-10.md',
      replies: '.shipper/output/replies',
    });
    pushWorktreeMock.mockImplementation(() => {
      events.push('pushWorktree');
      return Promise.resolve();
    });
    postRepliesMock.mockImplementation(() => {
      events.push('postReplies');
      return Promise.resolve();
    });
    postCommentMock.mockImplementation(() => {
      events.push('postComment');
      return Promise.resolve();
    });
    executeTransitionMock.mockImplementation(() => {
      events.push('executeTransition');
      return Promise.resolve();
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
    const retryCall = retryOnInvalidOutputMock.mock.calls[0]?.[0] as
      | { cwd: string; stage: string; retry: (message: string) => Promise<number> }
      | undefined;
    expect(retryCall?.cwd).toBe('/tmp/fake-wt');
    expect(retryCall?.stage).toBe('pr_remediate');
    expect(retryCall?.retry).toEqual(expect.any(Function));
    expect(runPromptMock.mock.invocationCallOrder[0]).toBeLessThan(
      retryOnInvalidOutputMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    expect(syncWorktreeMock).toHaveBeenCalledTimes(1);
    expect(setupProtocolDirsMock).toHaveBeenCalledWith('/tmp/fake-wt');
    expect(enrichFailedChecksMock).toHaveBeenCalledWith(repo, []);
    const writeCalls = getWriteContextFileCalls();
    expect(writeCalls).toEqual([
      ['/tmp/fake-wt', 'review-threads.json', '[]'],
      ['/tmp/fake-wt', 'ci-status.json', JSON.stringify(classifyChecksImpl(PASS_CHECKS), null, 2)],
      ['/tmp/fake-wt', 'pr-diff.patch', 'diff --git a/file b/file\n'],
      ['/tmp/fake-wt', 'pass-info.json', JSON.stringify({ pass: 1, maxPasses: 5 }, null, 2)],
    ]);
    expect(writeCalls.some(([, name]) => name.startsWith('ci-log-'))).toBe(false);
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
    fetchChecksMock.mockImplementation(() => {
      fetchCall += 1;
      return Promise.resolve(fetchCall <= 4 ? FAIL_CHECKS : PASS_CHECKS);
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
    expect(retryOnInvalidOutputMock).toHaveBeenCalledTimes(2);
    expect(pushWorktreeMock).toHaveBeenCalledTimes(2);
    expect(postCommentMock).toHaveBeenCalledTimes(2);
    expect(postRepliesMock).toHaveBeenCalledTimes(2);
    expect(enrichFailedChecksMock).toHaveBeenNthCalledWith(
      1,
      repo,
      classifyChecksImpl(FAIL_CHECKS).failed
    );
    expect(enrichFailedChecksMock).toHaveBeenNthCalledWith(2, repo, []);
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

  it('writes enriched ci-status.json and ci-log artifacts before diff and pass metadata', async () => {
    const checksWithFailure: PRChecksLine[] = [
      {
        name: 'Build / lint (ubuntu)',
        state: 'COMPLETED',
        bucket: 'fail',
      },
    ];
    const classified: CheckClassification = {
      pending: [],
      failed: [
        {
          name: 'Build / lint (ubuntu)',
          state: 'COMPLETED',
          bucket: 'fail',
        },
      ],
      passed: [],
      total: 1,
    };

    fetchChecksMock.mockResolvedValueOnce(checksWithFailure).mockResolvedValue(PASS_CHECKS);
    classifyChecksMock.mockReturnValueOnce(classified).mockImplementation(classifyChecksImpl);
    enrichFailedChecksMock.mockImplementation((_repo, failedChecks) => {
      const [firstFailedCheck] = failedChecks;
      if (!firstFailedCheck) {
        throw new Error('Expected a failed check to enrich.');
      }

      firstFailedCheck.link = 'https://github.com/owner/repo/actions/runs/123456789/job/444555666';
      firstFailedCheck.failedSteps = [
        {
          name: 'lint',
        },
      ];
      return Promise.resolve(new Map([['build-lint-ubuntu', 'full failed log']]));
    });
    readResultFileMock.mockResolvedValue({
      verdict: 'accept',
      comment: '.shipper/output/comment-10.md',
    });

    const { prRemediateCommand } = await import('../../src/commands/pr-remediate.js');

    await expect(prRemediateCommand(repo, '42')).resolves.toBeUndefined();

    expect(enrichFailedChecksMock).toHaveBeenCalledWith(repo, classified.failed);
    expect(writeContextFileMock).toHaveBeenCalledWith(
      '/tmp/fake-wt',
      'ci-status.json',
      JSON.stringify(classified, null, 2)
    );
    expect(writeContextFileMock).toHaveBeenCalledWith(
      '/tmp/fake-wt',
      'ci-log-build-lint-ubuntu.txt',
      'full failed log'
    );
    const writeCalls = getWriteContextFileCalls();
    const ciStatusCall = writeCalls.find(([, name]) => name === 'ci-status.json');
    const ciLogCall = writeCalls.find(([, name]) => name === 'ci-log-build-lint-ubuntu.txt');
    const diffCall = writeCalls.find(([, name]) => name === 'pr-diff.patch');
    const passInfoCall = writeCalls.find(([, name]) => name === 'pass-info.json');
    const ciLogCallIndex = writeCalls.findIndex(
      ([, name]) => name === 'ci-log-build-lint-ubuntu.txt'
    );
    const diffCallIndex = writeCalls.findIndex(([, name]) => name === 'pr-diff.patch');
    const passInfoCallIndex = writeCalls.findIndex(([, name]) => name === 'pass-info.json');

    expect(ciStatusCall).toBeDefined();
    expect(ciLogCall).toBeDefined();
    expect(diffCall).toBeDefined();
    expect(passInfoCall).toBeDefined();
    expect(ciLogCallIndex).toBeGreaterThanOrEqual(0);
    expect(diffCallIndex).toBeGreaterThanOrEqual(0);
    expect(passInfoCallIndex).toBeGreaterThanOrEqual(0);
    expect(writeContextFileMock.mock.invocationCallOrder[ciLogCallIndex] ?? -1).toBeLessThan(
      writeContextFileMock.mock.invocationCallOrder[diffCallIndex] ?? Number.POSITIVE_INFINITY
    );
    expect(writeContextFileMock.mock.invocationCallOrder[ciLogCallIndex] ?? -1).toBeLessThan(
      writeContextFileMock.mock.invocationCallOrder[passInfoCallIndex] ?? Number.POSITIVE_INFINITY
    );
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

  it('continues the pass when the initial prompt exits non-zero but readResultFile is valid', async () => {
    fetchChecksMock.mockResolvedValue(PASS_CHECKS);
    runPromptMock.mockResolvedValueOnce(17);
    readResultFileMock.mockResolvedValue({
      verdict: 'accept',
      comment: '.shipper/output/comment-10.md',
    });

    const { prRemediateCommand } = await import('../../src/commands/pr-remediate.js');

    await expect(prRemediateCommand(repo, '42')).resolves.toBeUndefined();

    expect(retryOnInvalidOutputMock).toHaveBeenCalledTimes(1);
    expect(handleAgentCrashMock).not.toHaveBeenCalled();
    expect(pushWorktreeMock).toHaveBeenCalledTimes(1);
    expect(postCommentMock).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(0);
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

  it('reuses the same output directory when retrying within a pass', async () => {
    fetchChecksMock.mockResolvedValue(PASS_CHECKS);
    readResultFileMock.mockResolvedValue({
      verdict: 'accept',
      comment: '.shipper/output/comment-10.md',
    });

    const { prRemediateCommand } = await import('../../src/commands/pr-remediate.js');

    await expect(prRemediateCommand(repo, '42')).resolves.toBeUndefined();

    const retryCall = retryOnInvalidOutputMock.mock.calls[0]?.[0] as
      | { cwd: string; stage: string; retry: (message: string) => Promise<number> }
      | undefined;
    expect(retryCall?.stage).toBe('pr_remediate');
    await expect(retryCall?.retry('Fix result')).resolves.toBe(0);

    expect(runPromptMock).toHaveBeenLastCalledWith('pr_remediate', {
      repo,
      issueRef: '10',
      prRef: '42',
      cwd: '/tmp/fake-wt',
      mode: undefined,
      agent: undefined,
      model: undefined,
      userInput: 'Fix result',
    });
    expect(scrubOutputDirMock).toHaveBeenCalledTimes(1);
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

  it('handles retryOnInvalidOutput failure as agent crash with stderr', async () => {
    fetchChecksMock.mockResolvedValue(PASS_CHECKS);
    retryOnInvalidOutputMock.mockRejectedValue(
      new Error('pr_remediate accept requires a pr_spec in result.json')
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { prRemediateCommand } = await import('../../src/commands/pr-remediate.js');

    await expect(prRemediateCommand(repo, '42')).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith('pr_remediate accept requires a pr_spec in result.json');
    expect(handleAgentCrashMock).toHaveBeenCalledWith(
      'owner/repo',
      '10',
      'pr_remediate',
      'pr_remediate accept requires a pr_spec in result.json'
    );
    expect(readResultFileMock).not.toHaveBeenCalled();
    expect(pushWorktreeMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);

    errorSpy.mockRestore();
  });

  it('posts prepared outputs before reporting a push failure crash and stops remediation', async () => {
    readResultFileMock.mockResolvedValue({
      verdict: 'accept',
      comment: '.shipper/output/comment-10.md',
      replies: '.shipper/output/replies',
    });
    pushWorktreeMock.mockRejectedValue(new Error('fatal: unable to access remote'));

    const { prRemediateCommand } = await import('../../src/commands/pr-remediate.js');

    await expect(prRemediateCommand(repo, '42')).resolves.toBeUndefined();

    expect(postRepliesMock).toHaveBeenCalledWith(
      'owner/repo',
      '42',
      '/tmp/fake-wt',
      '.shipper/output/replies'
    );
    expect(postCommentMock).toHaveBeenCalledWith(
      'owner/repo',
      '10',
      '/tmp/fake-wt/.shipper/output/comment-10.md'
    );
    expect(postRepliesMock.mock.invocationCallOrder[0]).toBeLessThan(
      handleAgentCrashMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    expect(postCommentMock.mock.invocationCallOrder[0]).toBeLessThan(
      handleAgentCrashMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    expect(handleAgentCrashMock).toHaveBeenCalledWith(
      'owner/repo',
      '10',
      'pr_remediate',
      'fatal: unable to access remote',
      'The `pr_remediate` agent run failed while pushing the remediation worktree after producing a valid `.shipper/output/result.json`.'
    );
    expect(process.exitCode).toBe(1);
    expect(resolveTransitionMock).not.toHaveBeenCalled();
    expect(executeTransitionMock).not.toHaveBeenCalled();
    expect(syncWorktreeMock).toHaveBeenCalledTimes(1);
    expect(pushWorktreeMock).toHaveBeenCalledTimes(1);
  });

  it('still reports a push failure crash when posting prepared outputs also fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    readResultFileMock.mockResolvedValue({
      verdict: 'accept',
      comment: '.shipper/output/comment-10.md',
      replies: '.shipper/output/replies',
    });
    pushWorktreeMock.mockRejectedValue(new Error('fatal: unable to access remote'));
    postRepliesMock.mockRejectedValue(new Error('reply post failed'));
    postCommentMock.mockRejectedValue(new Error('comment post failed'));

    const { prRemediateCommand } = await import('../../src/commands/pr-remediate.js');

    await expect(prRemediateCommand(repo, '42')).resolves.toBeUndefined();

    expect(postRepliesMock).toHaveBeenCalledTimes(1);
    expect(postCommentMock).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to post replies during push failure handling: reply post failed'
    );
    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to post comment during push failure handling: comment post failed'
    );
    expect(handleAgentCrashMock).toHaveBeenCalledWith(
      'owner/repo',
      '10',
      'pr_remediate',
      'fatal: unable to access remote',
      'The `pr_remediate` agent run failed while pushing the remediation worktree after producing a valid `.shipper/output/result.json`.'
    );
    expect(process.exitCode).toBe(1);
    expect(executeTransitionMock).not.toHaveBeenCalled();

    warnSpy.mockRestore();
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
