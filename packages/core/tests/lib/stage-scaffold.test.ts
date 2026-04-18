import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunPromptOpts } from '../../src/lib/prompt-runner.js';
import type { StageInvocation, StageScaffoldOpts } from '../../src/lib/stage-scaffold.js';
import type { DiffFileHunks } from '../../src/lib/output-protocol/diff-parse.js';
import type { CreateWorktreeOpts } from '../../src/lib/worktree.js';

const acceptedResult = {
  verdict: 'accept' as const,
  comment: '.shipper/output/comment-123.md',
};

type RetryOpts = {
  cwd: string;
  stage: string;
  retry: (userInput: string) => Promise<number>;
  prFiles?: Set<string>;
  diffHunks?: Map<string, DiffFileHunks>;
};

type ProcessResultOpts = {
  repo: string;
  issueNumber: string;
  stage: string;
  cwd: string;
  result: typeof acceptedResult;
  prNumber?: string;
};

const events: string[] = [];
const formatConflictContextMock = vi.fn<(context: unknown) => string>();
const handleAgentCrashMock = vi.fn<
  (repo: string, issue: string, stage: string, detail: string, summary?: string) => Promise<void>
>(() => Promise.resolve());
const loggerErrorMock = vi.fn<(message: string) => void>();
const processResultMock = vi.fn<(opts: ProcessResultOpts) => Promise<typeof acceptedResult>>();
const retryOnInvalidOutputMock = vi.fn<(opts: RetryOpts) => Promise<typeof acceptedResult>>();
const runPromptMock = vi.fn<(name: string, opts: RunPromptOpts) => Promise<number>>();
const scrubOutputDirMock = vi.fn<(wtPath: string) => Promise<void>>();
const toErrorMessageMock = vi.fn<(error: unknown) => string>((error) =>
  error instanceof Error ? error.message : String(error)
);
const truncateLargeInputMock =
  vi.fn<(wtPath: string, text: string, filename: string) => Promise<string>>();
const withGitTransportMock = vi.fn<(opts: unknown, fn: unknown) => unknown>();
const withIssueLockMock = vi.fn<
  (repo: string, issue: string, fn: () => Promise<unknown>) => Promise<unknown>
>((_repo, _issue, fn) => {
  events.push('withIssueLock');
  return fn();
});
const withStageHooksMock = vi.fn<
  (
    stage: string,
    env: { issueNumber: string; branchName: string },
    fn: () => Promise<unknown>
  ) => Promise<unknown>
>((_stage, _env, fn) => {
  events.push('withStageHooks');
  return fn();
});
const withWorktreeMock = vi.fn<
  (opts: CreateWorktreeOpts, fn: (wtPath: string) => Promise<unknown>) => Promise<unknown>
>((_opts, fn) => {
  events.push('withWorktree');
  return fn('/tmp/fake-wt');
});

vi.mock('../../src/lib/errors.js', () => ({
  toErrorMessage: (error: unknown) => toErrorMessageMock(error),
}));

vi.mock('../../src/lib/hooks.js', () => ({
  withStageHooks: (
    stage: string,
    env: { issueNumber: string; branchName: string },
    fn: () => Promise<unknown>
  ) => withStageHooksMock(stage, env, fn),
}));

vi.mock('../../src/lib/lock.js', () => ({
  withIssueLock: (repo: string, issue: string, fn: () => Promise<unknown>) =>
    withIssueLockMock(repo, issue, fn),
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    error: (message: string) => {
      loggerErrorMock(message);
    },
  },
}));

vi.mock('../../src/lib/output-protocol/index.js', () => ({
  handleAgentCrash: (
    repo: string,
    issue: string,
    stage: string,
    detail: string,
    summary?: string
  ) =>
    handleAgentCrashMock(repo, issue, stage, detail, ...(summary === undefined ? [] : [summary])),
  processResult: (opts: ProcessResultOpts) => processResultMock(opts),
  retryOnInvalidOutput: (opts: RetryOpts) => retryOnInvalidOutputMock(opts),
  scrubOutputDir: (wtPath: string) => scrubOutputDirMock(wtPath),
  truncateLargeInput: (wtPath: string, text: string, filename: string) =>
    truncateLargeInputMock(wtPath, text, filename),
}));

vi.mock('../../src/lib/prompt-runner.js', () => ({
  runPrompt: (name: string, opts: RunPromptOpts) => runPromptMock(name, opts),
}));

vi.mock('../../src/lib/worktree.js', () => ({
  formatConflictContext: (context: unknown) => formatConflictContextMock(context),
  withGitTransport: (opts: unknown, fn: unknown) => withGitTransportMock(opts, fn),
  withWorktree: (opts: CreateWorktreeOpts, fn: (wtPath: string) => Promise<unknown>) =>
    withWorktreeMock(opts, fn),
}));

