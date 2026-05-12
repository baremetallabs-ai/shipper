import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import * as core from '@baremetallabs-ai/shipper-core';
import type { RunPromptOpts } from '@baremetallabs-ai/shipper-core';

import { createFakeCore } from '../_harness/fake-core.js';

type FakeCore = ReturnType<typeof createFakeCore>;

const repo = 'owner/repo';
const defaultDraftTitle = 'Add generated MCP reference pages';
const { execFileMock, randomBytesMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  randomBytesMock: vi.fn<(size: number) => Buffer>(),
}));

function createExecFileError(message: string): Error & { code: number } {
  return Object.assign(new Error(message), { code: 128 });
}

async function writeNewDraft(
  cwd: string,
  title = defaultDraftTitle,
  body = '# Request\n\nAdd generated MCP reference pages.'
): Promise<void> {
  const outputDir = path.join(cwd, '.shipper', 'output');
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'issue-body.md'), body, 'utf-8');
  await writeFile(
    path.join(outputDir, 'issue-draft.json'),
    JSON.stringify(
      {
        title,
        body_file: '.shipper/output/issue-body.md',
      },
      null,
      2
    ),
    'utf-8'
  );
  await writeFile(
    path.join(outputDir, 'result.json'),
    JSON.stringify(
      {
        issue_draft: '.shipper/output/issue-draft.json',
      },
      null,
      2
    ),
    'utf-8'
  );
}

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const execFile = Object.assign(
    (...args: unknown[]) => {
      execFileMock(...args);
    },
    {
      [Symbol.for('nodejs.util.promisify.custom')]: (...args: unknown[]) =>
        new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          execFileMock(
            ...args,
            (err: unknown, stdout: string | Buffer = '', stderr: string | Buffer = '') => {
              if (err) {
                reject(err instanceof Error ? err : new Error('execFile mock rejected'));
                return;
              }
              resolve({ stdout: String(stdout), stderr: String(stderr) });
            }
          );
        }),
    }
  );
  return {
    ...actual,
    execFile,
  };
});

vi.mock('node:crypto', async () => {
  const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto');
  return {
    ...actual,
    randomBytes: randomBytesMock,
  };
});

