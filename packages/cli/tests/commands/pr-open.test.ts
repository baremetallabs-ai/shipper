import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunPromptOpts } from '../../../core/src/lib/prompt-runner.js';
import type { StageScaffoldOpts } from '../../../core/src/lib/stage-scaffold.js';

const autoSelectIssueMock = vi.fn();
const findBranchForIssueMock = vi.fn(() => Promise.resolve('shipper/239-branch'));
const formatConflictContextMock = vi.fn(() => 'formatted conflict context');
const getRepoRootMock = vi.fn(() => Promise.resolve('/tmp/fake-repo'));
const getSettingsMock = vi.fn(() => ({ defaultBaseBranch: 'main' }));
const resolveBaseBranchMock = vi.fn(() => Promise.resolve('release/2026'));
const resolveRefMock = vi.fn(() => Promise.resolve({ issueNumber: '239' }));
const runPromptMock = vi.fn<(name: string, opts: RunPromptOpts) => Promise<number>>(() =>
  Promise.resolve(0)
);
const runStageScaffoldMock = vi.fn<(opts: StageScaffoldOpts) => Promise<void>>(() =>
  Promise.resolve()
);
const truncateLargeInputMock = vi.fn((_: string, text: string, filename: string) =>
  Promise.resolve(`truncated:${filename}:${text}`)
);
const tryResolvePrForIssueMock = vi.fn(() => Promise.resolve(undefined));
type TransportRunner = (
  conflictContext?: unknown,
  pushError?: string,
  installError?: string
) => Promise<unknown>;
const withGitTransportMock = vi.fn((_opts: unknown, fn: TransportRunner) =>
  fn({
    files: ['src/conflict.ts'],
    conflicts: [
      {
        path: 'src/conflict.ts',
        markers: ['<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> origin/main'],
      },
    ],
  })
);
const loggerErrorMock = vi.fn<(message: string) => void>();

vi.mock('../../../core/src/lib/prompt-runner.js', () => {
  return {
    runPrompt: (name: string, opts: RunPromptOpts) => runPromptMock(name, opts),
  };
});

vi.mock('../../../core/src/lib/output-protocol/index.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../core/src/lib/output-protocol/index.js')
  >('../../../core/src/lib/output-protocol/index.js');
  return {
    ...actual,
    truncateLargeInput: (...args: Parameters<typeof actual.truncateLargeInput>) =>
      truncateLargeInputMock(...args),
  };
});

vi.mock('../../../core/src/lib/worktree.js', async () => {
  const actual = await vi.importActual<typeof import('../../../core/src/lib/worktree.js')>(
    '../../../core/src/lib/worktree.js'
  );
  return {
    ...actual,
    formatConflictContext: (...args: Parameters<typeof actual.formatConflictContext>) =>
      formatConflictContextMock(...args),
    withGitTransport: (...args: Parameters<typeof actual.withGitTransport>) =>
      withGitTransportMock(...args),
  };
});

vi.mock('@dnsquared/shipper-core', async () => {
  const stageScaffold = await vi.importActual<
    typeof import('../../../core/src/lib/stage-scaffold.js')
  >('../../../core/src/lib/stage-scaffold.js');
  return {
    autoSelectIssue: autoSelectIssueMock,
    findBranchForIssue: findBranchForIssueMock,
    getRepoRoot: getRepoRootMock,
    getSettings: getSettingsMock,
    logger: {
      error: (...args: [string]) => {
        loggerErrorMock(...args);
      },
    },
    resolveBaseBranch: resolveBaseBranchMock,
    resolveRef: resolveRefMock,
    runStageScaffold: (opts: StageScaffoldOpts) => runStageScaffoldMock(opts),
    transportInvoker: stageScaffold.transportInvoker,
    tryResolvePrForIssue: tryResolvePrForIssueMock,
  };
});