const { runStageScaffold, simpleInvoker, transportInvoker } =
  await import('../../src/lib/stage-scaffold.js');

function buildInvocation(overrides: Partial<StageInvocation> = {}): StageInvocation {
  return {
    initial: () => Promise.resolve(0),
    retry: () => Promise.resolve(0),
    ...overrides,
  };
}

describe('runStageScaffold', () => {
  beforeEach(() => {
    events.length = 0;
    vi.clearAllMocks();
    process.exitCode = undefined;
    scrubOutputDirMock.mockImplementation(() => {
      events.push('scrubOutputDir');
      return Promise.resolve();
    });
    retryOnInvalidOutputMock.mockImplementation(() => {
      events.push('retryOnInvalidOutput');
      return Promise.resolve(acceptedResult);
    });
    processResultMock.mockImplementation(() => {
      events.push('processResult');
      return Promise.resolve(acceptedResult);
    });
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('runs the shared scaffold in order and forwards setup and PR metadata when present', async () => {
    const diffHunks = new Map<string, DiffFileHunks>([
      [
        'src/file.ts',
        {
          left: [[1, 2]],
          right: [[1, 3]],
        },
      ],
    ]);
    const prFiles = new Set(['src/file.ts']);

    const opts: StageScaffoldOpts = {
      repo: 'owner/repo',
      issueNumber: '123',
      stage: 'pr-review',
      resultStage: 'pr_review',
      createBranch: false,
      initialFailure: 'crash',
      prNumber: { value: '84' },
      resolveLocked: () => {
        events.push('resolveLocked');
        return Promise.resolve({ repoRoot: '/tmp/fake-repo', branch: 'shipper/123-branch' });
      },
      invoker: ({ wtPath, repoRoot, branch, baseBranch }) =>
        buildInvocation({
          setup: () => {
            events.push('setup');
            expect({ wtPath, repoRoot, branch, baseBranch }).toEqual({
              wtPath: '/tmp/fake-wt',
              repoRoot: '/tmp/fake-repo',
              branch: 'shipper/123-branch',
              baseBranch: undefined,
            });
            return Promise.resolve({ prFiles, diffHunks });
          },
          initial: () => {
            events.push('initial');
            return Promise.resolve(0);
          },
        }),
    };

    await runStageScaffold(opts);

    expect(events).toEqual([
      'withIssueLock',
      'resolveLocked',
      'withStageHooks',
      'withWorktree',
      'scrubOutputDir',
      'setup',
      'initial',
      'retryOnInvalidOutput',
      'processResult',
    ]);
    expect(withStageHooksMock).toHaveBeenCalledWith(
      'pr-review',
      { issueNumber: '123', branchName: 'shipper/123-branch' },
      expect.any(Function)
    );
    expect(withWorktreeMock).toHaveBeenCalledWith(
      {
        repoRoot: '/tmp/fake-repo',
        branch: 'shipper/123-branch',
        createBranch: false,
        issueNumber: '123',
        stage: 'pr-review',
      },
      expect.any(Function)
    );
    const retryOpts = retryOnInvalidOutputMock.mock.calls[0]?.[0];
    expect(retryOpts).toBeDefined();
    if (!retryOpts) {
      throw new Error('Expected retry arguments');
    }
    expect(retryOpts.cwd).toBe('/tmp/fake-wt');
    expect(retryOpts.stage).toBe('pr_review');
    expect(retryOpts.prFiles).toEqual(prFiles);
    expect(retryOpts.diffHunks).toEqual(diffHunks);
    expect(typeof retryOpts.retry).toBe('function');
    expect(processResultMock).toHaveBeenCalledWith({
      repo: 'owner/repo',
      issueNumber: '123',
      stage: 'pr_review',
      cwd: '/tmp/fake-wt',
      result: acceptedResult,
      prNumber: '84',
    });
  });

  it('logs and reports agent crashes for simple-stage non-zero initial exits', async () => {
    await runStageScaffold({
      repo: 'owner/repo',
      issueNumber: '123',
      stage: 'design',
      resultStage: 'design',
      createBranch: true,
      initialFailure: 'crash',
      resolveLocked: () =>
        Promise.resolve({
          repoRoot: '/tmp/fake-repo',
          branch: 'shipper/123-branch',
          baseBranch: 'main',
        }),
      invoker: () =>
        buildInvocation({
          initial: () => Promise.resolve(23),
        }),
    });

    expect(retryOnInvalidOutputMock).not.toHaveBeenCalled();
    expect(processResultMock).not.toHaveBeenCalled();
    expect(loggerErrorMock).toHaveBeenCalledWith('Agent exited with code 23');
    expect(handleAgentCrashMock).toHaveBeenCalledWith(
      'owner/repo',
      '123',
      'design',
      'Agent exited with code 23',
      'The `design` agent run exited with code 23.'
    );
    expect(process.exitCode).toBe(1);
  });

  it('propagates transport initial exit codes without invoking crash handling', async () => {
    await runStageScaffold({
      repo: 'owner/repo',
      issueNumber: '123',
      stage: 'implement',
      resultStage: 'implement',
      createBranch: true,
      initialFailure: 'propagate',
      resolveLocked: () =>
        Promise.resolve({
          repoRoot: '/tmp/fake-repo',
          branch: 'shipper/123-branch',
          baseBranch: 'main',
        }),
      invoker: () =>
        buildInvocation({
          initial: () => Promise.resolve(7),
        }),
    });

    expect(loggerErrorMock).not.toHaveBeenCalled();
    expect(handleAgentCrashMock).not.toHaveBeenCalled();
    expect(retryOnInvalidOutputMock).not.toHaveBeenCalled();
    expect(processResultMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(7);
  });

  it('logs and reports retry or process-result failures', async () => {
    retryOnInvalidOutputMock.mockImplementationOnce(() => {
      events.push('retryOnInvalidOutput');
      return Promise.reject(new Error('Missing result.json'));
    });

    await runStageScaffold({
      repo: 'owner/repo',
      issueNumber: '123',
      stage: 'plan',
      resultStage: 'plan',
      createBranch: true,
      initialFailure: 'crash',
      resolveLocked: () =>
        Promise.resolve({
          repoRoot: '/tmp/fake-repo',
          branch: 'shipper/123-branch',
          baseBranch: 'main',
        }),
      invoker: () => buildInvocation(),
    });

    expect(toErrorMessageMock).toHaveBeenCalled();
    expect(loggerErrorMock).toHaveBeenCalledWith('Missing result.json');
    expect(handleAgentCrashMock).toHaveBeenCalledWith(
      'owner/repo',
      '123',
      'plan',
      'Missing result.json'
    );
    expect(process.exitCode).toBe(1);
  });

  it('omits optional baseBranch and prNumber when they are not provided', async () => {
    await runStageScaffold({
      repo: 'owner/repo',
      issueNumber: '123',
      stage: 'plan',
      resultStage: 'plan',
      createBranch: true,
      initialFailure: 'crash',
      resolveLocked: () =>
        Promise.resolve({
          repoRoot: '/tmp/fake-repo',
          branch: 'shipper/123-branch',
        }),
      invoker: () => buildInvocation(),
    });

    expect(withWorktreeMock).toHaveBeenCalledWith(
      {
        repoRoot: '/tmp/fake-repo',
        branch: 'shipper/123-branch',
        createBranch: true,
        issueNumber: '123',
        stage: 'plan',
      },
      expect.any(Function)
    );
    expect(processResultMock).toHaveBeenCalledWith({
      repo: 'owner/repo',
      issueNumber: '123',
      stage: 'plan',
      cwd: '/tmp/fake-wt',
      result: acceptedResult,
    });
  });
});

describe('simpleInvoker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes setup through and forwards prompt args for initial and retry runs', async () => {
    const setupMock = vi.fn(() =>
      Promise.resolve({
        prFiles: new Set(['src/file.ts']),
      })
    );
    runPromptMock.mockResolvedValue(0);

    const invocation = simpleInvoker({
      promptName: 'design',
      baseRunPromptOpts: {
        repo: 'owner/repo',
        issueRef: '123',
        mode: 'headless',
        agent: 'codex',
        model: 'gpt-5',
      },
      setup: setupMock,
    })({
      wtPath: '/tmp/fake-wt',
      repoRoot: '/tmp/fake-repo',
      branch: 'shipper/123-branch',
      baseBranch: undefined,
    });

    await expect(invocation.setup?.()).resolves.toEqual({
      prFiles: new Set(['src/file.ts']),
    });
    await expect(invocation.initial()).resolves.toBe(0);
    await expect(invocation.retry('Fix result')).resolves.toBe(0);

    expect(setupMock).toHaveBeenCalledWith('/tmp/fake-wt');
    expect(runPromptMock).toHaveBeenNthCalledWith(1, 'design', {
      repo: 'owner/repo',
      issueRef: '123',
      cwd: '/tmp/fake-wt',
      mode: 'headless',
      agent: 'codex',
      model: 'gpt-5',
    });
    expect(runPromptMock).toHaveBeenNthCalledWith(2, 'design', {
      repo: 'owner/repo',
      issueRef: '123',
      cwd: '/tmp/fake-wt',
      mode: 'headless',
      agent: 'codex',
      model: 'gpt-5',
      userInput: 'Fix result',
    });
  });
});

describe('transportInvoker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requires baseBranch and forwards conflict context into prompt retries', async () => {
    formatConflictContextMock.mockReturnValue('formatted conflict context');
    truncateLargeInputMock.mockResolvedValue('truncated:conflict-context.txt');
    runPromptMock.mockResolvedValue(0);
    withGitTransportMock.mockImplementation((_opts, fn) =>
      (
        fn as (
          conflictContext?: unknown,
          pushError?: string,
          installError?: string
        ) => Promise<number>
      )({
        files: ['src/conflict.ts'],
        conflicts: [
          {
            path: 'src/conflict.ts',
            markers: ['<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> origin/main'],
          },
        ],
      })
    );

    const invocation = transportInvoker({
      promptName: 'implement',
      pushMode: 'new-branch',
      baseRunPromptOpts: {
        repo: 'owner/repo',
        issueRef: '239',
        mode: 'interactive',
        agent: 'claude',
      },
    })({
      wtPath: '/tmp/fake-wt',
      repoRoot: '/tmp/fake-repo',
      branch: 'shipper/239-branch',
      baseBranch: 'main',
    });

    await expect(invocation.initial()).resolves.toBe(0);

    expect(withGitTransportMock).toHaveBeenCalledWith(
      {
        wtPath: '/tmp/fake-wt',
        repoRoot: '/tmp/fake-repo',
        baseBranch: 'main',
        pushMode: 'new-branch',
      },
      expect.any(Function)
    );
    expect(formatConflictContextMock).toHaveBeenCalled();
    expect(truncateLargeInputMock).toHaveBeenCalledWith(
      '/tmp/fake-wt',
      'formatted conflict context',
      'conflict-context.txt'
    );
    expect(runPromptMock).toHaveBeenCalledWith('implement', {
      repo: 'owner/repo',
      issueRef: '239',
      cwd: '/tmp/fake-wt',
      mode: 'interactive',
      agent: 'claude',
      userInput: 'truncated:conflict-context.txt',
    });
  });

  it('prefers transport diagnostics over user retry text and falls back when none exist', async () => {
    truncateLargeInputMock.mockResolvedValueOnce('truncated:push-error.txt');
    runPromptMock.mockResolvedValue(0);

    const invocation = transportInvoker({
      promptName: 'pr_open',
      pushMode: 'force-with-lease',
      baseRunPromptOpts: {
        repo: 'owner/repo',
        issueRef: '239',
        baseBranch: 'release/2026',
      },
    })({
      wtPath: '/tmp/fake-wt',
      repoRoot: '/tmp/fake-repo',
      branch: 'shipper/239-branch',
      baseBranch: 'release/2026',
    });

    withGitTransportMock.mockImplementationOnce((_opts, fn) =>
      (
        fn as (
          conflictContext?: unknown,
          pushError?: string,
          installError?: string
        ) => Promise<number>
      )(undefined, 'git push failed')
    );
    await expect(invocation.retry('Fix result')).resolves.toBe(0);

    withGitTransportMock.mockImplementationOnce((_opts, fn) =>
      (
        fn as (
          conflictContext?: unknown,
          pushError?: string,
          installError?: string
        ) => Promise<number>
      )()
    );
    await expect(invocation.retry('Manual retry')).resolves.toBe(0);

    expect(truncateLargeInputMock).toHaveBeenCalledWith(
      '/tmp/fake-wt',
      'git push failed',
      'push-error.txt'
    );
    expect(runPromptMock).toHaveBeenNthCalledWith(1, 'pr_open', {
      repo: 'owner/repo',
      issueRef: '239',
      baseBranch: 'release/2026',
      cwd: '/tmp/fake-wt',
      userInput: 'truncated:push-error.txt',
    });
    expect(runPromptMock).toHaveBeenNthCalledWith(2, 'pr_open', {
      repo: 'owner/repo',
      issueRef: '239',
      baseBranch: 'release/2026',
      cwd: '/tmp/fake-wt',
      userInput: 'Manual retry',
    });
  });

  it('throws when baseBranch is omitted', () => {
    expect(() =>
      transportInvoker({
        promptName: 'implement',
        pushMode: 'new-branch',
        baseRunPromptOpts: {
          repo: 'owner/repo',
          issueRef: '239',
        },
      })({
        wtPath: '/tmp/fake-wt',
        repoRoot: '/tmp/fake-repo',
        branch: 'shipper/239-branch',
        baseBranch: undefined,
      })
    ).toThrow('baseBranch is required for transport invocations');
  });
});