describe('newCommand', () => {
  let fake: FakeCore;
  let promptCalls: Array<{ name: string; opts: RunPromptOpts }>;
  let errorSpy: MockInstance;
  let persistNewResultSpy: MockInstance;

  const importCommand = async () => await import('../../src/commands/new.js');

  const stubDefaultBranch = (branch = 'main'): void => {
    fake.stubGh((args) => {
      if (
        args[0] === 'repo' &&
        args[1] === 'view' &&
        args[2] === repo &&
        args[3] === '--json' &&
        args[4] === 'defaultBranchRef'
      ) {
        return { stdout: `${branch}\n`, stderr: '' };
      }

      return undefined;
    });
  };

  beforeEach(() => {
    fake = createFakeCore();
    fake.install();
    promptCalls = [];
    delete process.env.SHIPPER_HEADLESS;
    delete process.env.SHIPPER_SESSION_RUN_ID;
    process.exitCode = undefined;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-22T02:38:36Z'));
    execFileMock.mockReset();
    execFileMock.mockImplementation((_cmd: string, args: string[], ...rest: unknown[]) => {
      const cb = rest[rest.length - 1] as (...cbArgs: unknown[]) => void;
      if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2]?.startsWith('refs/heads/')) {
        cb(createExecFileError('branch not found'));
        return;
      }

      cb(null, '', '');
    });
    randomBytesMock.mockReset();
    randomBytesMock.mockReturnValue(Buffer.from('a3f91c', 'hex'));
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    persistNewResultSpy = vi
      .spyOn(core, 'persistNewResultForLatestSession')
      .mockResolvedValue('/tmp/unlinked-new.result.json');
    fake.scriptRunPrompt(async (name, opts) => {
      promptCalls.push({ name, opts });
      await writeNewDraft(fake.wtPath());
      return 0;
    });
    stubDefaultBranch();
  });

  afterEach(async () => {
    process.exitCode = undefined;
    delete process.env.SHIPPER_SESSION_RUN_ID;
    errorSpy.mockRestore();
    vi.useRealTimers();
    vi.restoreAllMocks();
    await fake.dispose();
  });

  it('resolves the base branch, runs in a worktree, and forwards prompt options', async () => {
    const resolveBaseBranchSpy = vi.spyOn(core, 'resolveBaseBranch');
    const withStageHooksSpy = vi.spyOn(core, 'withStageHooks');
    const withWorktreeSpy = vi.spyOn(core, 'withWorktree');
    const runPromptSpy = vi.spyOn(core, 'runPrompt');
    const scrubOutputDirSpy = vi.spyOn(core, 'scrubOutputDir');
    const { newCommand } = await importCommand();

    await expect(
      newCommand(repo, ['my', 'request'], {
        mode: 'headless',
        agent: 'codex',
        model: 'gpt-5.4',
        logFile: '/tmp/example.jsonl',
      })
    ).resolves.toBeUndefined();

    const branchName = withStageHooksSpy.mock.calls[0]?.[1].branchName;
    expect(branchName).toMatch(/^shipper\/new-\d{8}-\d{6}-[a-f0-9]{6}$/);
    expect(resolveBaseBranchSpy).toHaveBeenCalledWith(repo, core.getSettings().defaultBaseBranch);
    expect(withStageHooksSpy).toHaveBeenCalledWith('new', { branchName }, expect.any(Function));
    expect(withWorktreeSpy).toHaveBeenCalledWith(
      {
        repoRoot: fake.repoRoot(),
        branch: branchName,
        createBranch: true,
        baseBranch: 'main',
        stage: 'new',
      },
      expect.any(Function)
    );
    expect(promptCalls).toEqual([
      {
        name: 'new',
        opts: {
          userInput: 'my request',
          repo,
          cwd: fake.wtPath(),
          baseBranch: 'main',
          mode: 'headless',
          agent: 'codex',
          model: 'gpt-5.4',
          logFile: '/tmp/example.jsonl',
        },
      },
    ]);
    expect(scrubOutputDirSpy).toHaveBeenCalledWith(fake.wtPath());
    expect(withStageHooksSpy.mock.invocationCallOrder[0]).toBeLessThan(
      withWorktreeSpy.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
    );
    expect(withWorktreeSpy.mock.invocationCallOrder[0]).toBeLessThan(
      scrubOutputDirSpy.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
    );
    expect(scrubOutputDirSpy.mock.invocationCallOrder[0]).toBeLessThan(
      runPromptSpy.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
    );
    expect([...fake.state.issues.values()]).toHaveLength(1);
    const createdIssue = [...fake.state.issues.values()][0];
    expect(createdIssue).toMatchObject({
      number: '1',
      title: defaultDraftTitle,
      body: '# Request\n\nAdd generated MCP reference pages.',
      url: 'https://github.com/owner/repo/issues/1',
    });
    expect(createdIssue?.labels.has('shipper:new')).toBe(true);
    await expect(
      readFile(path.join(fake.wtPath(), '.shipper/output/result.json'), 'utf-8')
    ).resolves.toBe(
      `${JSON.stringify(
        {
          created_issue: {
            number: 1,
            title: defaultDraftTitle,
            url: 'https://github.com/owner/repo/issues/1',
          },
        },
        null,
        2
      )}\n`
    );
    expect(persistNewResultSpy).toHaveBeenCalledWith({
      repo,
      cwd: fake.wtPath(),
      since: new Date('2026-04-22T02:38:36Z'),
      runId: undefined,
      result: {
        created_issue: {
          number: 1,
          title: defaultDraftTitle,
          url: 'https://github.com/owner/repo/issues/1',
        },
      },
    });
    expect(execFileMock).toHaveBeenCalledWith(
      'git',
      ['branch', '-d', branchName],
      { cwd: fake.repoRoot() },
      expect.any(Function)
    );
    expect(process.exitCode).toBe(0);
  });

  it('uses runPrompt without a mode override when none is provided', async () => {
    vi.spyOn(core, 'resolveBaseBranch').mockResolvedValueOnce('main');
    const { newCommand } = await importCommand();

    await expect(newCommand(repo, ['my', 'request'])).resolves.toBeUndefined();

    expect(promptCalls[0]?.opts).toEqual(
      expect.objectContaining({
        userInput: 'my request',
        repo,
        cwd: fake.wtPath(),
        baseBranch: 'main',
        mode: undefined,
      })
    );
    expect(process.exitCode).toBe(0);
  });

  it('passes SHIPPER_SESSION_RUN_ID through session result persistence', async () => {
    process.env.SHIPPER_SESSION_RUN_ID = 'run-123';
    vi.spyOn(core, 'resolveBaseBranch').mockResolvedValueOnce('main');
    const { newCommand } = await importCommand();

    await expect(newCommand(repo, ['my', 'request'])).resolves.toBeUndefined();

    expect(persistNewResultSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        repo,
        cwd: fake.wtPath(),
        runId: 'run-123',
        result: {
          created_issue: {
            number: 1,
            title: defaultDraftTitle,
            url: 'https://github.com/owner/repo/issues/1',
          },
        },
      })
    );
  });

  it('runs interactively with no user input when no mode override is provided', async () => {
    vi.spyOn(core, 'resolveBaseBranch').mockResolvedValueOnce('main');
    const { newCommand } = await importCommand();

    await expect(newCommand(repo, [])).resolves.toBeUndefined();

    expect(promptCalls[0]?.opts).toEqual(
      expect.objectContaining({
        userInput: undefined,
        repo,
        cwd: fake.wtPath(),
        baseBranch: 'main',
        mode: undefined,
      })
    );
    expect(process.exitCode).toBe(0);
  });

  it('runs interactively with no user input when mode is interactive', async () => {
    vi.spyOn(core, 'resolveBaseBranch').mockResolvedValueOnce('main');
    const { newCommand } = await importCommand();

    await expect(newCommand(repo, [], { mode: 'interactive' })).resolves.toBeUndefined();

    expect(promptCalls[0]?.opts).toEqual(
      expect.objectContaining({
        userInput: undefined,
        repo,
        cwd: fake.wtPath(),
        baseBranch: 'main',
        mode: 'interactive',
      })
    );
    expect(process.exitCode).toBe(0);
  });

  it('throws when no request is provided in explicit headless mode before worktree setup', async () => {
    const withStageHooksSpy = vi.spyOn(core, 'withStageHooks');
    const withWorktreeSpy = vi.spyOn(core, 'withWorktree');
    const { newCommand } = await importCommand();

    await expect(newCommand(repo, [], { mode: 'headless' })).rejects.toThrow(
      'Error: A request is required when running in headless mode.'
    );

    expect(errorSpy).toHaveBeenCalledWith(
      '[shipper] Usage: shipper new <request...> --mode headless'
    );
    expect(promptCalls).toEqual([]);
    expect(withStageHooksSpy).not.toHaveBeenCalled();
    expect(withWorktreeSpy).not.toHaveBeenCalled();
  });

  it('throws when settings resolve bare invocation to headless mode before worktree setup', async () => {
    const withStageHooksSpy = vi.spyOn(core, 'withStageHooks');
    const withWorktreeSpy = vi.spyOn(core, 'withWorktree');
    vi.spyOn(core, 'resolveMode').mockReturnValueOnce('headless');
    const { newCommand } = await importCommand();

    await expect(newCommand(repo, [])).rejects.toThrow(
      'Error: A request is required when running in headless mode.'
    );

    expect(errorSpy).toHaveBeenCalledWith(
      '[shipper] Usage: shipper new <request...> --mode headless'
    );
    expect(promptCalls).toEqual([]);
    expect(withStageHooksSpy).not.toHaveBeenCalled();
    expect(withWorktreeSpy).not.toHaveBeenCalled();
  });

  it('forwards codex without injecting a starter user message', async () => {
    vi.spyOn(core, 'resolveBaseBranch').mockResolvedValueOnce('main');
    const { newCommand } = await importCommand();

    await expect(newCommand(repo, [], { agent: 'codex' })).resolves.toBeUndefined();

    expect(promptCalls[0]?.opts).toEqual(
      expect.objectContaining({
        userInput: undefined,
        repo,
        cwd: fake.wtPath(),
        baseBranch: 'main',
        agent: 'codex',
      })
    );
    expect(process.exitCode).toBe(0);
  });

  it('retries an invalid draft and creates exactly one labeled issue after repair', async () => {
    const { newCommand } = await importCommand();
    fake.scriptRunPrompt(async (name, opts) => {
      promptCalls.push({ name, opts });
      if (promptCalls.length === 1) {
        await writeNewDraft(fake.wtPath(), '');
        return 0;
      }

      await writeNewDraft(fake.wtPath(), 'Repaired issue title');
      return 0;
    });

    await expect(
      newCommand(repo, ['my', 'request'], { mode: 'headless' })
    ).resolves.toBeUndefined();

    expect(promptCalls).toHaveLength(2);
    expect(promptCalls[1]?.opts.userInput).toContain(
      'Your previous output was invalid. Fix the following'
    );
    expect([...fake.state.issues.values()]).toHaveLength(1);
    const createdIssue = [...fake.state.issues.values()][0];
    expect(createdIssue?.title).toBe('Repaired issue title');
    expect(createdIssue?.labels.has('shipper:new')).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  it('exits non-zero and creates no issue when draft validation is exhausted', async () => {
    const { newCommand } = await importCommand();
    fake.scriptRunPrompt(async (name, opts) => {
      promptCalls.push({ name, opts });
      await writeNewDraft(fake.wtPath(), '');
      return 0;
    });

    await expect(
      newCommand(repo, ['my', 'request'], { mode: 'headless' })
    ).resolves.toBeUndefined();

    expect(promptCalls).toHaveLength(3);
    expect([...fake.state.issues.values()]).toHaveLength(0);
    expect(persistNewResultSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[shipper] Invalid new issue draft: Invalid issue draft')
    );
    expect(process.exitCode).toBe(1);
  });

  it('exits non-zero without final result persistence when issue creation fails', async () => {
    fake.stubGh((args) => {
      if (args[0] === 'issue' && args[1] === 'create') {
        throw fake.makeGhError(args, {
          stderr: 'GraphQL: Resource not accessible by integration',
          code: 1,
        });
      }

      return undefined;
    });
    const { newCommand } = await importCommand();

    await expect(
      newCommand(repo, ['my', 'request'], { mode: 'headless' })
    ).resolves.toBeUndefined();

    expect([...fake.state.issues.values()]).toHaveLength(0);
    await expect(
      readFile(path.join(fake.wtPath(), '.shipper/output/result.json'), 'utf-8')
    ).resolves.toContain('"issue_draft"');
    expect(persistNewResultSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('GraphQL: Resource not accessible by integration')
    );
    expect(process.exitCode).toBe(1);
  });

  it('surfaces base-branch resolution failures without falling back to the caller checkout', async () => {
    const withWorktreeSpy = vi.spyOn(core, 'withWorktree');
    vi.spyOn(core, 'resolveBaseBranch').mockRejectedValueOnce(new Error('offline'));
    const { newCommand } = await importCommand();

    await expect(newCommand(repo, ['my', 'request'])).rejects.toThrow('offline');

    expect(withWorktreeSpy).not.toHaveBeenCalled();
    expect(promptCalls).toEqual([]);
  });

  it('attempts branch cleanup after a successful prompt run', async () => {
    vi.spyOn(core, 'resolveBaseBranch').mockResolvedValueOnce('main');
    const withStageHooksSpy = vi.spyOn(core, 'withStageHooks');
    const { newCommand } = await importCommand();

    await expect(newCommand(repo, ['my', 'request'])).resolves.toBeUndefined();

    const branchName = withStageHooksSpy.mock.calls[0]?.[1].branchName;
    expect(execFileMock).toHaveBeenCalledWith(
      'git',
      ['branch', '-d', branchName],
      { cwd: fake.repoRoot() },
      expect.any(Function)
    );
  });

  it('attempts branch cleanup after a failing prompt run', async () => {
    vi.spyOn(core, 'resolveBaseBranch').mockResolvedValueOnce('main');
    const withStageHooksSpy = vi.spyOn(core, 'withStageHooks');
    fake.scriptRunPrompt(() => {
      throw new Error('prompt failed');
    });
    const { newCommand } = await importCommand();

    await expect(newCommand(repo, ['my', 'request'])).rejects.toThrow('prompt failed');

    const branchName = withStageHooksSpy.mock.calls[0]?.[1].branchName;
    expect(execFileMock).toHaveBeenCalledWith(
      'git',
      ['branch', '-d', branchName],
      { cwd: fake.repoRoot() },
      expect.any(Function)
    );
  });

  it('regenerates the branch name when a matching local ref already exists', async () => {
    randomBytesMock
      .mockReturnValueOnce(Buffer.from('a3f91c', 'hex'))
      .mockReturnValueOnce(Buffer.from('b4e2d0', 'hex'));
    execFileMock.mockImplementation((_cmd: string, args: string[], ...rest: unknown[]) => {
      const cb = rest[rest.length - 1] as (...cbArgs: unknown[]) => void;
      if (
        args[0] === 'rev-parse' &&
        args[1] === '--verify' &&
        args[2] === 'refs/heads/shipper/new-20260422-023836-a3f91c'
      ) {
        cb(null, '', '');
        return;
      }
      if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2]?.startsWith('refs/heads/')) {
        cb(createExecFileError('branch not found'));
        return;
      }

      cb(null, '', '');
    });
    const withStageHooksSpy = vi.spyOn(core, 'withStageHooks');
    const { newCommand } = await importCommand();

    await expect(newCommand(repo, ['my', 'request'])).resolves.toBeUndefined();

    const branchName = withStageHooksSpy.mock.calls[0]?.[1].branchName;
    expect(branchName).toBe('shipper/new-20260422-023836-b4e2d0');
    expect(execFileMock).toHaveBeenCalledWith(
      'git',
      ['branch', '-d', 'shipper/new-20260422-023836-b4e2d0'],
      { cwd: fake.repoRoot() },
      expect.any(Function)
    );
  });

  it('generates distinct branch names for back-to-back runs in the same second', async () => {
    vi.spyOn(core, 'resolveBaseBranch').mockResolvedValue('main');
    const withStageHooksSpy = vi.spyOn(core, 'withStageHooks');
    randomBytesMock
      .mockReturnValueOnce(Buffer.from('a3f91c', 'hex'))
      .mockReturnValueOnce(Buffer.from('b4e2d0', 'hex'));
    const { newCommand } = await importCommand();

    await expect(newCommand(repo, ['first'])).resolves.toBeUndefined();
    await expect(newCommand(repo, ['second'])).resolves.toBeUndefined();

    const firstBranch = withStageHooksSpy.mock.calls[0]?.[1].branchName;
    const secondBranch = withStageHooksSpy.mock.calls[1]?.[1].branchName;
    expect(firstBranch).toMatch(/^shipper\/new-\d{8}-\d{6}-[a-f0-9]{6}$/);
    expect(secondBranch).toMatch(/^shipper\/new-\d{8}-\d{6}-[a-f0-9]{6}$/);
    expect(firstBranch).not.toBe(secondBranch);
    expect(firstBranch?.slice(0, 'shipper/new-YYYYMMDD-HHMMSS'.length)).toBe(
      secondBranch?.slice(0, 'shipper/new-YYYYMMDD-HHMMSS'.length)
    );
  });
});
