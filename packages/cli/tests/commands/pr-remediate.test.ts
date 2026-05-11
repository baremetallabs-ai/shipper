import { access, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import * as core from '@baremetallabs-ai/shipper-core';
import type {
  PRChecksLine,
  PrReviewWait,
  ResultJson,
  RunPromptOpts,
} from '@baremetallabs-ai/shipper-core';

import { createFakeCore } from '../_harness/fake-core.js';
import {
  buildReadyCheck,
  prRemediateCommand,
  runPrRemediateStage,
} from '../../src/commands/pr-remediate.js';

type FakeCore = ReturnType<typeof createFakeCore>;
type StageOutputSpec = Parameters<FakeCore['writeStageOutput']>[0];

const repo = 'owner/repo';
const issueNumber = '10';
const prNumber = '42';
const defaultCreatedAt = '2026-03-12T10:00:00Z';

const PENDING_CHECKS: PRChecksLine[] = [
  {
    name: 'build',
    state: 'IN_PROGRESS',
    bucket: 'pending',
    link: 'https://github.com/owner/repo/actions/runs/456',
  },
];
const PASS_CHECKS: PRChecksLine[] = [
  {
    name: 'build',
    state: 'COMPLETED',
    bucket: 'pass',
    link: 'https://github.com/owner/repo/actions/runs/789',
  },
];
const FAIL_CHECKS: PRChecksLine[] = [
  {
    name: 'build-lint-ubuntu',
    state: 'COMPLETED',
    bucket: 'fail',
    link: 'https://github.com/owner/repo/actions/runs/123',
  },
];

function buildSettings(prReviewWait: PrReviewWait) {
  return {
    ...core.DEFAULTS,
    prReviewWait,
    commands: {
      default: {
        ...core.DEFAULTS.commands.default,
      },
    },
    merge: {
      ...core.DEFAULTS.merge,
    },
  };
}

function buildStageOutput(
  verdict: ResultJson['verdict'],
  options: {
    commentPath?: string;
    commentBody?: string;
    replies?: Record<string, string>;
  } = {}
): StageOutputSpec {
  return {
    result: {
      verdict,
      comment: options.commentPath ?? '.shipper/output/comment-10.md',
    },
    commentBody: options.commentBody ?? `Result: ${verdict}`,
    ...(options.replies ? { replies: options.replies } : {}),
  };
}

describe('prRemediateCommand', () => {
  let fake: FakeCore;
  let getSettingsSpy: MockInstance;
  let promptCalls: Array<{ name: string; opts: RunPromptOpts }>;

  const seedRemediationState = (): void => {
    fake.setIssue(issueNumber, { labels: ['shipper:pr-reviewed'] });
    fake.setPr(prNumber, {
      labels: ['shipper:pr-reviewed'],
      body: 'Closes #10',
      baseRefName: 'release/2026',
      headRefName: 'shipper/10-feature',
      createdAt: defaultCreatedAt,
      reviewThreads: [
        {
          path: 'src/file.ts',
          line: 7,
          isResolved: false,
          isOutdated: false,
          comments: [
            {
              id: 101,
              author: 'reviewer',
              body: 'Please fix this.',
              createdAt: defaultCreatedAt,
            },
          ],
        },
      ],
    });
    fake.setRun('123', {
      jobs: [
        {
          name: 'build-lint-ubuntu',
          conclusion: 'failure',
          databaseId: 99,
          steps: [
            { name: 'Install', conclusion: 'success', number: 1, status: 'completed' },
            { name: 'Lint', conclusion: 'failure', number: 2, status: 'completed' },
          ],
        },
      ],
      failedLogsByJobId: {
        99: 'full failed log',
      },
    });
  };

  const scriptPromptRuns = (
    ...runs: Array<{
      exitCode?: number;
      writeOutput?: boolean;
      output?: StageOutputSpec;
      afterPrompt?: (opts: RunPromptOpts) => Promise<void> | void;
    }>
  ): void => {
    let index = 0;
    fake.scriptRunPrompt(async (name, opts) => {
      promptCalls.push({ name, opts });
      const run = runs[Math.min(index, runs.length - 1)] ?? {};
      index += 1;
      await run.afterPrompt?.(opts);
      if (run.writeOutput !== false) {
        await fake.writeStageOutput(
          run.output ??
            buildStageOutput('accept', {
              commentBody: 'Accepted remediation.',
              replies: { '101': 'Applied the change.' },
            })
        );
      }
      return run.exitCode ?? 0;
    });
  };

  const queueChecks = (...checks: PRChecksLine[][]): void => {
    fake.queueChecks(prNumber, ...checks);
  };

  const scriptCheckResponses = (...responses: Array<PRChecksLine[] | Error>): void => {
    let index = 0;
    fake.stubGh((args) => {
      if (args[0] !== 'pr' || args[1] !== 'checks' || args[2] !== prNumber) {
        return undefined;
      }
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (response instanceof Error) {
        throw response;
      }
      return {
        stdout: JSON.stringify(response ?? []),
        stderr: '',
      };
    });
  };

  const runStage = async (
    options: Parameters<typeof runPrRemediateStage>[3] = {
      skipInitialWait: true,
    }
  ) => {
    return await runPrRemediateStage(repo, issueNumber, prNumber, options);
  };

  const readInputFile = async (filename: string): Promise<string> => {
    return await readFile(path.join(fake.wtPath(), '.shipper', 'input', filename), 'utf-8');
  };

  const readOutputFile = async (filename: string): Promise<string> => {
    return await readFile(path.join(fake.wtPath(), '.shipper', 'output', filename), 'utf-8');
  };

  const fileExists = async (relativePath: string): Promise<boolean> => {
    try {
      await access(path.join(fake.wtPath(), relativePath));
      return true;
    } catch {
      return false;
    }
  };

  beforeEach(() => {
    fake = createFakeCore();
    fake.install();
    promptCalls = [];
    process.exitCode = undefined;

    seedRemediationState();
    fake.queueRevParse('remote-before', 'remote-after');
    fake.queueCommitsAhead(1);
    getSettingsSpy = vi
      .spyOn(core, 'getSettings')
      .mockReturnValue(buildSettings({ mode: 'checks', maxDurationMinutes: 30 }));

    scriptPromptRuns();
  });

  afterEach(async () => {
    process.exitCode = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
    await fake.dispose();
  });

  describe('buildReadyCheck', () => {
    it('skips timer readiness checks entirely when durationMinutes is 0', async () => {
      let ghCalls = 0;
      fake.stubGh(() => {
        ghCalls += 1;
        return undefined;
      });

      const readyCheck = await buildReadyCheck(repo, prNumber, {
        mode: 'timer',
        durationMinutes: 0,
      });

      await expect(readyCheck()).resolves.toBe(true);
      expect(ghCalls).toBe(0);
    });

    it('reports timer readiness only after the deadline passes', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-12T10:10:00Z'));
      fake.setPr(prNumber, { createdAt: defaultCreatedAt });

      const readyCheck = await buildReadyCheck(repo, prNumber, {
        mode: 'timer',
        durationMinutes: 15,
      });

      await expect(readyCheck()).resolves.toBe(false);
      vi.setSystemTime(new Date('2026-03-12T10:15:00Z'));
      await expect(readyCheck()).resolves.toBe(true);
    });

    it('reports checks readiness as false while checks are pending', async () => {
      queueChecks(PENDING_CHECKS, PENDING_CHECKS);

      const readyCheck = await buildReadyCheck(repo, prNumber, {
        mode: 'checks',
        maxDurationMinutes: 15,
      });

      await expect(readyCheck()).resolves.toBe(false);
    });

    it('reports checks readiness once pending checks clear', async () => {
      queueChecks(PENDING_CHECKS, PASS_CHECKS);

      const readyCheck = await buildReadyCheck(repo, prNumber, {
        mode: 'checks',
        maxDurationMinutes: 15,
      });

      await expect(readyCheck()).resolves.toBe(true);
    });

    it('keeps the zero-check grace window before reporting ready', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-12T10:00:00Z'));
      queueChecks([], [], []);

      const readyCheck = await buildReadyCheck(repo, prNumber, {
        mode: 'checks',
        maxDurationMinutes: 15,
      });

      await expect(readyCheck()).resolves.toBe(false);
      vi.setSystemTime(new Date('2026-03-12T10:00:29Z'));
      await expect(readyCheck()).resolves.toBe(false);
      vi.setSystemTime(new Date('2026-03-12T10:00:30Z'));
      await expect(readyCheck()).resolves.toBe(true);
    });

    it('returns ready after three consecutive fetch failures in checks mode', async () => {
      scriptCheckResponses(
        new Error('network error'),
        new Error('network error'),
        new Error('network error'),
        new Error('network error')
      );

      const readyCheck = await buildReadyCheck(repo, prNumber, {
        mode: 'checks',
        maxDurationMinutes: 15,
      });

      await expect(readyCheck()).resolves.toBe(false);
      await expect(readyCheck()).resolves.toBe(false);
      await expect(readyCheck()).resolves.toBe(true);
    });

    it('resets the checks-mode failure counter after a successful fetch', async () => {
      scriptCheckResponses(
        new Error('network error'),
        new Error('network error'),
        PENDING_CHECKS,
        new Error('network error'),
        new Error('network error'),
        new Error('network error')
      );

      const readyCheck = await buildReadyCheck(repo, prNumber, {
        mode: 'checks',
        maxDurationMinutes: 15,
      });

      await expect(readyCheck()).resolves.toBe(false);
      await expect(readyCheck()).resolves.toBe(false);
      await expect(readyCheck()).resolves.toBe(false);
      await expect(readyCheck()).resolves.toBe(false);
      await expect(readyCheck()).resolves.toBe(true);
    });

    it('keeps checks mode blocked until minDurationMinutes elapses from PR creation', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-12T10:10:00Z'));
      queueChecks(PASS_CHECKS, PASS_CHECKS, PASS_CHECKS);

      const readyCheck = await buildReadyCheck(repo, prNumber, {
        mode: 'checks',
        minDurationMinutes: 15,
      });

      await expect(readyCheck()).resolves.toBe(false);
      vi.setSystemTime(new Date('2026-03-12T10:15:00Z'));
      await expect(readyCheck()).resolves.toBe(true);
    });

    it('proceeds immediately when checks pass after minDurationMinutes has already elapsed', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-12T10:20:00Z'));
      queueChecks(PASS_CHECKS, PASS_CHECKS);

      const readyCheck = await buildReadyCheck(repo, prNumber, {
        mode: 'checks',
        minDurationMinutes: 15,
      });

      await expect(readyCheck()).resolves.toBe(true);
    });

    it('treats maxDurationMinutes as the ceiling even when minDurationMinutes has not elapsed', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-12T10:00:00Z'));
      queueChecks(PENDING_CHECKS, PENDING_CHECKS, PENDING_CHECKS);

      const readyCheck = await buildReadyCheck(repo, prNumber, {
        mode: 'checks',
        minDurationMinutes: 45,
        maxDurationMinutes: 1,
      });

      await expect(readyCheck()).resolves.toBe(false);
      vi.setSystemTime(new Date('2026-03-12T10:01:00Z'));
      await expect(readyCheck()).resolves.toBe(true);
    });

    it('waits indefinitely in checks mode with no duration fields until checks clear', async () => {
      queueChecks(PENDING_CHECKS, PENDING_CHECKS, PASS_CHECKS);

      const readyCheck = await buildReadyCheck(repo, prNumber, {
        mode: 'checks',
      });

      await expect(readyCheck()).resolves.toBe(false);
      await expect(readyCheck()).resolves.toBe(true);
    });
  });

  it('supports skipping the initial review wait through an explicit helper option', async () => {
    getSettingsSpy.mockReturnValue(buildSettings({ mode: 'timer', durationMinutes: 15 }));
    queueChecks(PASS_CHECKS, PASS_CHECKS, PASS_CHECKS, PASS_CHECKS);

    const result = await runStage({ skipInitialWait: true });

    expect(result).toEqual({ success: true, exitCode: 0, verdict: 'accept' });
    expect(fake.state.sleepCalls).toEqual([]);
  });

  it('accepts on the first pass, posts artifacts, and transitions to ready on green CI', async () => {
    queueChecks(PASS_CHECKS, PASS_CHECKS, PASS_CHECKS, PASS_CHECKS, PASS_CHECKS, PASS_CHECKS);

    await prRemediateCommand(repo, prNumber);

    expect(process.exitCode).toBe(0);
    expect(fake.state.issues.get(issueNumber)?.labels).toEqual(new Set(['shipper:ready']));
    expect(fake.state.prs.get(prNumber)?.labels).toEqual(new Set(['shipper:ready']));
    expect(fake.state.postedComments).toEqual([
      {
        target: 'issue',
        number: issueNumber,
        body: 'Accepted remediation.',
      },
    ]);
    expect(fake.state.postedReplies).toEqual([
      {
        pr: prNumber,
        commentId: '101',
        body: 'Applied the change.',
      },
    ]);
    expect(JSON.parse(await readInputFile('review-threads.json'))).toEqual(
      fake.state.prs.get(prNumber)?.reviewThreads
    );
    expect(JSON.parse(await readInputFile('ci-status.json'))).toEqual({
      pending: [],
      failed: [],
      passed: PASS_CHECKS,
      total: 1,
    });
    expect(await readInputFile('pr-diff.patch')).toContain('diff --git a/file b/file');
    expect(JSON.parse(await readInputFile('pass-info.json'))).toEqual({ pass: 1, maxPasses: 5 });
    expect(fake.state.rerunRequests).toEqual([]);
  });

  it('fails fast when rebase drops all commits ahead of the base branch', async () => {
    queueChecks(PASS_CHECKS);
    fake.scriptCommitsAhead(() => 0);

    const result = await runStage();

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain('0 commits ahead');
    expect(fake.state.issues.get(issueNumber)?.labels).toEqual(new Set(['shipper:failed']));
    expect(fake.state.prs.get(prNumber)?.labels).toEqual(new Set(['shipper:failed']));
    expect(fake.state.postedComments).toHaveLength(1);
    expect(fake.state.postedComments[0]?.body).toContain('0 commits ahead');
    expect(promptCalls).toEqual([]);
  });

  it('reports a crash when the ahead-count check fails', async () => {
    queueChecks(PASS_CHECKS);
    fake.scriptCommitsAhead(() => {
      throw new Error('git rev-list failed');
    });

    const result = await runStage();

    expect(result).toEqual({
      success: false,
      exitCode: 1,
      error: 'git rev-list failed',
    });
    expect(fake.state.issues.get(issueNumber)?.labels).toEqual(new Set(['shipper:pr-reviewed']));
    expect(fake.state.postedComments).toHaveLength(1);
    expect(fake.state.postedComments[0]?.body).toContain('git rev-list failed');
  });

  it('bails out of preflight check polling after three consecutive fetch failures', async () => {
    getSettingsSpy.mockReturnValue(buildSettings({ mode: 'checks', maxDurationMinutes: 15 }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    scriptCheckResponses(
      PENDING_CHECKS,
      new Error('network error'),
      new Error('network error'),
      new Error('network error'),
      PASS_CHECKS,
      PASS_CHECKS,
      PASS_CHECKS,
      PASS_CHECKS
    );

    await prRemediateCommand(repo, prNumber);

    expect(logSpy).toHaveBeenCalledWith(
      '[shipper] Check polling stopped: persistent fetch failures. Proceeding.'
    );
    expect(fake.state.sleepCalls).toEqual([20_000, 20_000]);

    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('resets waitForChecks consecutive failures after a successful fetch', async () => {
    getSettingsSpy.mockReturnValue(buildSettings({ mode: 'checks', maxDurationMinutes: 15 }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    scriptCheckResponses(
      PENDING_CHECKS,
      new Error('network error'),
      new Error('network error'),
      PENDING_CHECKS,
      new Error('network error'),
      new Error('network error'),
      new Error('network error'),
      PASS_CHECKS,
      PASS_CHECKS,
      PASS_CHECKS,
      PASS_CHECKS
    );

    await prRemediateCommand(repo, prNumber);

    expect(logSpy).toHaveBeenCalledWith(
      '[shipper] Check polling stopped: persistent fetch failures. Proceeding.'
    );
    expect(fake.state.sleepCalls).toEqual([20_000, 20_000, 20_000, 20_000, 20_000]);

    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('waits for the remaining minimum review window after checks pass', async () => {
    getSettingsSpy.mockReturnValue(buildSettings({ mode: 'checks', minDurationMinutes: 15 }));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-12T10:10:00Z'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    queueChecks(PASS_CHECKS, PASS_CHECKS, PASS_CHECKS, PASS_CHECKS, PASS_CHECKS, PASS_CHECKS);

    await prRemediateCommand(repo, prNumber);

    expect(logSpy).toHaveBeenCalledWith(
      '[shipper] Wait complete. Waiting 5 more minute(s) for minimum review window (prReviewWait.minDurationMinutes: 15)...'
    );
    expect(fake.state.sleepCalls).toContain(300_000);

    logSpy.mockRestore();
  });

  it('does not sleep after checks pass when the minimum review window has already elapsed', async () => {
    getSettingsSpy.mockReturnValue(buildSettings({ mode: 'checks', minDurationMinutes: 15 }));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-12T10:20:00Z'));
    queueChecks(PASS_CHECKS, PASS_CHECKS, PASS_CHECKS, PASS_CHECKS, PASS_CHECKS, PASS_CHECKS);

    await prRemediateCommand(repo, prNumber);

    expect(fake.state.sleepCalls).toEqual([]);
  });

  it('does not sleep for minDurationMinutes after maxDurationMinutes has already elapsed', async () => {
    getSettingsSpy.mockReturnValue(
      buildSettings({ mode: 'checks', minDurationMinutes: 45, maxDurationMinutes: 1 })
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-12T10:00:00Z'));
    fake.scriptSleep((ms) => {
      vi.setSystemTime(new Date(Date.now() + ms));
    });
    queueChecks(
      PENDING_CHECKS,
      PENDING_CHECKS,
      PENDING_CHECKS,
      PENDING_CHECKS,
      PASS_CHECKS,
      PASS_CHECKS,
      PASS_CHECKS
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await prRemediateCommand(repo, prNumber);

    expect(fake.state.sleepCalls).not.toContain(300_000);
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('minimum review window'));

    logSpy.mockRestore();
  });

  it('routes sync conflict context through truncateLargeInput', async () => {
    queueChecks(PASS_CHECKS, PASS_CHECKS, PASS_CHECKS, PASS_CHECKS);
    scriptPromptRuns(
      { writeOutput: false },
      {
        output: buildStageOutput('accept', {
          commentBody: 'Accepted remediation.',
          replies: { '101': 'Applied the change.' },
        }),
      }
    );
    const marker = ['<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> origin/main'].join('\n');
    const largeMarker = `${marker}\n${'content\n'.repeat(10_000)}`;
    fake.scriptSyncWorktree(async (_opts, resolveConflicts) => {
      const code = await resolveConflicts({
        files: ['src/conflict.ts'],
        conflicts: [{ path: 'src/conflict.ts', markers: [largeMarker] }],
      });
      expect(code).toBe(0);
    });

    const result = await runStage();

    expect(result.exitCode).toBe(0);
    expect(promptCalls[0]?.opts.userInput).toContain(
      'full output written to .shipper/input/conflict-context.txt'
    );
    expect(await fileExists('.shipper/input/conflict-context.txt')).toBe(true);
    expect(await readInputFile('conflict-context.txt')).toContain('<<<<<<< HEAD');
  });

  it('routes sync install errors through truncateLargeInput and leaves retry correction input unchanged', async () => {
    queueChecks(PASS_CHECKS, PASS_CHECKS, PASS_CHECKS, PASS_CHECKS);
    scriptPromptRuns(
      { writeOutput: false },
      {
        output: buildStageOutput('accept', {
          commentBody: 'Accepted remediation.',
          replies: { '101': 'Applied the change.' },
        }),
      }
    );
    fake.scriptSyncWorktree(async (_opts, _resolveConflicts, remediateInstallError) => {
      const largeInstallError = `install failed\n${'detail\n'.repeat(10_000)}`;
      const code = await remediateInstallError?.(largeInstallError);
      expect(code).toBe(0);
    });

    const result = await runStage();

    expect(result.exitCode).toBe(0);
    expect(promptCalls[0]?.opts.userInput).toContain(
      'full output written to .shipper/input/install-error.txt'
    );
    expect(await fileExists('.shipper/input/install-error.txt')).toBe(true);
    expect(promptCalls[1]?.opts.userInput).toBeUndefined();
  });

  it('retries after red CI, refreshes preflight context, and succeeds on a later green pass', async () => {
    queueChecks(
      FAIL_CHECKS,
      FAIL_CHECKS,
      FAIL_CHECKS,
      FAIL_CHECKS,
      PASS_CHECKS,
      PASS_CHECKS,
      PASS_CHECKS,
      PASS_CHECKS
    );
    let remoteRead = 0;
    fake.scriptGitRevParse((_cwd, ref) => {
      if (ref === 'origin/shipper/10-feature') {
        remoteRead += 1;
        return `remote-sha-${remoteRead}`;
      }
      return 'head-sha';
    });
    let pushCalls = 0;
    fake.scriptPushWithRetry(() => {
      pushCalls += 1;
      return 0;
    });

    const result = await runStage();

    expect(result).toEqual({ success: true, exitCode: 0, verdict: 'accept' });
    expect(pushCalls).toBe(2);
    expect(promptCalls).toHaveLength(2);
    expect(fake.state.postedComments).toHaveLength(2);
    expect(JSON.parse(await readInputFile('pass-info.json'))).toEqual({ pass: 2, maxPasses: 5 });
    expect(await readInputFile('ci-status.json')).toContain('"bucket": "pass"');
  });

  it('reruns failed CI checks before polling when no new commit was pushed and exits after a green rerun', async () => {
    queueChecks(FAIL_CHECKS, FAIL_CHECKS, PASS_CHECKS, PASS_CHECKS, PASS_CHECKS);
    fake.scriptGitRevParse(() => 'same-sha');

    const result = await runStage();

    expect(result.exitCode).toBe(0);
    expect(fake.state.rerunRequests).toEqual([{ runId: '123' }]);
    expect(fake.state.sleepCalls).toContain(10_000);
  });

  it('skips rerunning failed CI checks when pushWithRetry advances the remote branch', async () => {
    queueChecks(PASS_CHECKS, PASS_CHECKS, PASS_CHECKS, PASS_CHECKS);
    fake.queueRevParse('before-sha', 'after-sha');

    const result = await runStage();

    expect(result.exitCode).toBe(0);
    expect(fake.state.rerunRequests).toEqual([]);
    expect(fake.state.sleepCalls).not.toContain(10_000);
  });

  it('counts a no-push rerun that stays red as a pass and starts the next remediation pass', async () => {
    queueChecks(
      FAIL_CHECKS,
      FAIL_CHECKS,
      FAIL_CHECKS,
      FAIL_CHECKS,
      FAIL_CHECKS,
      PASS_CHECKS,
      PASS_CHECKS,
      PASS_CHECKS,
      PASS_CHECKS
    );
    let revParseCalls = 0;
    fake.scriptGitRevParse((_cwd, ref) => {
      if (!ref.startsWith('origin/')) {
        return 'head-sha';
      }
      revParseCalls += 1;
      return revParseCalls <= 2 ? 'same-sha' : `remote-sha-${revParseCalls}`;
    });

    const result = await runStage();

    expect(result).toEqual({ success: true, exitCode: 0, verdict: 'accept' });
    expect(promptCalls).toHaveLength(2);
    expect(fake.state.rerunRequests).toEqual([{ runId: '123' }]);
    expect(JSON.parse(await readInputFile('pass-info.json'))).toEqual({ pass: 2, maxPasses: 5 });
  });

  it('skips no-push detection when origin branch is not yet available locally', async () => {
    queueChecks(PASS_CHECKS, PASS_CHECKS, PASS_CHECKS, PASS_CHECKS);
    fake.scriptGitRevParse((_cwd, ref) => {
      if (ref.startsWith('origin/')) {
        throw new Error('missing remote ref');
      }
      return 'head-sha';
    });

    const result = await runStage();

    expect(result.exitCode).toBe(0);
    expect(fake.state.rerunRequests).toEqual([]);
  });

  it('continues to the next pass when fetching final CI state after waiting fails', async () => {
    scriptCheckResponses(
      FAIL_CHECKS,
      FAIL_CHECKS,
      FAIL_CHECKS,
      new Error('network error'),
      PASS_CHECKS,
      PASS_CHECKS,
      PASS_CHECKS,
      PASS_CHECKS
    );
    let remoteRead = 0;
    fake.scriptGitRevParse((_cwd, ref) => {
      if (ref === 'origin/shipper/10-feature') {
        remoteRead += 1;
        return `remote-sha-${remoteRead}`;
      }
      return 'head-sha';
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runStage();

    expect(result).toEqual({ success: true, exitCode: 0, verdict: 'accept' });
    expect(promptCalls).toHaveLength(2);
    expect(errorSpy).toHaveBeenCalledWith(
      '[shipper] Pass 1/5: Failed to fetch CI checks after waiting. Continuing to next pass.'
    );

    errorSpy.mockRestore();
  });

  it('writes enriched ci-status.json and ci-log artifacts for failed checks', async () => {
    queueChecks(FAIL_CHECKS, PASS_CHECKS, PASS_CHECKS, PASS_CHECKS);

    const result = await runStage();

    expect(result.exitCode).toBe(0);
    expect(await readInputFile('ci-status.json')).toContain('"failed"');
    expect(await readInputFile('ci-log-build-lint-ubuntu.txt')).toBe('full failed log');
    expect(await readInputFile('pr-diff.patch')).toContain('diff --git a/file b/file');
    expect(await readInputFile('pass-info.json')).toContain('"pass": 1');
  });

  it.each(['reject', 'fail'] as const)(
    'delegates %s verdicts to processResult and never pushes',
    async (verdict) => {
      queueChecks(PASS_CHECKS);
      let pushCalls = 0;
      fake.scriptPushWithRetry(() => {
        pushCalls += 1;
        return 0;
      });
      scriptPromptRuns({
        output: buildStageOutput(verdict, {
          commentBody: `Result: ${verdict}`,
        }),
      });

      const result = await runStage();

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.verdict).toBe(verdict);
      expect(pushCalls).toBe(0);
      expect(fake.state.postedComments).toEqual([
        {
          target: 'issue',
          number: issueNumber,
          body: `Result: ${verdict}`,
        },
      ]);
      expect(fake.state.issues.get(issueNumber)?.labels).toEqual(
        new Set([verdict === 'reject' ? 'shipper:pr-open' : 'shipper:failed'])
      );
    }
  );

  it('handles reject/fail processResult failures as agent crashes with stderr', async () => {
    queueChecks(PASS_CHECKS);
    scriptPromptRuns({
      output: buildStageOutput('reject', {
        commentBody: 'Result: reject',
      }),
    });
    let failOnce = true;
    fake.stubGh((args) => {
      if (
        failOnce &&
        args[0] === 'issue' &&
        args[1] === 'comment' &&
        args.includes('--body-file')
      ) {
        failOnce = false;
        throw new Error('failed to post remediation result');
      }
      return undefined;
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runStage();

    expect(result).toEqual({
      success: false,
      exitCode: 1,
      error: 'failed to post remediation result',
    });
    expect(fake.state.postedComments.at(-1)?.body).toContain('failed to post remediation result');
    expect(errorSpy).toHaveBeenCalledWith('[shipper] failed to post remediation result');

    errorSpy.mockRestore();
  });

  it('bails early when the initial prompt exits non-zero', async () => {
    queueChecks(PASS_CHECKS);
    scriptPromptRuns({ exitCode: 17, writeOutput: false });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runStage();

    expect(result).toEqual({
      success: false,
      exitCode: 1,
      error: 'Agent exited with code 17',
    });
    expect(fake.state.postedComments).toHaveLength(1);
    expect(fake.state.postedComments[0]?.body).toContain('Agent exited with code 17');
    expect(fake.state.issues.get(issueNumber)?.labels).toEqual(new Set(['shipper:pr-reviewed']));
    expect(errorSpy).toHaveBeenCalledWith('[shipper] Agent exited with code 17');

    errorSpy.mockRestore();
  });

  it('exits after five red-CI passes without changing labels', async () => {
    queueChecks(
      FAIL_CHECKS,
      FAIL_CHECKS,
      FAIL_CHECKS,
      FAIL_CHECKS,
      FAIL_CHECKS,
      FAIL_CHECKS,
      FAIL_CHECKS,
      FAIL_CHECKS,
      FAIL_CHECKS,
      FAIL_CHECKS,
      FAIL_CHECKS,
      FAIL_CHECKS,
      FAIL_CHECKS,
      FAIL_CHECKS,
      FAIL_CHECKS,
      FAIL_CHECKS,
      FAIL_CHECKS,
      FAIL_CHECKS,
      FAIL_CHECKS,
      FAIL_CHECKS
    );
    fake.queueRevParse(
      'before-1',
      'after-1',
      'before-2',
      'after-2',
      'before-3',
      'after-3',
      'before-4',
      'after-4',
      'before-5',
      'after-5'
    );
    let pushCalls = 0;
    fake.scriptPushWithRetry(() => {
      pushCalls += 1;
      return 0;
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runStage();

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(pushCalls).toBe(5);
    expect(promptCalls).toHaveLength(5);
    expect(fake.state.issues.get(issueNumber)?.labels).toEqual(new Set(['shipper:pr-reviewed']));
    expect(errorSpy).toHaveBeenCalledWith(
      '[shipper] Remediation exhausted 5 passes without green CI.'
    );

    errorSpy.mockRestore();
  });

  it('reuses the same output directory when retrying within a pass', async () => {
    queueChecks(PASS_CHECKS, PASS_CHECKS, PASS_CHECKS, PASS_CHECKS);
    scriptPromptRuns(
      {
        writeOutput: false,
        afterPrompt: async () => {
          await writeFile(path.join(fake.wtPath(), '.shipper', 'output', 'scratch.txt'), 'keep me');
        },
      },
      {
        output: buildStageOutput('accept', {
          commentBody: 'Accepted remediation.',
          replies: { '101': 'Applied the change.' },
        }),
      }
    );

    const result = await runStage();

    expect(result.exitCode).toBe(0);
    expect(await readOutputFile('scratch.txt')).toBe('keep me');
    expect(promptCalls[1]?.opts.userInput).toContain(
      'Your previous output was invalid. Fix the following'
    );
  });

  it('forwards push hook failures to the retry agent as raw userInput', async () => {
    queueChecks(PASS_CHECKS, PASS_CHECKS, PASS_CHECKS, PASS_CHECKS);
    fake.scriptPushWithRetry(async (_opts, runAgent) => {
      return await runAgent(undefined, 'pre-push hook failed: npm run test');
    });

    const result = await runStage();

    expect(result.exitCode).toBe(0);
    expect(promptCalls.at(-1)?.opts.userInput).toBe('pre-push hook failed: npm run test');
    expect(await fileExists('.shipper/input/push-error.txt')).toBe(false);
  });

  it('warns and reuses the previously validated result when refresh validation fails after push', async () => {
    queueChecks(PASS_CHECKS, PASS_CHECKS, PASS_CHECKS, PASS_CHECKS);
    scriptPromptRuns({
      output: buildStageOutput('accept', {
        commentBody: 'Prepared remediation result.',
        replies: { '101': 'Prepared reply.' },
      }),
    });
    fake.scriptPushWithRetry(async () => {
      await rm(path.join(fake.wtPath(), '.shipper', 'output', 'result.json'), { force: true });
      return 0;
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await runStage();

    expect(result).toEqual({ success: true, exitCode: 0, verdict: 'accept' });
    expect(warnSpy).toHaveBeenCalledWith(
      `[shipper] Failed to refresh pr_remediate result after push retry; using previously validated output: Missing result.json at ${path.join(fake.wtPath(), '.shipper', 'output', 'result.json')}`
    );
    expect(fake.state.postedComments[0]?.body).toBe('Prepared remediation result.');
    expect(fake.state.postedReplies[0]?.body).toBe('Prepared reply.');

    warnSpy.mockRestore();
  });

  it('handles retryOnInvalidOutput failure as agent crash with stderr', async () => {
    queueChecks(PASS_CHECKS);
    scriptPromptRuns({ writeOutput: false }, { writeOutput: false });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runStage();

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain('Missing result.json');
    expect(fake.state.postedComments.at(-1)?.body).toContain('Missing result.json');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[shipper] Missing result.json'));

    errorSpy.mockRestore();
  });

  it('reloads prepared outputs before reporting a push failure crash and stops remediation', async () => {
    queueChecks(PASS_CHECKS);
    scriptPromptRuns({
      output: buildStageOutput('accept', {
        commentBody: 'Prepared remediation result.',
        replies: { '101': 'Prepared reply.' },
      }),
    });
    fake.scriptPushWithRetry(async () => {
      await fake.writeStageOutput({
        result: {
          verdict: 'accept',
          comment: '.shipper/output/comment-11.md',
          replies: '.shipper/output/replies-updated',
        },
        commentBody: 'Updated remediation result.',
        replies: { '202': 'Updated reply.' },
      });
      throw new Error('fatal: unable to access remote');
    });

    const result = await runStage();

    expect(result).toEqual({
      success: false,
      exitCode: 1,
      error: 'fatal: unable to access remote',
    });
    expect(fake.state.postedReplies[0]).toEqual({
      pr: prNumber,
      commentId: '202',
      body: 'Updated reply.',
    });
    expect(fake.state.postedComments[0]?.body).toBe('Updated remediation result.');
    expect(fake.state.postedComments[1]?.body).toContain('fatal: unable to access remote');
    expect(fake.state.issues.get(issueNumber)?.labels).toEqual(new Set(['shipper:pr-reviewed']));
  });

  it('still reports a push failure crash when posting prepared outputs also fails', async () => {
    queueChecks(PASS_CHECKS);
    scriptPromptRuns({
      output: buildStageOutput('accept', {
        commentBody: 'Prepared remediation result.',
        replies: { '101': 'Prepared reply.' },
      }),
    });
    fake.scriptPushWithRetry(() => {
      throw new Error('fatal: unable to access remote');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let failReplies = true;
    let failComment = true;
    fake.stubGh((args) => {
      if (
        failReplies &&
        args[0] === 'api' &&
        typeof args[1] === 'string' &&
        args[1].includes(`/pulls/${prNumber}/comments/101/replies`)
      ) {
        failReplies = false;
        throw new Error('reply post failed');
      }
      if (
        failComment &&
        args[0] === 'issue' &&
        args[1] === 'comment' &&
        args.includes('--body-file')
      ) {
        failComment = false;
        throw new Error('comment post failed');
      }
      return undefined;
    });

    const result = await runStage();

    expect(result).toEqual({
      success: false,
      exitCode: 1,
      error: 'fatal: unable to access remote',
    });
    expect(warnSpy).toHaveBeenCalledWith(
      '[shipper] Failed to post replies during push failure handling: reply post failed'
    );
    expect(warnSpy).toHaveBeenCalledWith(
      '[shipper] Failed to post comment during push failure handling: comment post failed'
    );
    expect(fake.state.postedComments.at(-1)?.body).toContain('fatal: unable to access remote');

    warnSpy.mockRestore();
  });

  it('handles sync failures as agent crashes', async () => {
    queueChecks(PASS_CHECKS);
    fake.scriptSyncWorktree(() => {
      throw new Error('rebase failed');
    });

    const result = await runStage();

    expect(result).toEqual({
      success: false,
      exitCode: 1,
      error: 'rebase failed',
    });
    expect(fake.state.postedComments[0]?.body).toContain('rebase failed');
    expect(promptCalls).toEqual([]);
  });

  it('does not transition to ready when no checks have appeared yet', async () => {
    queueChecks([], [], [], [], [], [], [], [], [], [], [], [], [], [], [], [], [], [], [], [], []);
    fake.queueRevParse(
      'before-1',
      'after-1',
      'before-2',
      'after-2',
      'before-3',
      'after-3',
      'before-4',
      'after-4',
      'before-5',
      'after-5'
    );

    const result = await runStage();

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(fake.state.issues.get(issueNumber)?.labels).toEqual(new Set(['shipper:pr-reviewed']));
    expect(fake.state.prs.get(prNumber)?.labels).toEqual(new Set(['shipper:pr-reviewed']));
  });
});
