import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunPromptOpts } from '../../../core/src/lib/prompt-runner.js';
import type { StageScaffoldOpts } from '../../../core/src/lib/stage-scaffold.js';

const autoSelectIssueMock = vi.fn();
const formatConflictContextMock = vi.fn(() => 'formatted conflict context');
const generateBranchNameMock = vi.fn(() => Promise.resolve('shipper/239-branch'));
const getRepoRootMock = vi.fn(() => Promise.resolve('/tmp/fake-repo'));
const getSettingsMock = vi.fn(() => ({ defaultBaseBranch: 'main' }));
const resolveBaseBranchMock = vi.fn(() => Promise.resolve('main'));
const runPromptMock = vi.fn<(name: string, opts: RunPromptOpts) => Promise<number>>(() =>
  Promise.resolve(0)
);
const runStageScaffoldMock = vi.fn<(opts: StageScaffoldOpts) => Promise<void>>(() =>
  Promise.resolve()
);
const truncateLargeInputMock = vi.fn((_: string, text: string, filename: string) =>
  Promise.resolve(`truncated:${filename}:${text}`)
);
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
    generateBranchName: generateBranchNameMock,
    getRepoRoot: getRepoRootMock,
    getSettings: getSettingsMock,
    logger: {
      error: (...args: [string]) => {
        loggerErrorMock(...args);
      },
    },
    resolveBaseBranch: resolveBaseBranchMock,
    runStageScaffold: (opts: StageScaffoldOpts) => runStageScaffoldMock(opts),
    transportInvoker: stageScaffold.transportInvoker,
  };
});