describe('prOpenCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  it('passes the pr-open scaffold config and preserves pre-lock resolution order', async () => {
    const { prOpenCommand } = await import('../../src/commands/pr-open.js');

    await expect(prOpenCommand('owner/repo', '239')).resolves.toBeUndefined();

    expect(resolveRefMock).toHaveBeenCalledWith('owner/repo', '239', 'issue');
    expect(tryResolvePrForIssueMock).toHaveBeenCalledWith('owner/repo', 239);
    expect(resolveBaseBranchMock).toHaveBeenCalledWith('owner/repo', 'main');
    expect(resolveRefMock.mock.invocationCallOrder[0]).toBeLessThan(
      tryResolvePrForIssueMock.mock.invocationCallOrder[0]
    );
    expect(tryResolvePrForIssueMock.mock.invocationCallOrder[0]).toBeLessThan(
      getSettingsMock.mock.invocationCallOrder[0]
    );
    expect(getSettingsMock.mock.invocationCallOrder[0]).toBeLessThan(
      resolveBaseBranchMock.mock.invocationCallOrder[0]
    );
    expect(resolveBaseBranchMock.mock.invocationCallOrder[0]).toBeLessThan(
      runStageScaffoldMock.mock.invocationCallOrder[0]
    );

    const scaffoldArgs = runStageScaffoldMock.mock.calls[0]?.[0];
    expect(scaffoldArgs).toBeDefined();
    if (!scaffoldArgs) {
      throw new Error('Expected scaffold arguments');
    }

    expect(scaffoldArgs.repo).toBe('owner/repo');
    expect(scaffoldArgs.issueNumber).toBe('239');
    expect(scaffoldArgs.stage).toBe('pr-open');
    expect(scaffoldArgs.resultStage).toBe('pr_open');
    expect(scaffoldArgs.createBranch).toBe(false);
    expect(scaffoldArgs.initialFailure).toBe('propagate');
    expect(scaffoldArgs.prNumber).toEqual({ value: undefined });

    await expect(scaffoldArgs.resolveLocked()).resolves.toEqual({
      repoRoot: '/tmp/fake-repo',
      branch: 'shipper/239-branch',
      baseBranch: 'release/2026',
    });
    expect(findBranchForIssueMock).toHaveBeenCalledWith('239');
  });

  it('builds transport invocations that preserve pr-open payload parity', async () => {
    const { prOpenCommand } = await import('../../src/commands/pr-open.js');

    await prOpenCommand('owner/repo', '239');

    const scaffoldArgs = runStageScaffoldMock.mock.calls[0]?.[0];
    expect(scaffoldArgs).toBeDefined();
    if (!scaffoldArgs) {
      throw new Error('Expected scaffold arguments');
    }

    const invoker = scaffoldArgs.invoker({
      wtPath: '/tmp/fake-wt',
      repoRoot: '/tmp/fake-repo',
      branch: 'shipper/239-branch',
      baseBranch: 'release/2026',
    });

    await expect(invoker.initial()).resolves.toBe(0);
    expect(withGitTransportMock).toHaveBeenCalledWith(
      {
        wtPath: '/tmp/fake-wt',
        repoRoot: '/tmp/fake-repo',
        baseBranch: 'release/2026',
        pushMode: 'force-with-lease',
      },
      expect.any(Function)
    );
    expect(formatConflictContextMock).toHaveBeenCalled();
    expect(truncateLargeInputMock).toHaveBeenCalledWith(
      '/tmp/fake-wt',
      'formatted conflict context',
      'conflict-context.txt'
    );
    expect(runPromptMock).toHaveBeenCalledWith('pr_open', {
      repo: 'owner/repo',
      issueRef: '239',
      baseBranch: 'release/2026',
      cwd: '/tmp/fake-wt',
      mode: undefined,
      agent: undefined,
      model: undefined,
      userInput: 'truncated:conflict-context.txt:formatted conflict context',
    });

    withGitTransportMock.mockImplementationOnce(
      (
        _opts: unknown,
        fn: (
          conflictContext?: unknown,
          pushError?: string,
          installError?: string
        ) => Promise<unknown>
      ) => fn()
    );

    await expect(invoker.retry('Fix result')).resolves.toBe(0);
    expect(runPromptMock).toHaveBeenLastCalledWith('pr_open', {
      repo: 'owner/repo',
      issueRef: '239',
      baseBranch: 'release/2026',
      cwd: '/tmp/fake-wt',
      mode: undefined,
      agent: undefined,
      model: undefined,
      userInput: 'Fix result',
    });
  });

  it('preserves the linked PR own-key shape when a PR already exists', async () => {
    tryResolvePrForIssueMock.mockResolvedValueOnce('84');
    const { prOpenCommand } = await import('../../src/commands/pr-open.js');

    await prOpenCommand('owner/repo', '239');

    expect(runStageScaffoldMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prNumber: { value: '84' },
      })
    );
  });

  it('routes push failures through truncateLargeInput without conflict formatting', async () => {
    withGitTransportMock.mockImplementationOnce(
      (
        _opts: unknown,
        fn: (
          conflictContext?: unknown,
          pushError?: string,
          installError?: string
        ) => Promise<unknown>
      ) => fn(undefined, 'git push --force-with-lease exited with code 1:\npre-push hook failed')
    );
    const { prOpenCommand } = await import('../../src/commands/pr-open.js');

    await prOpenCommand('owner/repo', '239');

    const scaffoldArgs = runStageScaffoldMock.mock.calls[0]?.[0];
    expect(scaffoldArgs).toBeDefined();
    if (!scaffoldArgs) {
      throw new Error('Expected scaffold arguments');
    }

    const invoker = scaffoldArgs.invoker({
      wtPath: '/tmp/fake-wt',
      repoRoot: '/tmp/fake-repo',
      branch: 'shipper/239-branch',
      baseBranch: 'release/2026',
    });

    await expect(invoker.initial()).resolves.toBe(0);
    expect(formatConflictContextMock).not.toHaveBeenCalled();
    expect(truncateLargeInputMock).toHaveBeenCalledWith(
      '/tmp/fake-wt',
      'git push --force-with-lease exited with code 1:\npre-push hook failed',
      'push-error.txt'
    );
    expect(runPromptMock).toHaveBeenCalledWith(
      'pr_open',
      expect.objectContaining({
        userInput:
          'truncated:push-error.txt:git push --force-with-lease exited with code 1:\npre-push hook failed',
      })
    );
  });

  it('routes install failures through truncateLargeInput', async () => {
    withGitTransportMock.mockImplementationOnce(
      (
        _opts: unknown,
        fn: (
          conflictContext?: unknown,
          pushError?: string,
          installError?: string
        ) => Promise<unknown>
      ) => fn(undefined, undefined, 'npm install exited with code 1')
    );
    const { prOpenCommand } = await import('../../src/commands/pr-open.js');

    await prOpenCommand('owner/repo', '239');

    const scaffoldArgs = runStageScaffoldMock.mock.calls[0]?.[0];
    expect(scaffoldArgs).toBeDefined();
    if (!scaffoldArgs) {
      throw new Error('Expected scaffold arguments');
    }

    const invoker = scaffoldArgs.invoker({
      wtPath: '/tmp/fake-wt',
      repoRoot: '/tmp/fake-repo',
      branch: 'shipper/239-branch',
      baseBranch: 'release/2026',
    });

    await expect(invoker.initial()).resolves.toBe(0);
    expect(truncateLargeInputMock).toHaveBeenCalledWith(
      '/tmp/fake-wt',
      'npm install exited with code 1',
      'install-error.txt'
    );
    expect(runPromptMock).toHaveBeenCalledWith(
      'pr_open',
      expect.objectContaining({
        userInput: 'truncated:install-error.txt:npm install exited with code 1',
      })
    );
  });

  it('preserves auto-selection behavior when no issue is provided', async () => {
    autoSelectIssueMock.mockResolvedValueOnce({ number: 321, title: 'Selected issue' });
    const { prOpenCommand } = await import('../../src/commands/pr-open.js');

    await expect(prOpenCommand('owner/repo')).resolves.toBeUndefined();

    expect(autoSelectIssueMock).toHaveBeenCalledWith('owner/repo', 'shipper:implemented');
    expect(loggerErrorMock).toHaveBeenCalledWith('Auto-selected #321: Selected issue');
    expect(runStageScaffoldMock).toHaveBeenCalledWith(
      expect.objectContaining({ issueNumber: '321' })
    );
  });
});
