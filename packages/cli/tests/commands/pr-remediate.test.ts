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
const truncateLargeInputMock = vi.fn((_: string, text: string, filename: string) =>
  Promise.resolve(`truncated:${filename}:${text}`)
);
const runPromptMock = vi.fn();
const getGitRevParseMock = vi.fn<(cwd: string, ref: string) => Promise<string>>();
const rerunFailedChecksMock =
  vi.fn<(repo: string, failedChecks: PRChecksLine[]) => Promise<void>>();
const syncWorktreeMock = vi.fn(() => Promise.resolve());
const pushWithRetryMock = vi.fn(() => Promise.resolve(0));
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
const validateStageOutputMock = vi.fn<(cwd: string, stage: string) => Promise<ResultJson>>();
const retryOnInvalidOutputMock = vi.fn<
  (opts: {
    cwd: string;
    stage: string;
    retry: (message: string) => Promise<number>;
  }) => Promise<ResultJson>
>(() => Promise.resolve({ verdict: 'accept', comment: '.shipper/output/comment-10.md' }));
const processResultMock = vi.fn<(opts: unknown) => Promise<ResultJson>>();
const postRepliesMock = vi.fn(() => Promise.resolve());
const postCommentMock = vi.fn(() => Promise.resolve());
const executeTransitionMock = vi.fn(() => Promise.resolve());
const handleAgentCrashMock = vi.fn(() => Promise.resolve());
const resolveTransitionMock = vi.fn<() => LabelTransition>(() => ({
  add: ['shipper:ready'],
  remove: ['shipper:pr-reviewed'],
}));

const repo = 'owner/repo';
const PENDING_CHECKS = [{ name: 'build', state: 'IN_PROGRESS', bucket: 'pending' }];
const PASS_CHECKS = [{ name: 'build', state: 'COMPLETED', bucket: 'pass' }];
const FAIL_CHECKS = [{ name: 'build', state: 'COMPLETED', bucket: 'fail' }];
type WriteContextFileCall = [string, string, string];