describe('implementCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  it('passes the implement scaffold config and preserves in-lock resolution order', async () => {
    const { implementCommand } = await import('../../src/commands/implement.js');

    await expect(implementCommand('owner/repo', '239')).resolves.toBeUndefined();

    const scaffoldArgs = runStageScaffoldMock.mock.calls[0]?.[0];
    expect(scaffoldArgs).toBeDefined();
    if (!scaffoldArgs) {
      throw new Error('Expected scaffold arguments');
    }

    expect(scaffoldArgs.repo).toBe('owner/repo');
    expect(scaffoldArgs.issueNumber).toBe('239');
    expect(scaffoldArgs.stage).toBe('implement');
    expect(scaffoldArgs.resultStage).toBe('implement');
    expect(scaffoldArgs.createBranch).toBe(true);
    expect(scaffoldArgs.initialFailure).toBe('propagate');

    await expect(scaffoldArgs.resolveLocked()).resolves.toEqual({
      repoRoot: '/tmp/fake-repo',
      branch: 'shipper/239-branch',
      baseBranch: 'main',
    });

    expect(getRepoRootMock).toHaveBeenCalledTimes(1);
    expect(generateBranchNameMock).toHaveBeenCalledWith('owner/repo', '239');
    expect(resolveBaseBranchMock).toHaveBeenCalledWith('owner/repo', 'main');
    expect(getRepoRootMock.mock.invocationCallOrder[0]).toBeLessThan(
      generateBranchNameMock.mock.invocationCallOrder[0]
    );
    expect(generateBranchNameMock.mock.invocationCallOrder[0]).toBeLessThan(
      getSettingsMock.mock.invocationCallOrder[0]
    );
    expect(getSettingsMock.mock.invocationCallOrder[0]).toBeLessThan(
      resolveBaseBranchMock.mock.invocationCallOrder[0]
    );
  });

  it('builds transport invocations that preserve implement payload parity', async () => {
    const { implementCommand } = await import('../../src/commands/implement.js');

    await implementCommand('owner/repo', '239');

    const scaffoldArgs = runStageScaffoldMock.mock.calls[0]?.[0];
    expect(scaffoldArgs).toBeDefined();
    if (!scaffoldArgs) {
      throw new Error('Expected scaffold arguments');
    }

    const invoker = scaffoldArgs.invoker({
      wtPath: '/tmp/fake-wt',
      repoRoot: '/tmp/fake-repo',
      branch: 'shipper/239-branch',
      baseBranch: 'main',
    });

    await expect(invoker.initial()).resolves.toBe(0);
    expect(withGitTransportMock).toHaveBeenCalledWith(
      {
        wtPath: '/tmp/fake-wt',
        repoRoot: '/tmp/fake-repo',
        baseBranch: 'main',
        pushMode: 'new-branch',
      },
      expect.any(Function)
    );
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
    expect(runPromptMock).toHaveBeenCalledWith('implement', {
      repo: 'owner/repo',
      issueRef: '239',
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
    expect(runPromptMock).toHaveBeenLastCalledWith('implement', {
      repo: 'owner/repo',
      issueRef: '239',
      cwd: '/tmp/fake-wt',
      mode: undefined,
      agent: undefined,
      model: undefined,
      userInput: 'Fix result',
    });
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
      ) => fn(undefined, 'git push -u origin HEAD exited with code 1:\npre-push hook failed')
    );
    const { implementCommand } = await import('../../src/commands/implement.js');

    await implementCommand('owner/repo', '239');

    const scaffoldArgs = runStageScaffoldMock.mock.calls[0]?.[0];
    expect(scaffoldArgs).toBeDefined();
    if (!scaffoldArgs) {
      throw new Error('Expected scaffold arguments');
    }

    const invoker = scaffoldArgs.invoker({
      wtPath: '/tmp/fake-wt',
      repoRoot: '/tmp/fake-repo',
      branch: 'shipper/239-branch',
      baseBranch: 'main',
    });

    await expect(invoker.initial()).resolves.toBe(0);
    expect(formatConflictContextMock).not.toHaveBeenCalled();
    expect(truncateLargeInputMock).toHaveBeenCalledWith(
      '/tmp/fake-wt',
      'git push -u origin HEAD exited with code 1:\npre-push hook failed',
      'push-error.txt'
    );
    expect(runPromptMock).toHaveBeenCalledWith(
      'implement',
      expect.objectContaining({
        userInput:
          'truncated:push-error.txt:git push -u origin HEAD exited with code 1:\npre-push hook failed',
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
    const { implementCommand } = await import('../../src/commands/implement.js');

    await implementCommand('owner/repo', '239');

    const scaffoldArgs = runStageScaffoldMock.mock.calls[0]?.[0];
    expect(scaffoldArgs).toBeDefined();
    if (!scaffoldArgs) {
      throw new Error('Expected scaffold arguments');
    }

    const invoker = scaffoldArgs.invoker({
      wtPath: '/tmp/fake-wt',
      repoRoot: '/tmp/fake-repo',
      branch: 'shipper/239-branch',
      baseBranch: 'main',
    });

    await expect(invoker.initial()).resolves.toBe(0);
    expect(truncateLargeInputMock).toHaveBeenCalledWith(
      '/tmp/fake-wt',
      'npm install exited with code 1',
      'install-error.txt'
    );
    expect(runPromptMock).toHaveBeenCalledWith(
      'implement',
      expect.objectContaining({
        userInput: 'truncated:install-error.txt:npm install exited with code 1',
      })
    );
  });

  it('preserves auto-selection behavior when no issue is provided', async () => {
    autoSelectIssueMock.mockResolvedValueOnce({ number: 321, title: 'Selected issue' });
    const { implementCommand } = await import('../../src/commands/implement.js');

    await expect(implementCommand('owner/repo')).resolves.toBeUndefined();

    expect(autoSelectIssueMock).toHaveBeenCalledWith('owner/repo', 'shipper:planned');
    expect(loggerErrorMock).toHaveBeenCalledWith('Auto-selected #321: Selected issue');
    expect(runStageScaffoldMock).toHaveBeenCalledWith(
      expect.objectContaining({ issueNumber: '321' })
    );
  });
});