vi.mock('@dnsquared/shipper-core', () => ({
  resolveRef: resolveRefMock,
  autoSelectPrForStage: autoSelectPrForStageMock,
  formatConflictContext: formatConflictContextMock,
  truncateLargeInput: truncateLargeInputMock,
  runPrompt: runPromptMock,
  getGitRevParse: getGitRevParseMock,
  rerunFailedChecks: rerunFailedChecksMock,
  syncWorktree: syncWorktreeMock,
  pushWithRetry: pushWithRetryMock,
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
  validateStageOutput: validateStageOutputMock,
  retryOnInvalidOutput: retryOnInvalidOutputMock,
  processResult: processResultMock,
  postReplies: postRepliesMock,
  postComment: postCommentMock,
  executeTransition: executeTransitionMock,
  handleAgentCrash: handleAgentCrashMock,
  resolveTransition: resolveTransitionMock,
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
  let revParseCounter = 0;

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    delete process.env.SHIPPER_SKIP_PR_REMEDIATE_WAIT;
    resolveRefMock.mockResolvedValue({ prNumber: '42', issueNumber: '10' });
    runPromptMock.mockResolvedValue(0);
    syncWorktreeMock.mockResolvedValue(undefined);
    pushWithRetryMock.mockResolvedValue(0);
    setupProtocolDirsMock.mockResolvedValue(undefined);
    truncateLargeInputMock.mockClear();
    writeContextFileMock.mockResolvedValue(undefined);
    scrubOutputDirMock.mockResolvedValue(undefined);
    validateStageOutputMock.mockResolvedValue({
      verdict: 'accept',
      comment: '.shipper/output/comment-10.md',
    });
    retryOnInvalidOutputMock.mockResolvedValue({
      verdict: 'accept',
      comment: '.shipper/output/comment-10.md',
    });
    processResultMock.mockImplementation((opts) => {
      const result = (opts as { result: ResultJson }).result;
      return Promise.resolve(result);
    });
    postRepliesMock.mockResolvedValue(undefined);
    postCommentMock.mockResolvedValue(undefined);
    executeTransitionMock.mockResolvedValue(undefined);
    handleAgentCrashMock.mockResolvedValue(undefined);
    resolveTransitionMock.mockReturnValue({
      add: ['shipper:ready'],
      remove: ['shipper:pr-reviewed'],
    });
    revParseCounter = 0;
    getGitRevParseMock.mockImplementation(() => Promise.resolve(`sha-${++revParseCounter}`));
    rerunFailedChecksMock.mockResolvedValue(undefined);
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
    fetchChecksMock.mockResolvedValueOnce(PENDING_CHECKS).mockResolvedValueOnce(PENDING_CHECKS);

    const { buildReadyCheck } = await import('../../src/commands/pr-remediate.js');
    const readyCheck = await buildReadyCheck(repo, '42', {
      mode: 'checks',
      timeoutMinutes: 15,
    });

    await expect(readyCheck()).resolves.toBe(false);
  });

  it('reports checks readiness once pending checks clear', async () => {
    fetchChecksMock.mockResolvedValueOnce(PENDING_CHECKS).mockResolvedValueOnce(PASS_CHECKS);

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

  it('returns ready after three consecutive fetch failures in checks mode', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchChecksMock
      .mockResolvedValueOnce(PENDING_CHECKS)
      .mockRejectedValueOnce(new Error('network error'))
      .mockRejectedValueOnce(new Error('network error'))
      .mockRejectedValueOnce(new Error('network error'));

    const { buildReadyCheck } = await import('../../src/commands/pr-remediate.js');
    const readyCheck = await buildReadyCheck(repo, '42', {
      mode: 'checks',
      timeoutMinutes: 15,
    });

    await expect(readyCheck()).resolves.toBe(false);
    await expect(readyCheck()).resolves.toBe(false);
    await expect(readyCheck()).resolves.toBe(true);

    warnSpy.mockRestore();
  });

  it('resets the checks-mode failure counter after a successful fetch', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchChecksMock
      .mockResolvedValueOnce(PENDING_CHECKS)
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce(PENDING_CHECKS)
      .mockRejectedValueOnce(new Error('network error'))
      .mockRejectedValueOnce(new Error('network error'))
      .mockRejectedValueOnce(new Error('network error'));

    const { buildReadyCheck } = await import('../../src/commands/pr-remediate.js');
    const readyCheck = await buildReadyCheck(repo, '42', {
      mode: 'checks',
      timeoutMinutes: 15,
    });

    await expect(readyCheck()).resolves.toBe(false);
    await expect(readyCheck()).resolves.toBe(false);
    await expect(readyCheck()).resolves.toBe(false);
    await expect(readyCheck()).resolves.toBe(false);
    await expect(readyCheck()).resolves.toBe(true);

    warnSpy.mockRestore();
  });

  it('accepts on the first pass, posts artifacts in order, and transitions to ready on green CI', async () => {
    const events: string[] = [];
    fetchChecksMock.mockImplementation(() => {
      events.push('fetchChecks');
      return Promise.resolve(PASS_CHECKS);
    });
    retryOnInvalidOutputMock.mockResolvedValueOnce({
      verdict: 'accept',
      comment: '.shipper/output/comment-10.md',
      replies: '.shipper/output/replies',
    });
    validateStageOutputMock.mockResolvedValueOnce({
      verdict: 'accept',
      comment: '.shipper/output/comment-11.md',
      replies: '.shipper/output/replies-updated',
    });
    pushWithRetryMock.mockImplementation(() => {
      events.push('pushWithRetry');
      return Promise.resolve(0);
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
    expect(validateStageOutputMock).toHaveBeenCalledWith('/tmp/fake-wt', 'pr_remediate');
    expect(events).toEqual([
      'fetchChecks',
      'pushWithRetry',
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
      '/tmp/fake-wt/.shipper/output/comment-11.md'
    );
    expect(postRepliesMock).toHaveBeenCalledWith(
      'owner/repo',
      '42',
      '/tmp/fake-wt',
      '.shipper/output/replies-updated'
    );
    expect(rerunFailedChecksMock).not.toHaveBeenCalled();
    expect(resolveTransitionMock).toHaveBeenCalledWith('pr_remediate', 'accept');
    expect(executeTransitionMock).toHaveBeenCalledWith('owner/repo', '10', {
      add: ['shipper:ready'],
      remove: ['shipper:pr-reviewed'],
    });
  });

  it('bails out of preflight check polling after three consecutive fetch failures', async () => {
    getSettingsMock.mockReturnValue({
      prReviewWait: { mode: 'checks', timeoutMinutes: 15 },
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchChecksMock
      .mockResolvedValueOnce(PENDING_CHECKS)
      .mockRejectedValueOnce(new Error('network error'))
      .mockRejectedValueOnce(new Error('network error'))
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValue(PASS_CHECKS);

    const { prRemediateCommand } = await import('../../src/commands/pr-remediate.js');

    await expect(prRemediateCommand(repo, '42')).resolves.toBeUndefined();

    expect(logSpy).toHaveBeenCalledWith(
      'Check polling stopped: persistent fetch failures. Proceeding.'
    );
    expect(sleepMsMock).toHaveBeenCalledTimes(2);
    expect(sleepMsMock).toHaveBeenNthCalledWith(1, 20_000);
    expect(sleepMsMock).toHaveBeenNthCalledWith(2, 20_000);
    expect(process.exitCode).toBe(0);

    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('resets waitForChecks consecutive failures after a successful fetch', async () => {
    getSettingsMock.mockReturnValue({
      prReviewWait: { mode: 'checks', timeoutMinutes: 15 },
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchChecksMock
      .mockResolvedValueOnce(PENDING_CHECKS)
      .mockRejectedValueOnce(new Error('network error'))
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce(PENDING_CHECKS)
      .mockRejectedValueOnce(new Error('network error'))
      .mockRejectedValueOnce(new Error('network error'))
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValue(PASS_CHECKS);

    const { prRemediateCommand } = await import('../../src/commands/pr-remediate.js');

    await expect(prRemediateCommand(repo, '42')).resolves.toBeUndefined();

    expect(logSpy).toHaveBeenCalledWith(
      'Check polling stopped: persistent fetch failures. Proceeding.'
    );
    expect(sleepMsMock).toHaveBeenCalledTimes(5);
    expect(sleepMsMock).toHaveBeenNthCalledWith(1, 20_000);
    expect(sleepMsMock).toHaveBeenNthCalledWith(2, 20_000);
    expect(sleepMsMock).toHaveBeenNthCalledWith(3, 20_000);
    expect(sleepMsMock).toHaveBeenNthCalledWith(4, 20_000);
    expect(sleepMsMock).toHaveBeenNthCalledWith(5, 20_000);
    expect(process.exitCode).toBe(0);

    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('routes sync conflict context through truncateLargeInput', async () => {
    const { prRemediateCommand } = await import('../../src/commands/pr-remediate.js');

    await expect(prRemediateCommand(repo, '42')).resolves.toBeUndefined();

    const conflictCallback = syncWorktreeMock.mock.calls[0]?.[1] as
      | ((conflictContext: unknown) => Promise<number>)
      | undefined;
    expect(conflictCallback).toEqual(expect.any(Function));

    runPromptMock.mockClear();
    await expect(
      conflictCallback?.({
        files: ['src/conflict.ts'],
        conflicts: [
          {
            path: 'src/conflict.ts',
            markers: ['<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> origin/main'],
          },
        ],
      })
    ).resolves.toBe(0);

    expect(formatConflictContextMock).toHaveBeenCalledWith({
      files: ['src/conflict.ts'],
      conflicts: [
        {
          path: 'src/conflict.ts',
          markers: ['<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> origin/main'],
        },
      ],
    });
    expect(truncateLargeInputMock).toHaveBeenCalledWith(
      '/tmp/fake-wt',
      'formatted conflict context',
      'conflict-context.txt'
    );
    expect(runPromptMock).toHaveBeenCalledWith(
      'pr_remediate',
      expect.objectContaining({
        repo,
        issueRef: '10',
        prRef: '42',
        cwd: '/tmp/fake-wt',
        userInput: 'truncated:conflict-context.txt:formatted conflict context',
      })
    );
  });

  it('routes sync install errors through truncateLargeInput and leaves retry correction input unchanged', async () => {
    const { prRemediateCommand } = await import('../../src/commands/pr-remediate.js');

    await expect(prRemediateCommand(repo, '42')).resolves.toBeUndefined();

    const installCallback = syncWorktreeMock.mock.calls[0]?.[2] as
      | ((installError: string) => Promise<number>)
      | undefined;
    const retryCall = retryOnInvalidOutputMock.mock.calls[0]?.[0] as
      | { retry: (message: string) => Promise<number> }
      | undefined;
    expect(installCallback).toEqual(expect.any(Function));
    expect(retryCall?.retry).toEqual(expect.any(Function));

    runPromptMock.mockClear();
    await expect(installCallback?.('npm install exited with code 1')).resolves.toBe(0);

    expect(truncateLargeInputMock).toHaveBeenCalledWith(
      '/tmp/fake-wt',
      'npm install exited with code 1',
      'install-error.txt'
    );
    expect(runPromptMock).toHaveBeenCalledWith(
      'pr_remediate',
      expect.objectContaining({
        repo,
        issueRef: '10',
        prRef: '42',
        cwd: '/tmp/fake-wt',
        userInput: 'truncated:install-error.txt:npm install exited with code 1',
      })
    );

    runPromptMock.mockClear();
    const truncateCalls = truncateLargeInputMock.mock.calls.length;
    await expect(retryCall?.retry('Fix the response shape')).resolves.toBe(0);
    expect(truncateLargeInputMock.mock.calls.length).toBe(truncateCalls);
    expect(runPromptMock).toHaveBeenCalledWith(
      'pr_remediate',
      expect.objectContaining({
        repo,
        issueRef: '10',
        prRef: '42',
        cwd: '/tmp/fake-wt',
        userInput: 'Fix the response shape',
      })
    );
  });

  it('retries after red CI, refreshes preflight context, and succeeds on a later green pass', async () => {
    let fetchCall = 0;
    fetchChecksMock.mockImplementation(() => {
      fetchCall += 1;
      return Promise.resolve(fetchCall <= 4 ? FAIL_CHECKS : PASS_CHECKS);
    });
    validateStageOutputMock.mockResolvedValue({
      verdict: 'accept',
      comment: '.shipper/output/comment-10.md',
    });

    const { prRemediateCommand } = await import('../../src/commands/pr-remediate.js');

    await expect(prRemediateCommand(repo, '42')).resolves.toBeUndefined();

    expect(syncWorktreeMock).toHaveBeenCalledTimes(2);
    expect(scrubOutputDirMock).toHaveBeenCalledTimes(2);
    expect(runPromptMock).toHaveBeenCalledTimes(2);
    expect(retryOnInvalidOutputMock).toHaveBeenCalledTimes(2);
    expect(pushWithRetryMock).toHaveBeenCalledTimes(2);
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

  it('reruns failed CI checks before polling when no new commit was pushed and exits after a green rerun', async () => {
    getGitRevParseMock.mockResolvedValueOnce('same-sha').mockResolvedValueOnce('same-sha');
    fetchChecksMock
      .mockResolvedValueOnce(FAIL_CHECKS)
      .mockResolvedValueOnce(FAIL_CHECKS)
      .mockResolvedValueOnce(PASS_CHECKS)
      .mockResolvedValueOnce(PASS_CHECKS)
      .mockResolvedValueOnce(PASS_CHECKS);
    validateStageOutputMock.mockResolvedValue({
      verdict: 'accept',
      comment: '.shipper/output/comment-10.md',
    });

    const { prRemediateCommand } = await import('../../src/commands/pr-remediate.js');

    await expect(prRemediateCommand(repo, '42')).resolves.toBeUndefined();

    expect(rerunFailedChecksMock).toHaveBeenCalledTimes(1);
    expect(rerunFailedChecksMock).toHaveBeenCalledWith(
      repo,
      classifyChecksImpl(FAIL_CHECKS).failed
    );
    expect(sleepMsMock).toHaveBeenCalledWith(10_000);
    expect(rerunFailedChecksMock.mock.invocationCallOrder[0]).toBeLessThan(
      fetchChecksMock.mock.invocationCallOrder[2] ?? Number.POSITIVE_INFINITY
    );
    expect(syncWorktreeMock).toHaveBeenCalledTimes(1);
    expect(pushWithRetryMock).toHaveBeenCalledTimes(1);
    expect(executeTransitionMock).toHaveBeenCalledTimes(1);
  });

  it('skips rerunning failed CI checks when pushWithRetry advances the remote branch', async () => {
    fetchChecksMock.mockResolvedValue(PASS_CHECKS);
    validateStageOutputMock.mockResolvedValue({
      verdict: 'accept',
      comment: '.shipper/output/comment-10.md',
    });

    const { prRemediateCommand } = await import('../../src/commands/pr-remediate.js');

    await expect(prRemediateCommand(repo, '42')).resolves.toBeUndefined();

    expect(getGitRevParseMock).toHaveBeenCalledTimes(2);
    expect(rerunFailedChecksMock).not.toHaveBeenCalled();
    expect(sleepMsMock).not.toHaveBeenCalledWith(10_000);
    expect(syncWorktreeMock).toHaveBeenCalledTimes(1);
    expect(pushWithRetryMock).toHaveBeenCalledTimes(1);
  });

  it('counts a no-push rerun that stays red as a pass and starts the next remediation pass', async () => {
    getGitRevParseMock
      .mockResolvedValueOnce('same-sha')
      .mockResolvedValueOnce('same-sha')
      .mockResolvedValueOnce('before-pass-2')
      .mockResolvedValueOnce('after-pass-2');
    fetchChecksMock
      .mockResolvedValueOnce(FAIL_CHECKS)
      .mockResolvedValueOnce(FAIL_CHECKS)
      .mockResolvedValueOnce(FAIL_CHECKS)
      .mockResolvedValueOnce(FAIL_CHECKS)
      .mockResolvedValueOnce(FAIL_CHECKS)
      .mockResolvedValueOnce(PASS_CHECKS)
      .mockResolvedValueOnce(PASS_CHECKS)
      .mockResolvedValueOnce(PASS_CHECKS)
      .mockResolvedValueOnce(PASS_CHECKS);
    validateStageOutputMock.mockResolvedValue({
      verdict: 'accept',
      comment: '.shipper/output/comment-10.md',
    });

    const { prRemediateCommand } = await import('../../src/commands/pr-remediate.js');

    await expect(prRemediateCommand(repo, '42')).resolves.toBeUndefined();

    expect(rerunFailedChecksMock).toHaveBeenCalledTimes(1);
    expect(syncWorktreeMock).toHaveBeenCalledTimes(2);
    expect(pushWithRetryMock).toHaveBeenCalledTimes(2);
    expect(writeContextFileMock).toHaveBeenCalledWith(
      '/tmp/fake-wt',
      'pass-info.json',
      JSON.stringify({ pass: 2, maxPasses: 5 }, null, 2)
    );
    expect(executeTransitionMock).toHaveBeenCalledTimes(1);
  });

  it('skips no-push detection when origin branch is not yet available locally', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getGitRevParseMock
      .mockRejectedValueOnce(new Error('git rev-parse origin/shipper/10-feature failed'))
      .mockResolvedValueOnce('after-push-sha');
    fetchChecksMock.mockResolvedValue(PASS_CHECKS);
    validateStageOutputMock.mockResolvedValue({
      verdict: 'accept',
      comment: '.shipper/output/comment-10.md',
    });

    const { prRemediateCommand } = await import('../../src/commands/pr-remediate.js');

    await expect(prRemediateCommand(repo, '42')).resolves.toBeUndefined();

    expect(getGitRevParseMock).toHaveBeenCalledTimes(2);
    expect(rerunFailedChecksMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Warning: Failed to resolve git ref origin/shipper/10-feature:')
    );

    warnSpy.mockRestore();
  });

  it('continues to the next pass when fetching final CI state after waiting fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchChecksMock
      .mockResolvedValueOnce(PASS_CHECKS)
      .mockResolvedValueOnce(PASS_CHECKS)
      .mockResolvedValueOnce(PASS_CHECKS)
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce(PASS_CHECKS)
      .mockResolvedValueOnce(PASS_CHECKS)
      .mockResolvedValueOnce(PASS_CHECKS)
      .mockResolvedValueOnce(PASS_CHECKS);
    validateStageOutputMock.mockResolvedValue({
      verdict: 'accept',
      comment: '.shipper/output/comment-10.md',
    });

    const { prRemediateCommand } = await import('../../src/commands/pr-remediate.js');

    await expect(prRemediateCommand(repo, '42')).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      'Pass 1/5: Failed to fetch CI checks after waiting. Continuing to next pass.'
    );
    expect(syncWorktreeMock).toHaveBeenCalledTimes(2);
    expect(pushWithRetryMock).toHaveBeenCalledTimes(2);
    expect(postCommentMock).toHaveBeenCalledTimes(2);
    expect(executeTransitionMock).toHaveBeenCalledTimes(1);

    errorSpy.mockRestore();
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
    validateStageOutputMock.mockResolvedValue({
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

  it.each(['reject', 'fail'] as const)(
    'delegates %s verdicts to processResult and never pushes',
    async (verdict) => {
      fetchChecksMock.mockResolvedValue(PASS_CHECKS);
      const result: ResultJson = {
        verdict,
        comment: '.shipper/output/comment-10.md',
      };
      retryOnInvalidOutputMock.mockResolvedValue(result);

      const { prRemediateCommand } = await import('../../src/commands/pr-remediate.js');

      await expect(prRemediateCommand(repo, '42')).resolves.toBeUndefined();

      expect(pushWithRetryMock).not.toHaveBeenCalled();
      expect(postRepliesMock).not.toHaveBeenCalled();
      expect(postCommentMock).not.toHaveBeenCalled();
      expect(executeTransitionMock).not.toHaveBeenCalled();
      expect(resolveTransitionMock).not.toHaveBeenCalled();
      expect(processResultMock).toHaveBeenCalledWith({
        repo: 'owner/repo',
        issueNumber: '10',
        stage: 'pr_remediate',
        cwd: '/tmp/fake-wt',
        result,
      });
    }
  );

  it('handles reject/fail processResult failures as agent crashes with stderr', async () => {
    fetchChecksMock.mockResolvedValue(PASS_CHECKS);
    retryOnInvalidOutputMock.mockResolvedValue({
      verdict: 'reject',
      comment: '.shipper/output/comment-10.md',
    });
    processResultMock.mockRejectedValue(new Error('failed to post remediation result'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { prRemediateCommand } = await import('../../src/commands/pr-remediate.js');

    await expect(prRemediateCommand(repo, '42')).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith('failed to post remediation result');
    expect(handleAgentCrashMock).toHaveBeenCalledWith(
      'owner/repo',
      '10',
      'pr_remediate',
      'failed to post remediation result'
    );
    expect(pushWithRetryMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);

    errorSpy.mockRestore();
  });

  it('continues the pass when the initial prompt exits non-zero but retry validation succeeds', async () => {
    fetchChecksMock.mockResolvedValue(PASS_CHECKS);
    runPromptMock.mockResolvedValueOnce(17);
    validateStageOutputMock.mockResolvedValue({
      verdict: 'accept',
      comment: '.shipper/output/comment-10.md',
    });

    const { prRemediateCommand } = await import('../../src/commands/pr-remediate.js');

    await expect(prRemediateCommand(repo, '42')).resolves.toBeUndefined();

    expect(retryOnInvalidOutputMock).toHaveBeenCalledTimes(1);
    expect(handleAgentCrashMock).not.toHaveBeenCalled();
    expect(pushWithRetryMock).toHaveBeenCalledTimes(1);
    expect(postCommentMock).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(0);
  });

  it('exits after five red-CI passes without changing labels', async () => {
    fetchChecksMock.mockResolvedValue(FAIL_CHECKS);
    validateStageOutputMock.mockResolvedValue({
      verdict: 'accept',
      comment: '.shipper/output/comment-10.md',
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { prRemediateCommand } = await import('../../src/commands/pr-remediate.js');

    await expect(prRemediateCommand(repo, '42')).resolves.toBeUndefined();

    expect(syncWorktreeMock).toHaveBeenCalledTimes(5);
    expect(pushWithRetryMock).toHaveBeenCalledTimes(5);
    expect(postCommentMock).toHaveBeenCalledTimes(5);
    expect(executeTransitionMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith('Remediation exhausted 5 passes without green CI.');

    errorSpy.mockRestore();
  });

  it('reuses the same output directory when retrying within a pass', async () => {
    fetchChecksMock.mockResolvedValue(PASS_CHECKS);
    validateStageOutputMock.mockResolvedValue({
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

  it('forwards push hook failures to the retry agent as raw userInput', async () => {
    fetchChecksMock.mockResolvedValue(PASS_CHECKS);
    validateStageOutputMock.mockResolvedValue({
      verdict: 'accept',
      comment: '.shipper/output/comment-10.md',
    });

    const { prRemediateCommand } = await import('../../src/commands/pr-remediate.js');

    await expect(prRemediateCommand(repo, '42')).resolves.toBeUndefined();

    const pushRetryAgent = pushWithRetryMock.mock.calls[0]?.[1] as
      | ((conflictContext?: unknown, pushError?: string, installError?: string) => Promise<number>)
      | undefined;
    expect(pushRetryAgent).toEqual(expect.any(Function));
    if (!pushRetryAgent) {
      throw new Error('Expected pushWithRetry to receive a retry callback.');
    }
    runPromptMock.mockClear();

    await expect(pushRetryAgent(undefined, 'pre-push hook failed: npm run test')).resolves.toBe(0);

    expect(runPromptMock).toHaveBeenCalledWith('pr_remediate', {
      repo,
      issueRef: '10',
      prRef: '42',
      cwd: '/tmp/fake-wt',
      mode: undefined,
      agent: undefined,
      model: undefined,
      userInput: 'pre-push hook failed: npm run test',
    });
    expect(formatConflictContextMock).not.toHaveBeenCalled();
  });

  it('warns and reuses the previously validated result when refresh validation fails after push', async () => {
    fetchChecksMock.mockResolvedValue(PASS_CHECKS);
    retryOnInvalidOutputMock.mockResolvedValue({
      verdict: 'accept',
      comment: '.shipper/output/comment-10.md',
      replies: '.shipper/output/replies',
    });
    validateStageOutputMock.mockRejectedValue(
      new Error('Missing result.json at /tmp/fake-wt/.shipper/output/result.json')
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { prRemediateCommand } = await import('../../src/commands/pr-remediate.js');

    await expect(prRemediateCommand(repo, '42')).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to refresh pr_remediate result after push retry; using previously validated output: Missing result.json at /tmp/fake-wt/.shipper/output/result.json'
    );
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
    expect(process.exitCode).toBe(0);
    warnSpy.mockRestore();
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
    expect(validateStageOutputMock).not.toHaveBeenCalled();
    expect(pushWithRetryMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);

    errorSpy.mockRestore();
  });

  it('reloads prepared outputs before reporting a push failure crash and stops remediation', async () => {
    retryOnInvalidOutputMock.mockResolvedValueOnce({
      verdict: 'accept',
      comment: '.shipper/output/comment-10.md',
      replies: '.shipper/output/replies',
    });
    validateStageOutputMock.mockResolvedValueOnce({
      verdict: 'accept',
      comment: '.shipper/output/comment-11.md',
      replies: '.shipper/output/replies-updated',
    });
    pushWithRetryMock.mockRejectedValue(new Error('fatal: unable to access remote'));

    const { prRemediateCommand } = await import('../../src/commands/pr-remediate.js');

    await expect(prRemediateCommand(repo, '42')).resolves.toBeUndefined();

    expect(postRepliesMock).toHaveBeenCalledWith(
      'owner/repo',
      '42',
      '/tmp/fake-wt',
      '.shipper/output/replies-updated'
    );
    expect(postCommentMock).toHaveBeenCalledWith(
      'owner/repo',
      '10',
      '/tmp/fake-wt/.shipper/output/comment-11.md'
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
    expect(pushWithRetryMock).toHaveBeenCalledTimes(1);
  });

  it('still reports a push failure crash when posting prepared outputs also fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    retryOnInvalidOutputMock.mockResolvedValue({
      verdict: 'accept',
      comment: '.shipper/output/comment-10.md',
      replies: '.shipper/output/replies',
    });
    validateStageOutputMock.mockResolvedValue({
      verdict: 'accept',
      comment: '.shipper/output/comment-10.md',
      replies: '.shipper/output/replies',
    });
    pushWithRetryMock.mockRejectedValue(new Error('fatal: unable to access remote'));
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
    expect(pushWithRetryMock).not.toHaveBeenCalled();
  });

  it('does not transition to ready when no checks have appeared yet', async () => {
    fetchChecksMock.mockResolvedValue([]);
    validateStageOutputMock.mockResolvedValue({
      verdict: 'accept',
      comment: '.shipper/output/comment-10.md',
    });

    const { prRemediateCommand } = await import('../../src/commands/pr-remediate.js');

    await expect(prRemediateCommand(repo, '42')).resolves.toBeUndefined();

    expect(syncWorktreeMock).toHaveBeenCalledTimes(5);
    expect(pushWithRetryMock).toHaveBeenCalledTimes(5);
    expect(executeTransitionMock).not.toHaveBeenCalled();
  });
});
