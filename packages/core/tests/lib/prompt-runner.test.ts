import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

type PromptStdout = EventEmitter & {
  pipe: (destination: EventEmitter) => EventEmitter;
  resume: () => void;
  unpipe: (destination?: EventEmitter) => EventEmitter;
};

type MockLogStream = EventEmitter & {
  chunks: string[];
  end: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
};

type PromptStdin = EventEmitter & {
  end: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
};

type PromptChild = EventEmitter & {
  kill?: ReturnType<typeof vi.fn>;
  stdin?: PromptStdin;
  stderr?: EventEmitter;
  stdout?: PromptStdout;
};

const spawnMock =
  vi.fn<(command: string, args?: string[], options?: Record<string, unknown>) => PromptChild>();
const execFileSyncMock =
  vi.fn<(command: string, args?: string[], options?: Record<string, unknown>) => void>();
const readFileMock = vi.fn<(path: string, encoding: string) => Promise<string>>();
const copyFileMock = vi.fn<(source: string, destination: string) => Promise<void>>();
const mkdirMock = vi.fn<(path: string, options?: Record<string, unknown>) => Promise<void>>();
const statSyncMock = vi.fn<(path: string) => unknown>();
const createWriteStreamMock = vi.fn<(path: string) => MockLogStream>();
const readFileSyncMock = vi.fn<(path: string, encoding: string) => string>();
const fetchIssueMock = vi.fn<(repo: string, issueRef: string) => Promise<string>>();
const fetchPRMock = vi.fn<(repo: string, prRef: string) => Promise<string>>();
const writeContextFileMock =
  vi.fn<(cwd: string, filename: string, content: string) => Promise<void>>();
const resolveSessionRepoMock = vi
  .fn<(opts: { repo?: string; cwd?: string }) => Promise<{ repo: string; repoSlug: string }>>()
  .mockResolvedValue({ repo: 'owner/repo', repoSlug: 'owner-repo' });
const getSessionPathsMock = vi
  .fn<
    (
      repoSlug: string,
      issueRef?: string,
      stage?: string,
      timestamp?: Date
    ) => { logFile: string; metaFile: string; resultFile: string }
  >()
  .mockImplementation((repoSlug, issueRef = 'unlinked', stage = 'test', timestamp = new Date()) => {
    const token = timestamp.toISOString().replace(/[:.]/g, '-');
    const base = `${issueRef}-${stage}-${token}`;
    return {
      logFile: `/home/user/.shipper/sessions/${repoSlug}/${base}.jsonl`,
      metaFile: `/home/user/.shipper/sessions/${repoSlug}/${base}.meta.json`,
      resultFile: `/home/user/.shipper/sessions/${repoSlug}/${base}.result.json`,
    };
  });
const writeSessionMetaMock =
  vi.fn<(metaFile: string, meta: Record<string, unknown>) => Promise<void>>();
const parseAgentUsageMock = vi
  .fn<
    (
      agent: 'claude' | 'codex' | 'copilot',
      logFile: string
    ) => Promise<Record<string, number> | undefined>
  >()
  .mockResolvedValue(undefined);
const formatUsageLineMock = vi
  .fn<(usage: Record<string, number>) => string>()
  .mockReturnValue('Usage: 45 input │ 12 output │ 8 cache read │ 2 cache write tokens');
const driveQuestionBridgeMock = vi.fn(async (opts: { childExit: Promise<number> }) => {
  return await opts.childExit;
});
const resolveAgentMock = vi
  .fn<(promptName: string, agent?: string) => 'claude' | 'codex' | 'copilot'>()
  .mockReturnValue('claude');
const resolveModelMock = vi
  .fn<(promptName: string, model?: string) => string | undefined>()
  .mockReturnValue(undefined);
const resolveModeMock = vi
  .fn<(promptName: string, mode?: string) => string>()
  .mockReturnValue('default');
const resolveDisableMcpMock = vi
  .fn<(promptName: string, disableMcp?: boolean) => boolean>()
  .mockReturnValue(false);
const getSettingsMock = vi.fn<() => { agentTimeoutMinutes: number }>().mockReturnValue({
  agentTimeoutMinutes: 60,
});
const stdinPipeMock = vi.spyOn(process.stdin, 'pipe').mockImplementation(() => undefined as never);
const stdinUnpipeMock = vi.spyOn(process.stdin, 'unpipe').mockImplementation(() => process.stdin);
const stdinPauseMock = vi.spyOn(process.stdin, 'pause').mockImplementation(() => process.stdin);

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => {
      execFileSyncMock(...args);
    },
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    copyFile: (...args: unknown[]) => copyFileMock(...args),
    mkdir: (...args: unknown[]) => mkdirMock(...args),
    readFile: (...args: unknown[]) => readFileMock(...args),
  };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    createWriteStream: (...args: unknown[]) => createWriteStreamMock(...args),
    statSync: (...args: unknown[]) => statSyncMock(...args),
    readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
  };
});

vi.mock('../../src/lib/github.js', () => ({
  fetchIssue: (...args: unknown[]) => fetchIssueMock(...args),
  fetchPR: (...args: unknown[]) => fetchPRMock(...args),
}));

vi.mock('../../src/lib/output-protocol/protocol-io.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/lib/output-protocol/protocol-io.js')
  >('../../src/lib/output-protocol/protocol-io.js');
  return {
    ...actual,
    writeContextFile: (...args: unknown[]) => writeContextFileMock(...args),
  };
});

vi.mock('../../src/lib/settings.js', () => ({
  resolveAgent: (...args: unknown[]) => resolveAgentMock(...args),
  resolveModel: (...args: unknown[]) => resolveModelMock(...args),
  resolveMode: (...args: unknown[]) => resolveModeMock(...args),
  resolveDisableMcp: (...args: unknown[]) => resolveDisableMcpMock(...args),
  getSettings: () => getSettingsMock(),
}));
vi.mock('../../src/lib/prompts.js', () => ({
  agentPrompts: {
    claude: {
      'test.md': '---\ncmd: claude\n---\n\nbundled body',
      'stale.md': '---\ncmd: claude\n---\n\ngh issue edit 248 --add-label "shipper:planned"',
    },
    copilot: {
      'test.md': '---\ncmd: copilot\n---\n\nbundled body',
    },
  },
}));

vi.mock('../../src/lib/session.js', () => ({
  SHIPPER_SESSION_RUN_ID_ENV: 'SHIPPER_SESSION_RUN_ID',
  resolveSessionRepo: (...args: unknown[]) => resolveSessionRepoMock(...args),
  getSessionPaths: (...args: unknown[]) => getSessionPathsMock(...args),
  writeSessionMeta: (...args: unknown[]) => writeSessionMetaMock(...args),
}));

vi.mock('../../src/lib/usage.js', () => ({
  parseAgentUsage: (...args: unknown[]) => parseAgentUsageMock(...args),
  formatUsageLine: (...args: unknown[]) => formatUsageLineMock(...args),
}));

vi.mock('../../src/lib/question-bridge.js', () => ({
  driveQuestionBridge: (...args: unknown[]) => driveQuestionBridgeMock(...args),
}));

function mockSpawnResult(
  opts: {
    code?: number;
    error?: Error;
    logError?: Error;
    stdoutChunks?: string[];
    stderrChunks?: string[];
  } = {}
): void {
  const { code = 0, error, logError, stdoutChunks = [], stderrChunks = [] } = opts;
  spawnMock.mockImplementationOnce(() => {
    const stdout = Object.assign(new EventEmitter(), {
      pipe(destination: EventEmitter) {
        return destination;
      },
      resume() {
        return undefined;
      },
      unpipe(destination?: EventEmitter) {
        void destination;
        return this;
      },
    }) as PromptStdout;
    const stderr = new EventEmitter();
    const child = new EventEmitter() as PromptChild & {
      kill: ReturnType<typeof vi.fn>;
      stdin?: PromptStdin;
      stderr?: EventEmitter;
      stdout?: PromptStdout;
    };
    child.kill = vi.fn();
    child.stdin = Object.assign(new EventEmitter(), {
      end: vi.fn(),
      write: vi.fn(),
    });
    child.stdout = stdout;
    child.stderr = stderr;
    globalThis.queueMicrotask(() => {
      if (error) {
        child.emit('error', error);
        return;
      }
      for (const chunk of stdoutChunks) {
        child.stdout?.emit('data', chunk);
      }
      for (const chunk of stderrChunks) {
        child.stderr?.emit('data', chunk);
      }
      child.stdout?.emit('end');
      if (logError) {
        const logStream = createWriteStreamMock.mock.results.at(-1)?.value as
          | EventEmitter
          | undefined;
        logStream?.emit('error', logError);
      }
      child.emit('close', code);
      globalThis.queueMicrotask(() => {
        if (!logError) {
          const logStream = createWriteStreamMock.mock.results.at(-1)?.value as
            | EventEmitter
            | undefined;
          logStream?.emit('finish');
        }
      });
    });
    return child;
  });
}

const { TRUNCATION_THRESHOLD_BYTES } = await import('../../src/lib/output-protocol/protocol-io.js');
const { SHIPPER_QUESTION_BRIDGE_DIR_ENV, SHIPPER_QUESTION_BRIDGE_TIMEOUT_MS_ENV } =
  await import('../../src/lib/defer-bridge.js');
const { withLogCapture } = await import('../../src/lib/logger.js');
const { buildPromptCommand, runPrompt } = await import('../../src/lib/prompt-runner.js');

function makePrompt(
  cmd: 'claude' | 'codex' | 'copilot',
  args: string[] = [],
  body = 'prompt body'
): string {
  const lines = ['---', `cmd: ${cmd}`];
  if (args.length > 0) {
    lines.push('args:');
    for (const arg of args) {
      lines.push(`  - ${arg}`);
    }
  }
  lines.push('---', '', body);
  return lines.join('\n');
}

function spawnedArgs(): string[] {
  return spawnMock.mock.calls[0]?.[1] ?? [];
}

function spawnedOptions(): Record<string, unknown> | undefined {
  return spawnMock.mock.calls[0]?.[2];
}

function spawnedChild(): PromptChild {
  const child = spawnMock.mock.results[0]?.value as unknown;
  if (!(child instanceof EventEmitter)) {
    throw new Error('Expected spawn to return a child process.');
  }
  return child as PromptChild;
}

function oversizedContent(char: string): string {
  return char.repeat(TRUNCATION_THRESHOLD_BYTES + 1);
}

function makeTimeoutChild(): PromptChild & {
  kill: ReturnType<typeof vi.fn>;
  finishLog: () => void;
} {
  const stdout = Object.assign(new EventEmitter(), {
    pipe(destination: EventEmitter) {
      return destination;
    },
    resume() {
      return undefined;
    },
    unpipe(destination?: EventEmitter) {
      void destination;
      return this;
    },
  }) as PromptStdout;
  const stderr = new EventEmitter();

  return Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    kill: vi.fn(),
    finishLog() {
      stdout.emit('end');
    },
  });
}

function makeLogStream(): MockLogStream {
  const stream = new EventEmitter() as MockLogStream;
  stream.chunks = [];
  stream.write = vi.fn((chunk: string | Buffer) => {
    stream.chunks.push(chunk.toString());
    return true;
  });
  stream.end = vi.fn(() => {
    stream.emit('finish');
    return stream;
  });
  return stream;
}

createWriteStreamMock.mockImplementation(() => makeLogStream());

afterEach(() => {
  vi.clearAllMocks();
  spawnMock.mockReset();
  readFileMock.mockReset();
  copyFileMock.mockReset();
  mkdirMock.mockReset();
  statSyncMock.mockReset();
  createWriteStreamMock.mockReset();
  readFileSyncMock.mockReset();
  execFileSyncMock.mockReset();
  execFileSyncMock.mockImplementation(() => {});
  resolveAgentMock.mockReturnValue('claude');
  resolveModelMock.mockReturnValue(undefined);
  resolveModeMock.mockReturnValue('default');
  resolveDisableMcpMock.mockReturnValue(false);
  getSettingsMock.mockReturnValue({ agentTimeoutMinutes: 60 });
  fetchIssueMock.mockResolvedValue('issue body');
  fetchPRMock.mockResolvedValue('pr body');
  writeContextFileMock.mockReset();
  writeContextFileMock.mockResolvedValue(undefined);
  resolveSessionRepoMock.mockResolvedValue({ repo: 'owner/repo', repoSlug: 'owner-repo' });
  writeSessionMetaMock.mockResolvedValue(undefined);
  parseAgentUsageMock.mockReset();
  parseAgentUsageMock.mockResolvedValue(undefined);
  formatUsageLineMock.mockReset();
  formatUsageLineMock.mockReturnValue(
    'Usage: 45 input │ 12 output │ 8 cache read │ 2 cache write tokens'
  );
  driveQuestionBridgeMock.mockReset();
  driveQuestionBridgeMock.mockImplementation(async (opts: { childExit: Promise<number> }) => {
    return await opts.childExit;
  });
  statSyncMock.mockImplementation(() => {
    throw new Error('ENOENT');
  });
  readFileSyncMock.mockReset();
  mkdirMock.mockResolvedValue(undefined);
  copyFileMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  createWriteStreamMock.mockImplementation(() => makeLogStream());
});

describe('runPrompt', () => {
  it('uses --append-system-prompt for claude prompts', async () => {
    readFileMock.mockResolvedValueOnce(['---', 'cmd: claude', '---', '', 'prompt body'].join('\n'));
    mockSpawnResult();

    await expect(runPrompt('test', {})).resolves.toBe(0);

    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain('--append-system-prompt');
    expect(args).toContain('prompt body');
  });

  it('passes the prompt body as a positional argument for codex', async () => {
    resolveAgentMock.mockReturnValue('codex');
    readFileMock.mockResolvedValueOnce(['---', 'cmd: codex', '---', '', 'prompt body'].join('\n'));
    mockSpawnResult();

    await expect(runPrompt('test', {})).resolves.toBe(0);

    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).not.toContain('--append-system-prompt');
    expect(args).toContain('prompt body');
  });

  it('passes the prompt body through stdin for copilot default mode', async () => {
    resolveAgentMock.mockReturnValue('copilot');
    readFileMock.mockResolvedValueOnce(
      ['---', 'cmd: copilot', '---', '', 'prompt body'].join('\n')
    );
    mockSpawnResult();

    await expect(runPrompt('test', {})).resolves.toBe(0);

    expect(execFileSyncMock).toHaveBeenCalledWith('copilot', ['--version'], { stdio: 'ignore' });
    expect(spawnedArgs()).toEqual([]);
    expect(spawnedOptions()).toMatchObject({
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    expect(spawnedChild().stdin?.write).toHaveBeenCalledWith('prompt body\n');
    expect(stdinPipeMock).toHaveBeenCalledWith(spawnedChild().stdin);
    expect(stdinUnpipeMock).toHaveBeenCalledWith(spawnedChild().stdin);
    expect(stdinPauseMock).toHaveBeenCalled();
    expect(parseAgentUsageMock).not.toHaveBeenCalled();
  });

  it('reads the prompt from the resolved agent subdirectory', async () => {
    readFileMock.mockResolvedValueOnce(['---', 'cmd: claude', '---', '', 'prompt body'].join('\n'));
    mockSpawnResult();

    await runPrompt('test', {});

    expect(readFileMock).toHaveBeenCalledWith(
      path.resolve('.shipper', 'prompts', 'claude', 'test.md'),
      'utf-8'
    );
    expect(resolveAgentMock).toHaveBeenCalledWith('test', undefined);
    expect(resolveModelMock).toHaveBeenCalledWith('test', undefined);
    expect(resolveDisableMcpMock).toHaveBeenCalledWith('test', undefined);
    expect(resolveModeMock).toHaveBeenCalledWith('test', undefined);
  });

  it('replaces {{BASE_BRANCH}} when provided', async () => {
    readFileMock.mockResolvedValueOnce(
      ['---', 'cmd: claude', '---', '', 'git rebase origin/{{BASE_BRANCH}}'].join('\n')
    );
    mockSpawnResult();

    await runPrompt('test', { baseBranch: 'develop' });

    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain('git rebase origin/develop');
  });

  it('offloads fetched issue text to a context file when it exceeds the threshold', async () => {
    readFileMock.mockResolvedValueOnce(
      ['---', 'cmd: claude', 'append-issue: true', '---', '', 'prompt body'].join('\n')
    );
    const issueContent = oversizedContent('i');
    fetchIssueMock.mockResolvedValueOnce(issueContent);

    const command = await buildPromptCommand('test', { repo: 'owner/repo', issueRef: '42' });

    expect(writeContextFileMock).toHaveBeenCalledWith(process.cwd(), 'issue-42.md', issueContent);
    expect(command.args.at(-1)).toContain('.shipper/input/issue-42.md');
    expect(command.args.at(-1)).toContain('Read this file to access the complete issue');
    expect(command.args.at(-1)).not.toContain(issueContent);
    expect(fetchIssueMock).toHaveBeenCalledWith('owner/repo', '42');
    expect(fetchPRMock).not.toHaveBeenCalled();
  });

  it('offloads fetched PR text to a context file when it exceeds the threshold', async () => {
    readFileMock.mockResolvedValueOnce(
      ['---', 'cmd: claude', 'append-pr: true', '---', '', 'prompt body'].join('\n')
    );
    const prContent = oversizedContent('r');
    fetchPRMock.mockResolvedValueOnce(prContent);

    const command = await buildPromptCommand('test', { repo: 'owner/repo', prRef: '5' });

    expect(writeContextFileMock).toHaveBeenCalledWith(process.cwd(), 'pr-5.md', prContent);
    expect(command.args.at(-1)).toContain('.shipper/input/pr-5.md');
    expect(command.args.at(-1)).toContain('Read this file to access the complete PR');
    expect(command.args.at(-1)).not.toContain(prContent);
    expect(fetchIssueMock).not.toHaveBeenCalled();
    expect(fetchPRMock).toHaveBeenCalledWith('owner/repo', '5');
  });

  it('keeps fetched issue and PR text inline when both stay under the threshold', async () => {
    readFileMock.mockResolvedValueOnce(
      [
        '---',
        'cmd: claude',
        'append-issue: true',
        'append-pr: true',
        '---',
        '',
        'prompt body',
      ].join('\n')
    );
    fetchIssueMock.mockResolvedValueOnce('issue details');
    fetchPRMock.mockResolvedValueOnce('pr details');

    const command = await buildPromptCommand('test', {
      repo: 'owner/repo',
      issueRef: '42',
      prRef: '5',
    });

    expect(command.args.at(-1)).toBe('issue details\n\n---\n\npr details');
    expect(writeContextFileMock).not.toHaveBeenCalled();
    expect(fetchIssueMock).toHaveBeenCalledWith('owner/repo', '42');
    expect(fetchPRMock).toHaveBeenCalledWith('owner/repo', '5');
  });

  it('appends user input as a trailing argument for claude prompts', async () => {
    readFileMock.mockResolvedValueOnce(['---', 'cmd: claude', '---', '', 'prompt body'].join('\n'));
    mockSpawnResult();

    await expect(runPrompt('test', { userInput: 'resolve the merge conflict' })).resolves.toBe(0);

    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args.at(-1)).toBe('resolve the merge conflict');
  });

  it('appends user input into the combined prompt body for codex prompts', async () => {
    resolveAgentMock.mockReturnValue('codex');
    readFileMock.mockResolvedValueOnce(['---', 'cmd: codex', '---', '', 'prompt body'].join('\n'));
    mockSpawnResult();

    await expect(runPrompt('test', { userInput: 'resolve the merge conflict' })).resolves.toBe(0);

    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain('prompt body\n\n---\n\nresolve the merge conflict');
  });

  it('appends user input into the combined prompt body for copilot prompts', async () => {
    resolveAgentMock.mockReturnValue('copilot');
    readFileMock.mockResolvedValueOnce(
      ['---', 'cmd: copilot', '---', '', 'prompt body'].join('\n')
    );
    mockSpawnResult();

    await expect(runPrompt('test', { userInput: 'resolve the merge conflict' })).resolves.toBe(0);

    expect(spawnedArgs()).toEqual([]);
    expect(spawnedChild().stdin?.write).toHaveBeenCalledWith(
      'prompt body\n\n---\n\nresolve the merge conflict\n'
    );
  });

  it('keeps oversized issue and PR payloads under the budget by offloading them', async () => {
    const promptBody = 'p'.repeat(40_000);
    readFileMock.mockResolvedValueOnce(
      ['---', 'cmd: claude', 'append-issue: true', 'append-pr: true', '---', '', promptBody].join(
        '\n'
      )
    );
    const issueContent = oversizedContent('i');
    const prContent = oversizedContent('r');
    fetchIssueMock.mockResolvedValueOnce(issueContent);
    fetchPRMock.mockResolvedValueOnce(prContent);

    await expect(
      buildPromptCommand('test', {
        repo: 'owner/repo',
        issueRef: '42',
        prRef: '5',
        userInput: 'keep user input inline',
      })
    ).resolves.toMatchObject({
      command: 'claude',
    });

    expect(writeContextFileMock).toHaveBeenNthCalledWith(
      1,
      process.cwd(),
      'issue-42.md',
      issueContent
    );
    expect(writeContextFileMock).toHaveBeenNthCalledWith(2, process.cwd(), 'pr-5.md', prContent);
  });

  it('throws from buildPromptCommand when non-offloaded prompt inputs exceed the budget', async () => {
    const promptBody = 'p'.repeat(120_000);
    readFileMock.mockResolvedValueOnce(['---', 'cmd: claude', '---', '', promptBody].join('\n'));

    await expect(
      buildPromptCommand('test', {
        userInput: 'u'.repeat(90_000),
      })
    ).rejects.toThrow(/Total prompt input size \(\d+ bytes\) exceeds the 200000-byte budget/);
  });

  it('returns 1 and does not spawn when non-offloaded prompt inputs exceed the budget', async () => {
    const promptBody = 'p'.repeat(120_000);
    readFileMock.mockResolvedValueOnce(['---', 'cmd: claude', '---', '', promptBody].join('\n'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      runPrompt('test', {
        userInput: 'u'.repeat(90_000),
      })
    ).resolves.toBe(1);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /\[shipper\] Error: Total prompt input size \(\d+ bytes\) exceeds the 200000-byte budget/
      )
    );
    expect(spawnMock).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('still spawns when combined prompt inputs stay within the budget', async () => {
    const promptBody = 'p'.repeat(20_000);
    readFileMock.mockResolvedValueOnce(
      ['---', 'cmd: claude', 'append-issue: true', 'append-pr: true', '---', '', promptBody].join(
        '\n'
      )
    );
    fetchIssueMock.mockResolvedValueOnce('i'.repeat(20_000));
    fetchPRMock.mockResolvedValueOnce('r'.repeat(20_000));
    mockSpawnResult();

    await expect(
      runPrompt('test', {
        repo: 'owner/repo',
        issueRef: '42',
        prRef: '5',
        userInput: 'u'.repeat(20_000),
      })
    ).resolves.toBe(0);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnedArgs()).toContain(promptBody);
    expect(spawnedArgs()).toContain(
      `${'i'.repeat(20_000)}\n\n---\n\n${'r'.repeat(20_000)}\n\n---\n\n${'u'.repeat(20_000)}`
    );
  });

  it('uses the worktree cwd for offloaded context files and agent spawn', async () => {
    readFileMock.mockResolvedValueOnce(
      ['---', 'cmd: claude', 'append-issue: true', '---', '', 'prompt body'].join('\n')
    );
    const issueContent = oversizedContent('i');
    fetchIssueMock.mockResolvedValueOnce(issueContent);
    mockSpawnResult();

    await expect(
      runPrompt('test', {
        repo: 'owner/repo',
        issueRef: '42',
        cwd: '/tmp/wt',
        userInput: 'keep this inline',
      })
    ).resolves.toBe(0);

    expect(writeContextFileMock).toHaveBeenCalledWith('/tmp/wt', 'issue-42.md', issueContent);
    expect(spawnedOptions()).toMatchObject({ cwd: '/tmp/wt' });
    expect(spawnedArgs().at(-1)).toContain('.shipper/input/issue-42.md');
    expect(spawnedArgs().at(-1)).toContain('keep this inline');
    expect(spawnedArgs().at(-1)).not.toContain(issueContent);
    expect(writeContextFileMock).toHaveBeenCalledTimes(1);
  });

  it('returns 1 when appended issue or PR context is requested without a repo', async () => {
    readFileMock.mockResolvedValueOnce(
      [
        '---',
        'cmd: claude',
        'append-issue: true',
        'append-pr: true',
        '---',
        '',
        'prompt body',
      ].join('\n')
    );

    await expect(runPrompt('test', { issueRef: '42', prRef: '5' })).resolves.toBe(1);
  });

  it('returns 1 when the resolved agent does not match frontmatter', async () => {
    readFileMock.mockResolvedValueOnce(['---', 'cmd: codex', '---', '', 'prompt body'].join('\n'));

    await expect(runPrompt('test', {})).resolves.toBe(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('uses the bundled fallback when no local file exists', async () => {
    readFileMock.mockRejectedValueOnce(new Error('ENOENT'));
    mockSpawnResult();

    await expect(runPrompt('test', {})).resolves.toBe(0);

    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain('bundled body');
  });

  it('warns once for a local override prompt with gh mutation commands and still spawns', async () => {
    readFileMock.mockResolvedValueOnce(
      ['---', 'cmd: claude', '---', '', 'gh issue edit 248 --add-label "shipper:planned"'].join(
        '\n'
      )
    );
    const warnMock = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockSpawnResult();

    await expect(runPrompt('test', {})).resolves.toBe(0);

    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock).toHaveBeenCalledWith(
      "[shipper] Warning: Ejected prompt 'test' contains gh commands for state mutations.\nThese are now handled by shipper. Re-eject with 'shipper eject test' or manually update."
    );
    expect(spawnMock).toHaveBeenCalled();
    warnMock.mockRestore();
  });

  it('includes gh issue create in generic local override mutation detection', async () => {
    readFileMock.mockResolvedValueOnce(
      ['---', 'cmd: claude', '---', '', 'gh issue create --title "New issue"'].join('\n')
    );
    const warnMock = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockSpawnResult();

    await expect(runPrompt('test-create', {})).resolves.toBe(0);

    expect(warnMock).toHaveBeenCalledWith(
      "[shipper] Warning: Ejected prompt 'test-create' contains gh commands for state mutations.\nThese are now handled by shipper. Re-eject with 'shipper eject test-create' or manually update."
    );
    warnMock.mockRestore();
  });

  it('warns for local new overrides that still write temporary issue bodies', async () => {
    readFileMock.mockResolvedValueOnce(
      ['---', 'cmd: claude', '---', '', 'Write .shipper/tmp/issue-<timestamp>.md'].join('\n')
    );
    const warnMock = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockSpawnResult();

    await expect(runPrompt('new', {})).resolves.toBe(0);

    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock).toHaveBeenCalledWith(
      expect.stringContaining("Ejected prompt 'new' uses the old issue-creation contract")
    );
    expect(warnMock).toHaveBeenCalledWith(
      expect.stringContaining('.shipper/output/issue-draft.json')
    );
    expect(spawnMock).toHaveBeenCalled();
    warnMock.mockRestore();
  });

  it('warns for local new overrides that emit created_issue directly', async () => {
    resolveAgentMock.mockReturnValue('codex');
    readFileMock.mockResolvedValueOnce(
      ['---', 'cmd: codex', '---', '', '{ "created_issue": { "number": 42 } }'].join('\n')
    );
    const warnMock = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockSpawnResult();

    await expect(runPrompt('new', {})).resolves.toBe(0);

    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock).toHaveBeenCalledWith(
      expect.stringContaining("Ejected prompt 'new' uses the old issue-creation contract")
    );
    expect(spawnMock).toHaveBeenCalled();
    warnMock.mockRestore();
  });

  it('does not also emit the generic mutation warning for old local new overrides', async () => {
    resolveAgentMock.mockReturnValue('copilot');
    readFileMock.mockResolvedValueOnce(
      ['---', 'cmd: copilot', '---', '', 'Run gh issue create after drafting.'].join('\n')
    );
    const warnMock = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockSpawnResult();

    await expect(runPrompt('new', {})).resolves.toBe(0);

    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock.mock.calls[0]?.[0]).toContain(
      "Ejected prompt 'new' uses the old issue-creation contract"
    );
    expect(warnMock.mock.calls[0]?.[0]).not.toContain('contains gh commands for state mutations');
    warnMock.mockRestore();
  });

  it('warns only once per process for the same local override prompt', async () => {
    readFileMock.mockResolvedValue(
      ['---', 'cmd: claude', '---', '', 'gh issue edit 248 --add-label "shipper:planned"'].join(
        '\n'
      )
    );
    const warnMock = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockSpawnResult();
    mockSpawnResult();

    await expect(runPrompt('warn-once', {})).resolves.toBe(0);
    await expect(runPrompt('warn-once', {})).resolves.toBe(0);

    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    warnMock.mockRestore();
  });

  it('does not warn for bundled fallback prompts with gh mutation commands', async () => {
    readFileMock.mockRejectedValueOnce(new Error('ENOENT'));
    const warnMock = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockSpawnResult();

    await expect(runPrompt('stale', {})).resolves.toBe(0);

    expect(warnMock).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalled();
    warnMock.mockRestore();
  });

  it('returns 1 when neither a local nor bundled prompt exists', async () => {
    readFileMock.mockRejectedValueOnce(new Error('ENOENT'));

    await expect(runPrompt('missing', {})).resolves.toBe(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('returns 1 when spawning the agent fails', async () => {
    readFileMock.mockResolvedValueOnce(['---', 'cmd: claude', '---', '', 'prompt body'].join('\n'));
    mockSpawnResult({ error: new Error('spawn failed') });

    await expect(runPrompt('test', {})).resolves.toBe(1);
  });

  it('passes --model for claude when a model is resolved', async () => {
    resolveModelMock.mockReturnValue('opus');
    readFileMock.mockResolvedValueOnce(makePrompt('claude'));
    mockSpawnResult();

    await expect(runPrompt('test', { model: 'sonnet' })).resolves.toBe(0);

    expect(spawnedArgs()).toEqual(['--model', 'opus', '--append-system-prompt', 'prompt body']);
  });

  it('passes -m before exec for codex when a model is resolved', async () => {
    resolveAgentMock.mockReturnValue('codex');
    resolveModeMock.mockReturnValue('headless');
    resolveModelMock.mockReturnValue('gpt-5');
    readFileMock.mockResolvedValueOnce(makePrompt('codex'));
    mockSpawnResult();

    await expect(runPrompt('test', { model: 'gpt-5' })).resolves.toBe(0);

    expect(spawnedArgs().slice(0, 7)).toEqual([
      '-m',
      'gpt-5',
      'exec',
      '--full-auto',
      '--json',
      '-c',
      'sandbox_workspace_write.network_access=true',
    ]);
  });

  it('does not add a model flag when no model is resolved', async () => {
    resolveAgentMock.mockReturnValue('codex');
    readFileMock.mockResolvedValueOnce(makePrompt('codex'));
    mockSpawnResult();

    await expect(runPrompt('test', {})).resolves.toBe(0);

    expect(spawnedArgs()).not.toContain('-m');
    expect(spawnedArgs()).not.toContain('--model');
  });

  it('passes --model for copilot when a model is resolved', async () => {
    resolveAgentMock.mockReturnValue('copilot');
    resolveModelMock.mockReturnValue('gpt-5');
    readFileMock.mockResolvedValueOnce(makePrompt('copilot'));
    mockSpawnResult();

    await expect(runPrompt('test', { model: 'gpt-5' })).resolves.toBe(0);

    expect(spawnedArgs()).toEqual(['--model', 'gpt-5']);
    expect(spawnedChild().stdin?.write).toHaveBeenCalledWith('prompt body\n');
  });

  it('does not add a model flag for copilot when no model is resolved', async () => {
    resolveAgentMock.mockReturnValue('copilot');
    readFileMock.mockResolvedValueOnce(makePrompt('copilot'));
    mockSpawnResult();

    await expect(runPrompt('test', {})).resolves.toBe(0);

    expect(spawnedArgs()).toEqual([]);
    expect(spawnedChild().stdin?.write).toHaveBeenCalledWith('prompt body\n');
    expect(spawnedArgs()).not.toContain('--model');
  });

  it('injects -p for claude headless mode when absent', async () => {
    resolveModeMock.mockReturnValue('headless');
    readFileMock.mockResolvedValueOnce(makePrompt('claude', ['--model', 'opus']));
    mockSpawnResult();

    await runPrompt('test', { mode: 'headless' });

    expect(spawnedArgs().slice(0, 3)).toEqual(['-p', '--model', 'opus']);
    expect(spawnedArgs()).toContain('--verbose');
    expect(spawnedArgs()).toContain('--output-format');
    expect(spawnedArgs()).toContain('stream-json');
  });

  it('does not duplicate -p for claude headless mode when already present', async () => {
    resolveModeMock.mockReturnValue('headless');
    readFileMock.mockResolvedValueOnce(makePrompt('claude', ['-p', '--model', 'opus']));
    mockSpawnResult();

    await runPrompt('test', { mode: 'headless' });

    expect(spawnedArgs().filter((arg) => arg === '-p')).toHaveLength(1);
    expect(spawnedArgs().filter((arg) => arg === '--verbose')).toHaveLength(1);
    expect(spawnedArgs().filter((arg) => arg === '--output-format')).toHaveLength(1);
  });

  it('strips -p for claude interactive mode', async () => {
    resolveModeMock.mockReturnValue('interactive');
    readFileMock.mockResolvedValueOnce(makePrompt('claude', ['-p', '--model', 'opus']));
    mockSpawnResult();

    await runPrompt('test', { mode: 'interactive' });

    expect(spawnedArgs()).not.toContain('-p');
    expect(spawnedArgs()).toContain('--model');
  });

  it('leaves frontmatter args unchanged for default mode', async () => {
    resolveModeMock.mockReturnValue('default');
    readFileMock.mockResolvedValueOnce(makePrompt('claude', ['--model', 'opus']));
    mockSpawnResult();

    await runPrompt('test', { mode: 'default' });

    expect(spawnedArgs().slice(0, 2)).toEqual(['--model', 'opus']);
  });

  it('passes the CLI disableMcp override into the settings resolver', async () => {
    readFileMock.mockResolvedValueOnce(makePrompt('claude'));
    mockSpawnResult();

    await runPrompt('groom', { disableMcp: true });

    expect(resolveDisableMcpMock).toHaveBeenCalledWith('groom', true);
  });

  it('strips claude MCP frontmatter args and reapplies the shipper policy', async () => {
    resolveDisableMcpMock.mockReturnValue(true);
    readFileMock.mockResolvedValueOnce(
      makePrompt('claude', [
        '--strict-mcp-config',
        '--mcp-config',
        '{"mcpServers":{"old":{}}}',
        '--model',
        'opus',
      ])
    );
    mockSpawnResult();

    await runPrompt('test', {});

    expect(spawnedArgs()).toEqual([
      '--model',
      'opus',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--append-system-prompt',
      'prompt body',
    ]);
  });

  it('preserves claude MCP frontmatter args when MCP remains enabled', async () => {
    readFileMock.mockResolvedValueOnce(
      makePrompt('claude', [
        '--strict-mcp-config',
        '--mcp-config',
        '{"mcpServers":{"kept":{}}}',
        '--model',
        'opus',
      ])
    );
    mockSpawnResult();

    await runPrompt('test', {});

    expect(spawnedArgs()).toEqual([
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{"kept":{}}}',
      '--model',
      'opus',
      '--append-system-prompt',
      'prompt body',
    ]);
  });

  it('does not strip the next flag when a claude MCP value is missing', async () => {
    resolveDisableMcpMock.mockReturnValue(true);
    readFileMock.mockResolvedValueOnce(makePrompt('claude', ['--mcp-config', '--model', 'opus']));
    mockSpawnResult();

    await runPrompt('test', {});

    expect(spawnedArgs()).toEqual([
      '--model',
      'opus',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--append-system-prompt',
      'prompt body',
    ]);
  });

  it('strips only codex MCP config overrides and preserves unrelated -c args', async () => {
    resolveAgentMock.mockReturnValue('codex');
    resolveDisableMcpMock.mockReturnValue(true);
    readFileMock.mockResolvedValueOnce(
      makePrompt('codex', [
        '-c',
        'sandbox_workspace_write.network_access=true',
        '--config',
        'mcp_servers={"old":{}}',
        'exec',
      ])
    );
    mockSpawnResult();

    await runPrompt('test', {});

    expect(spawnedArgs()).toContain('-c');
    expect(spawnedArgs()).toContain('sandbox_workspace_write.network_access=true');
    expect(spawnedArgs().filter((arg) => arg === 'mcp_servers={}')).toHaveLength(1);
    expect(spawnedArgs()).not.toContain('mcp_servers={"old":{}}');
  });

  it('preserves codex MCP frontmatter args when MCP remains enabled', async () => {
    resolveAgentMock.mockReturnValue('codex');
    readFileMock.mockResolvedValueOnce(
      makePrompt('codex', ['-c', 'mcp_servers={"kept":{}}', 'exec'])
    );
    mockSpawnResult();

    await runPrompt('test', {});

    expect(spawnedArgs()).toContain('mcp_servers={"kept":{}}');
    expect(spawnedArgs()).not.toContain('mcp_servers={}');
  });

  it('strips copilot MCP frontmatter args and disables discovered MCP servers', async () => {
    const promptPath = path.resolve('.shipper', 'prompts', 'copilot', 'test.md');
    resolveAgentMock.mockReturnValue('copilot');
    resolveDisableMcpMock.mockReturnValue(true);
    readFileMock.mockImplementation((filepath: string) => {
      if (filepath === promptPath) {
        return makePrompt('copilot', [
          '--config-dir',
          '/tmp/copilot-config',
          '--disable-builtin-mcps',
          '--disable-mcp-server',
          'frontmatter-server',
          '--additional-mcp-config',
          '@ignored.json',
        ]);
      }
      if (filepath === path.join('/repo', '.mcp.json')) {
        return '{"mcpServers":{"repo-one":{},"shared":{}}}';
      }
      if (filepath === path.join('/repo', '.github', 'mcp.json')) {
        return '{"mcpServers":{"shared":{},"repo-two":{}}}';
      }
      if (filepath === path.join('/tmp/copilot-config', 'mcp-config.json')) {
        return '{"mcpServers":{"user-one":{},"shared":{}}}';
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockSpawnResult();

    await runPrompt('test', { cwd: '/repo' });

    expect(spawnedArgs()).toContain('--config-dir');
    expect(spawnedArgs()).toContain('/tmp/copilot-config');
    expect(spawnedArgs()).toContain('--disable-builtin-mcps');
    expect(spawnedArgs()).not.toContain('frontmatter-server');
    expect(spawnedArgs()).not.toContain('--additional-mcp-config');
    expect(spawnedArgs().filter((arg) => arg === '--disable-mcp-server')).toHaveLength(4);
    expect(spawnedArgs()).toContain('repo-one');
    expect(spawnedArgs()).toContain('shared');
    expect(spawnedArgs()).toContain('repo-two');
    expect(spawnedArgs()).toContain('user-one');
    expect(spawnedChild().stdin?.write).toHaveBeenCalledWith('prompt body\n');
  });

  it('preserves copilot MCP frontmatter args when MCP remains enabled', async () => {
    resolveAgentMock.mockReturnValue('copilot');
    readFileMock.mockResolvedValueOnce(
      makePrompt('copilot', [
        '--additional-mcp-config',
        '@kept.json',
        '--disable-mcp-server',
        'kept-server',
      ])
    );
    mockSpawnResult();

    await runPrompt('test', {});

    expect(spawnedArgs()).toContain('--additional-mcp-config');
    expect(spawnedArgs()).toContain('@kept.json');
    expect(spawnedArgs()).toContain('--disable-mcp-server');
    expect(spawnedArgs()).toContain('kept-server');
    expect(spawnedArgs()).not.toContain('--disable-builtin-mcps');
  });

  it('warns and continues when a copilot MCP config file is malformed', async () => {
    const promptPath = path.resolve('.shipper', 'prompts', 'copilot', 'test.md');
    const warnMock = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveAgentMock.mockReturnValue('copilot');
    resolveDisableMcpMock.mockReturnValue(true);
    readFileMock.mockImplementation((filepath: string) => {
      if (filepath === promptPath) {
        return makePrompt('copilot', ['--config-dir', '/tmp/copilot-config']);
      }
      if (filepath === path.join('/tmp/copilot-config', 'mcp-config.json')) {
        return '{bad json';
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockSpawnResult();

    await expect(runPrompt('test', { cwd: '/repo' })).resolves.toBe(0);

    expect(warnMock).toHaveBeenCalledWith(
      expect.stringContaining('[shipper] Warning: Failed to parse Copilot MCP config')
    );
    expect(spawnedArgs()).toContain('--disable-builtin-mcps');
    warnMock.mockRestore();
  });

  it('falls back to the default copilot config dir when --config-dir has no value', async () => {
    const promptPath = path.resolve('.shipper', 'prompts', 'copilot', 'test.md');
    resolveAgentMock.mockReturnValue('copilot');
    resolveDisableMcpMock.mockReturnValue(true);
    readFileMock.mockImplementation((filepath: string) => {
      if (filepath === promptPath) {
        return makePrompt('copilot', ['--config-dir', '--model', 'gpt-5']);
      }
      if (filepath === path.join(homedir(), '.copilot', 'mcp-config.json')) {
        return '{"mcpServers":{"user-one":{}}}';
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockSpawnResult();

    await runPrompt('test', { cwd: '/repo' });

    expect(spawnedArgs()).toContain('--model');
    expect(spawnedArgs()).toContain('gpt-5');
    expect(spawnedArgs()).toContain('user-one');
    expect(readFileMock).toHaveBeenCalledWith(
      path.join(homedir(), '.copilot', 'mcp-config.json'),
      'utf-8'
    );
  });

  it('prints exactly one MCP-disabled notice before spawning', async () => {
    const logMock = vi.spyOn(console, 'log').mockImplementation(() => {});
    resolveDisableMcpMock.mockReturnValue(true);
    readFileMock.mockResolvedValueOnce(makePrompt('claude'));
    mockSpawnResult();

    await expect(runPrompt('groom', {})).resolves.toBe(0);

    expect(logMock).toHaveBeenCalledWith('[shipper] MCP loading disabled for stage groom.');
    expect(
      logMock.mock.calls.filter(
        ([line]) => String(line) === '[shipper] MCP loading disabled for stage groom.'
      )
    ).toHaveLength(1);
    logMock.mockRestore();
  });

  it('does not print an MCP notice when MCP remains enabled', async () => {
    const logMock = vi.spyOn(console, 'log').mockImplementation(() => {});
    readFileMock.mockResolvedValueOnce(makePrompt('claude'));
    mockSpawnResult();

    await expect(runPrompt('groom', {})).resolves.toBe(0);

    expect(
      logMock.mock.calls.some(([line]) =>
        String(line).includes('MCP loading disabled for stage groom.')
      )
    ).toBe(false);
    logMock.mockRestore();
  });

  it('injects copilot headless flags when absent', async () => {
    resolveAgentMock.mockReturnValue('copilot');
    resolveModeMock.mockReturnValue('headless');
    readFileMock.mockResolvedValueOnce(makePrompt('copilot'));
    mockSpawnResult();

    await runPrompt('test', { mode: 'headless' });

    expect(spawnedArgs()).toEqual([
      '--autopilot',
      '--allow-all-tools',
      '--allow-all-urls',
      '--no-ask-user',
      '--output-format',
      'json',
      '-p',
      'prompt body',
    ]);
  });

  it('strips copilot headless flags and -p for interactive mode', async () => {
    resolveAgentMock.mockReturnValue('copilot');
    resolveModeMock.mockReturnValue('interactive');
    readFileMock.mockResolvedValueOnce(
      makePrompt('copilot', [
        '-p',
        '--autopilot',
        '--allow-all-tools',
        '--allow-all-urls',
        '--no-ask-user',
      ])
    );
    mockSpawnResult();

    await runPrompt('test', { mode: 'interactive' });

    expect(spawnedArgs()).toEqual([]);
    expect(spawnedChild().stdin?.write).toHaveBeenCalledWith('prompt body\n');
  });

  it('strips copilot headless flags for default mode from prompt frontmatter', async () => {
    resolveAgentMock.mockReturnValue('copilot');
    resolveModeMock.mockReturnValue('default');
    readFileMock.mockResolvedValueOnce(
      makePrompt('copilot', [
        '--autopilot',
        '--allow-all-tools',
        '--allow-all-urls',
        '--no-ask-user',
      ])
    );
    mockSpawnResult();

    await runPrompt('test', {});

    expect(spawnedArgs()).toEqual([]);
    expect(spawnedChild().stdin?.write).toHaveBeenCalledWith('prompt body\n');
  });

  it('returns interactive copilot prompt text as initialInput from buildPromptCommand', async () => {
    resolveAgentMock.mockReturnValue('copilot');
    readFileMock.mockResolvedValueOnce(
      ['---', 'cmd: copilot', 'args:', '  - --autopilot', '---', '', 'prompt body'].join('\n')
    );

    await expect(buildPromptCommand('test', { userInput: 'extra context' })).resolves.toEqual({
      command: 'copilot',
      args: [],
      cwd: undefined,
      initialInput: 'prompt body\n\n---\n\nextra context',
    });
  });

  it('appends user input for prompts that only declare append-issue', async () => {
    readFileMock.mockResolvedValueOnce(
      ['---', 'cmd: claude', 'append-issue: true', '---', '', 'prompt body'].join('\n')
    );
    fetchIssueMock.mockResolvedValueOnce('issue text');

    const command = await buildPromptCommand('test', {
      repo: 'owner/repo',
      issueRef: '42',
      userInput: 'correction',
    });

    expect(command.args.at(-1)).toBe('issue text\n\n---\n\ncorrection');
  });

  it('appends retry correction text for pr_review-shaped prompts without a frontmatter opt-in', async () => {
    readFileMock.mockResolvedValueOnce(
      [
        '---',
        'cmd: claude',
        'append-issue: true',
        'append-pr: true',
        '---',
        '',
        'prompt body',
      ].join('\n')
    );
    fetchIssueMock.mockResolvedValueOnce('issue text');
    fetchPRMock.mockResolvedValueOnce('pr text');

    const command = await buildPromptCommand('pr_review', {
      repo: 'owner/repo',
      issueRef: '42',
      prRef: '5',
      userInput: 'reviewer correction',
    });

    // This guards the retry path that previously dropped correction text unless the prompt opted in.
    expect(command.args.at(-1)).toBe('issue text\n\n---\n\npr text\n\n---\n\nreviewer correction');
  });

  it.each([
    ['omitted', undefined],
    ['empty string', ''],
  ])(
    'preserves the prior issue/PR message when userInput is %s for pr_review-shaped prompts',
    async (_label, userInput) => {
      readFileMock.mockResolvedValueOnce(
        [
          '---',
          'cmd: claude',
          'append-issue: true',
          'append-pr: true',
          '---',
          '',
          'prompt body',
        ].join('\n')
      );
      fetchIssueMock.mockResolvedValueOnce('issue text');
      fetchPRMock.mockResolvedValueOnce('pr text');

      const command = await buildPromptCommand('pr_review', {
        repo: 'owner/repo',
        issueRef: '42',
        prRef: '5',
        userInput,
      });

      expect(command.args.at(-1)).toBe('issue text\n\n---\n\npr text');
    }
  );

  it('captures headless stdout to a session log and writes metadata after exit', async () => {
    resolveModeMock.mockReturnValue('headless');
    readFileMock.mockResolvedValueOnce(makePrompt('claude'));
    mockSpawnResult();

    await expect(
      runPrompt('implement', { mode: 'headless', repo: 'owner/repo', issueRef: '308' })
    ).resolves.toBe(0);

    expect(resolveSessionRepoMock).toHaveBeenCalledWith({ repo: 'owner/repo', cwd: undefined });
    expect(getSessionPathsMock).toHaveBeenCalledWith(
      'owner-repo',
      '308',
      'implement',
      expect.any(Date)
    );
    expect(mkdirMock).toHaveBeenCalledWith('/home/user/.shipper/sessions/owner-repo', {
      recursive: true,
    });
    expect(createWriteStreamMock).toHaveBeenCalledWith(
      expect.stringContaining('/home/user/.shipper/sessions/owner-repo/308-implement-')
    );
    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({
      cwd: undefined,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const env = (spawnedOptions()?.env ?? {}) as Record<string, string>;
    expect(env[SHIPPER_QUESTION_BRIDGE_DIR_ENV]).toContain(
      path.join('.shipper', 'tmp', 'question-bridge-')
    );
    expect(env[SHIPPER_QUESTION_BRIDGE_TIMEOUT_MS_ENV]).toBe(String(60 * 60_000));
    expect(driveQuestionBridgeMock).toHaveBeenCalledOnce();
    const writeMetaCall = writeSessionMetaMock.mock.calls[0];
    expect(writeMetaCall?.[0]).toContain('/home/user/.shipper/sessions/owner-repo/308-implement-');
    expect(writeMetaCall?.[1]).toMatchObject({
      repo: 'owner/repo',
      issue: '308',
      stage: 'implement',
      agent: 'claude',
      model: 'default',
      exitCode: 0,
    });
    expect((writeMetaCall?.[1] as { logFile: string }).logFile).toContain(
      '/home/user/.shipper/sessions/owner-repo/308-implement-'
    );
    expect(parseAgentUsageMock).toHaveBeenCalledWith(
      'claude',
      expect.stringContaining('/home/user/.shipper/sessions/owner-repo/308-implement-')
    );
  });

  it('persists a new result file from the worktree into session storage', async () => {
    resolveModeMock.mockReturnValue('headless');
    readFileMock.mockResolvedValueOnce(makePrompt('claude'));
    copyFileMock.mockResolvedValueOnce(undefined);
    mockSpawnResult();

    await expect(
      runPrompt('new', { mode: 'headless', repo: 'owner/repo', cwd: '/tmp/new-worktree' })
    ).resolves.toBe(0);

    const resultFile = writeSessionMetaMock.mock.calls[0]?.[1].resultFile;
    expect(copyFileMock).toHaveBeenCalledWith(
      '/tmp/new-worktree/.shipper/output/result.json',
      resultFile
    );
    expect(resultFile).toContain('/home/user/.shipper/sessions/owner-repo/unlinked-new-');
    expect(resultFile).toContain('.result.json');
    expect(writeSessionMetaMock).toHaveBeenCalledWith(
      expect.stringContaining('/home/user/.shipper/sessions/owner-repo/unlinked-new-'),
      expect.objectContaining({
        issue: 'unlinked',
        stage: 'new',
        resultFile,
      })
    );
  });

  it('records the inherited session run id in session metadata', async () => {
    const previousRunId = process.env.SHIPPER_SESSION_RUN_ID;
    process.env.SHIPPER_SESSION_RUN_ID = 'mcp-create-issue-run';
    resolveModeMock.mockReturnValue('headless');
    readFileMock.mockResolvedValueOnce(makePrompt('claude'));
    mockSpawnResult();

    try {
      await expect(
        runPrompt('new', { mode: 'headless', repo: 'owner/repo', cwd: '/tmp/new-worktree' })
      ).resolves.toBe(0);

      expect(writeSessionMetaMock.mock.calls[0]?.[1]).toMatchObject({
        issue: 'unlinked',
        stage: 'new',
        runId: 'mcp-create-issue-run',
      });
    } finally {
      if (previousRunId === undefined) {
        delete process.env.SHIPPER_SESSION_RUN_ID;
      } else {
        process.env.SHIPPER_SESSION_RUN_ID = previousRunId;
      }
    }
  });

  it('omits resultFile metadata when the worktree result file is absent', async () => {
    resolveModeMock.mockReturnValue('headless');
    readFileMock.mockResolvedValueOnce(makePrompt('claude'));
    copyFileMock.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const warnMock = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockSpawnResult({ code: 7 });

    await expect(
      runPrompt('new', { mode: 'headless', repo: 'owner/repo', cwd: '/tmp/new-worktree' })
    ).resolves.toBe(7);

    expect(copyFileMock).toHaveBeenCalledWith(
      '/tmp/new-worktree/.shipper/output/result.json',
      expect.stringContaining('/home/user/.shipper/sessions/owner-repo/unlinked-new-')
    );
    expect(warnMock).not.toHaveBeenCalled();
    expect(writeSessionMetaMock.mock.calls[0]?.[1]).toMatchObject({
      exitCode: 7,
      resultFile: undefined,
    });
    warnMock.mockRestore();
  });

  it('warns and omits resultFile metadata when result persistence fails', async () => {
    resolveModeMock.mockReturnValue('headless');
    readFileMock.mockResolvedValueOnce(makePrompt('claude'));
    copyFileMock.mockRejectedValueOnce(new Error('permission denied'));
    const warnMock = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockSpawnResult({ code: 7 });

    await expect(
      runPrompt('new', { mode: 'headless', repo: 'owner/repo', cwd: '/tmp/new-worktree' })
    ).resolves.toBe(7);

    expect(warnMock).toHaveBeenCalledWith(
      '[shipper] Warning: Failed to persist prompt result from /tmp/new-worktree/.shipper/output/result.json: permission denied'
    );
    expect(writeSessionMetaMock.mock.calls[0]?.[1]).toMatchObject({
      exitCode: 7,
      resultFile: undefined,
    });
    warnMock.mockRestore();
  });

  it('captures default-mode non-interactive stdout and persists usage metadata', async () => {
    readFileMock.mockResolvedValueOnce(makePrompt('claude', ['-p']));
    parseAgentUsageMock.mockResolvedValueOnce({
      inputTokens: 45,
      outputTokens: 12,
      cacheReadTokens: 8,
      cacheWriteTokens: 2,
    });
    const logMock = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockSpawnResult();

    await expect(
      runPrompt('implement', { mode: 'default', repo: 'owner/repo', issueRef: '308' })
    ).resolves.toBe(0);

    expect(createWriteStreamMock).toHaveBeenCalledWith(
      expect.stringContaining('/home/user/.shipper/sessions/owner-repo/308-implement-')
    );
    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({
      cwd: undefined,
      env: process.env,
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    expect(spawnedArgs()).toContain('--verbose');
    expect(spawnedArgs()).toContain('--output-format');
    expect(spawnedArgs()).toContain('stream-json');
    expect(spawnedArgs().indexOf('--verbose')).toBeLessThan(
      spawnedArgs().indexOf('--output-format')
    );
    expect(spawnedArgs().indexOf('--output-format')).toBeLessThan(
      spawnedArgs().indexOf('--append-system-prompt')
    );
    expect(parseAgentUsageMock).toHaveBeenCalledWith(
      'claude',
      expect.stringContaining('/home/user/.shipper/sessions/owner-repo/308-implement-')
    );
    expect(writeSessionMetaMock).toHaveBeenCalledWith(
      expect.stringContaining('/home/user/.shipper/sessions/owner-repo/308-implement-'),
      expect.objectContaining({
        repo: 'owner/repo',
        issue: '308',
        stage: 'implement',
        agent: 'claude',
        usage: {
          inputTokens: 45,
          outputTokens: 12,
          cacheReadTokens: 8,
          cacheWriteTokens: 2,
        },
      })
    );

    logMock.mockRestore();
  });

  it('inherits stdio for interactive runs to preserve TTY and avoids usage tracking', async () => {
    resolveModeMock.mockReturnValue('interactive');
    readFileMock.mockResolvedValueOnce(makePrompt('claude'));
    mockSpawnResult();

    await expect(runPrompt('groom', { mode: 'interactive', repo: 'owner/repo' })).resolves.toBe(0);

    expect(resolveSessionRepoMock).toHaveBeenCalledWith({ repo: 'owner/repo', cwd: undefined });
    expect(getSessionPathsMock).toHaveBeenCalledWith(
      'owner-repo',
      undefined,
      'groom',
      expect.any(Date)
    );
    expect(mkdirMock).toHaveBeenCalledWith('/home/user/.shipper/sessions/owner-repo', {
      recursive: true,
    });
    expect(createWriteStreamMock).not.toHaveBeenCalled();
    expect(parseAgentUsageMock).not.toHaveBeenCalled();
    expect(writeSessionMetaMock).toHaveBeenCalledWith(
      expect.stringContaining('/home/user/.shipper/sessions/owner-repo/unlinked-groom-'),
      expect.objectContaining({
        repo: 'owner/repo',
        issue: 'unlinked',
        stage: 'groom',
        exitCode: 0,
        logFile: undefined,
      })
    );
    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({
      stdio: 'inherit',
    });
  });

  it('captures stdout to a caller-supplied logFile override instead of the session log path', async () => {
    resolveModeMock.mockReturnValue('headless');
    readFileMock.mockResolvedValueOnce(makePrompt('claude'));
    mockSpawnResult();

    const overridePath = '/home/user/.shipper/logs/unblock-376-20260318T040000.log';
    await expect(
      runPrompt('unblock', {
        mode: 'headless',
        repo: 'owner/repo',
        issueRef: '376',
        logFile: overridePath,
      })
    ).resolves.toBe(0);

    // The createWriteStream should receive the override path, not the session path
    expect(createWriteStreamMock).toHaveBeenCalledWith(overridePath);
    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Session metadata should still be written under ~/.shipper/sessions/...
    const writeMetaCall = writeSessionMetaMock.mock.calls[0];
    expect(writeMetaCall?.[0]).toContain('/home/user/.shipper/sessions/owner-repo/');
    // But the logFile in metadata should point at the override path
    expect((writeMetaCall?.[1] as { logFile: string }).logFile).toBe(overridePath);
  });

  it('captures a caller-supplied logFile for default-mode unblock runs and persists usage', async () => {
    resolveAgentMock.mockReturnValue('codex');
    readFileMock.mockResolvedValueOnce(makePrompt('codex', ['exec']));
    parseAgentUsageMock.mockResolvedValueOnce({
      inputTokens: 18,
      outputTokens: 7,
      cacheReadTokens: 4,
      cacheWriteTokens: 1,
    });
    mockSpawnResult();

    const overridePath = '/home/user/.shipper/logs/unblock-42-20260318T050000.log';
    await expect(
      runPrompt('unblock', {
        mode: 'default',
        repo: 'owner/repo',
        issueRef: '42',
        logFile: overridePath,
      })
    ).resolves.toBe(0);

    // Even when the caller supplies a log file, usage should be parsed and persisted.
    expect(createWriteStreamMock).toHaveBeenCalledWith(overridePath);
    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    expect(spawnedArgs()).toContain('--json');
    expect(parseAgentUsageMock).toHaveBeenCalledWith('codex', overridePath);
    expect((writeSessionMetaMock.mock.calls[0]?.[1] as { logFile: string }).logFile).toBe(
      overridePath
    );
    expect(writeSessionMetaMock.mock.calls[0]?.[1]).toMatchObject({
      usage: {
        inputTokens: 18,
        outputTokens: 7,
        cacheReadTokens: 4,
        cacheWriteTokens: 1,
      },
    });
  });

  it('captures interactive caller-supplied logs without attempting usage parsing', async () => {
    resolveModeMock.mockReturnValue('interactive');
    readFileMock.mockResolvedValueOnce(makePrompt('claude'));
    mockSpawnResult();

    const overridePath = '/home/user/.shipper/logs/new-42-20260318T050000.log';
    await expect(
      runPrompt('new', {
        mode: 'interactive',
        repo: 'owner/repo',
        logFile: overridePath,
      })
    ).resolves.toBe(0);

    expect(createWriteStreamMock).toHaveBeenCalledWith(overridePath);
    expect(parseAgentUsageMock).not.toHaveBeenCalled();
    expect(writeSessionMetaMock).toHaveBeenCalledWith(
      expect.stringContaining('/home/user/.shipper/sessions/owner-repo/unlinked-new-'),
      expect.objectContaining({
        logFile: overridePath,
        usage: undefined,
      })
    );
  });

  it('tees child stdout and stderr into the active ship log capture stream', async () => {
    resolveModeMock.mockReturnValue('headless');
    readFileMock.mockResolvedValueOnce(makePrompt('claude', ['-p']));
    mockSpawnResult({
      stdoutChunks: ['stage stdout\n'],
      stderrChunks: ['stage stderr\n'],
    });
    const captureStream = makeLogStream();

    await withLogCapture(captureStream, async () => {
      await expect(runPrompt('test', { mode: 'headless', repo: 'owner/repo' })).resolves.toBe(0);
    });

    expect(captureStream.chunks).toContain('stage stdout\n');
    expect(captureStream.chunks).toContain('stage stderr\n');
  });

  it('echoes headless stdout back to the terminal while capturing session logs', async () => {
    resolveModeMock.mockReturnValue('headless');
    readFileMock.mockResolvedValueOnce(makePrompt('claude'));
    const stdoutWriteMock = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    mockSpawnResult({ stdoutChunks: ['headless output\n'] });

    await expect(runPrompt('test', { mode: 'headless', repo: 'owner/repo' })).resolves.toBe(0);

    expect(stdoutWriteMock).toHaveBeenCalledWith('headless output\n');
    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    stdoutWriteMock.mockRestore();
  });

  it('returns 1 after aborting Claude when the question bridge driver fails', async () => {
    resolveModeMock.mockReturnValue('headless');
    readFileMock.mockResolvedValueOnce(makePrompt('claude'));
    driveQuestionBridgeMock.mockRejectedValueOnce(new Error('bridge broke'));
    const errorMock = vi.spyOn(console, 'error').mockImplementation(() => {});
    const child = makeTimeoutChild();
    spawnMock.mockReturnValueOnce(child);

    let settled = false;
    const run = runPrompt('test', { mode: 'headless', repo: 'owner/repo' }).then((result) => {
      settled = true;
      return result;
    });

    for (let attempt = 0; attempt < 10 && child.kill.mock.calls.length === 0; attempt += 1) {
      await sleep(0);
    }

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(errorMock).toHaveBeenCalledWith(
      '[shipper] Error: AskUserQuestion bridge failed: bridge broke'
    );
    await sleep(0);
    expect(settled).toBe(false);

    child.emit('close', 143);
    child.finishLog();
    await expect(run).resolves.toBe(1);
    errorMock.mockRestore();
  });

  it('resolves session paths for headless runs even when opts.repo is omitted', async () => {
    resolveModeMock.mockReturnValue('headless');
    readFileMock.mockResolvedValueOnce(makePrompt('claude'));
    resolveSessionRepoMock.mockResolvedValueOnce({ repo: '_unlinked', repoSlug: '_unlinked' });
    mockSpawnResult();

    await expect(runPrompt('setup', { mode: 'headless', cwd: '/tmp/no-repo' })).resolves.toBe(0);

    expect(resolveSessionRepoMock).toHaveBeenCalledWith({ repo: undefined, cwd: '/tmp/no-repo' });
    expect(getSessionPathsMock).toHaveBeenCalledWith(
      '_unlinked',
      undefined,
      'setup',
      expect.any(Date)
    );
    expect(writeSessionMetaMock).toHaveBeenCalledWith(
      expect.stringContaining('/_unlinked/unlinked-setup-'),
      expect.objectContaining({
        repo: '_unlinked',
        issue: 'unlinked',
        stage: 'setup',
      })
    );
  });

  it('writes interactive session metadata without stdout capture', async () => {
    resolveModeMock.mockReturnValue('interactive');
    readFileMock.mockResolvedValueOnce(makePrompt('claude'));
    mockSpawnResult();

    await expect(runPrompt('test', { mode: 'interactive', repo: 'owner/repo' })).resolves.toBe(0);

    expect(resolveSessionRepoMock).toHaveBeenCalledWith({ repo: 'owner/repo', cwd: undefined });
    expect(getSessionPathsMock).toHaveBeenCalledWith(
      'owner-repo',
      undefined,
      'test',
      expect.any(Date)
    );
    expect(mkdirMock).toHaveBeenCalledWith('/home/user/.shipper/sessions/owner-repo', {
      recursive: true,
    });
    expect(createWriteStreamMock).not.toHaveBeenCalled();
    expect(writeSessionMetaMock).toHaveBeenCalled();
    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({
      stdio: 'inherit',
    });
  });

  it('warns on metadata write failure and still returns the agent exit code', async () => {
    resolveModeMock.mockReturnValue('headless');
    readFileMock.mockResolvedValueOnce(makePrompt('claude'));
    writeSessionMetaMock.mockRejectedValueOnce(new Error('disk full'));
    const warnMock = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockSpawnResult({ code: 17 });

    await expect(runPrompt('test', { mode: 'headless', repo: 'owner/repo' })).resolves.toBe(17);

    expect(warnMock).toHaveBeenCalledWith(
      '[shipper] Warning: Failed to write session metadata: disk full'
    );
    warnMock.mockRestore();
  });

  it('warns when session logging setup fails and still runs headless mode', async () => {
    resolveModeMock.mockReturnValue('headless');
    readFileMock.mockResolvedValueOnce(makePrompt('claude'));
    mkdirMock.mockRejectedValueOnce(new Error('EACCES'));
    const warnMock = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockSpawnResult({ code: 9 });

    await expect(runPrompt('test', { mode: 'headless', repo: 'owner/repo' })).resolves.toBe(9);

    expect(warnMock).toHaveBeenCalledWith(
      '[shipper] Warning: Failed to initialize session logging: EACCES'
    );
    expect(createWriteStreamMock).not.toHaveBeenCalled();
    expect(writeSessionMetaMock).not.toHaveBeenCalled();
    // Claude headless always pipes stdout so the question bridge can read stream-json,
    // even when session logging is disabled. Stdin is ignored so the CLI's stdin (used to receive
    // deferred answers from the MCP parent) isn't shared with claude.
    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(spawnedArgs()).toContain('--output-format');
    warnMock.mockRestore();
  });

  it('warns on log capture failure and still returns the agent exit code', async () => {
    resolveModeMock.mockReturnValue('headless');
    readFileMock.mockResolvedValueOnce(makePrompt('claude'));
    const warnMock = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockSpawnResult({ code: 23, logError: new Error('disk full') });

    await expect(runPrompt('test', { mode: 'headless', repo: 'owner/repo' })).resolves.toBe(23);

    expect(warnMock).toHaveBeenCalledWith(
      '[shipper] Warning: Session log capture failed: disk full'
    );
    expect(writeSessionMetaMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ exitCode: 23 })
    );
    warnMock.mockRestore();
  });

  it('records the effective model from prompt args in session metadata', async () => {
    resolveModeMock.mockReturnValue('headless');
    readFileMock.mockResolvedValueOnce(makePrompt('claude', ['--model', 'opus']));
    mockSpawnResult();

    await expect(runPrompt('implement', { mode: 'headless', repo: 'owner/repo' })).resolves.toBe(0);

    expect(writeSessionMetaMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ model: 'opus' })
    );
  });

  it('prints and persists parsed usage for headless runs', async () => {
    resolveModeMock.mockReturnValue('headless');
    readFileMock.mockResolvedValueOnce(makePrompt('claude'));
    parseAgentUsageMock.mockResolvedValueOnce({
      inputTokens: 45,
      outputTokens: 12,
      cacheReadTokens: 8,
      cacheWriteTokens: 2,
    });
    const logMock = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockSpawnResult();

    await expect(runPrompt('test', { mode: 'headless', repo: 'owner/repo' })).resolves.toBe(0);

    expect(formatUsageLineMock).toHaveBeenCalledWith({
      inputTokens: 45,
      outputTokens: 12,
      cacheReadTokens: 8,
      cacheWriteTokens: 2,
    });
    expect(logMock).toHaveBeenCalledWith(
      '[shipper] Usage: 45 input │ 12 output │ 8 cache read │ 2 cache write tokens'
    );
    expect(writeSessionMetaMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        usage: {
          inputTokens: 45,
          outputTokens: 12,
          cacheReadTokens: 8,
          cacheWriteTokens: 2,
        },
      })
    );

    logMock.mockRestore();
  });

  it('captures and persists usage metadata for headless Copilot runs', async () => {
    resolveAgentMock.mockReturnValue('copilot');
    resolveModeMock.mockReturnValue('headless');
    readFileMock.mockResolvedValueOnce(makePrompt('copilot'));
    parseAgentUsageMock.mockResolvedValueOnce({
      inputTokens: 31,
      outputTokens: 14,
      cacheReadTokens: 6,
      cacheWriteTokens: 3,
    });
    mockSpawnResult();

    await expect(
      runPrompt('implement', { mode: 'headless', repo: 'owner/repo', issueRef: '540' })
    ).resolves.toBe(0);

    expect(spawnedArgs()).toEqual([
      '--autopilot',
      '--allow-all-tools',
      '--allow-all-urls',
      '--no-ask-user',
      '--output-format',
      'json',
      '-p',
      'prompt body',
    ]);
    expect(createWriteStreamMock).toHaveBeenCalledWith(
      expect.stringContaining('/home/user/.shipper/sessions/owner-repo/540-implement-')
    );
    expect(spawnedOptions()).toMatchObject({
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    expect(parseAgentUsageMock).toHaveBeenCalledWith(
      'copilot',
      expect.stringContaining('/home/user/.shipper/sessions/owner-repo/540-implement-')
    );
    expect(writeSessionMetaMock).toHaveBeenCalledWith(
      expect.stringContaining('/home/user/.shipper/sessions/owner-repo/540-implement-'),
      expect.objectContaining({
        issue: '540',
        stage: 'implement',
        agent: 'copilot',
        usage: {
          inputTokens: 31,
          outputTokens: 14,
          cacheReadTokens: 6,
          cacheWriteTokens: 3,
        },
      })
    );
  });

  it('does not parse or persist usage for interactive runs without a log file', async () => {
    resolveModeMock.mockReturnValue('interactive');
    readFileMock.mockResolvedValueOnce(makePrompt('claude'));
    mockSpawnResult();

    await expect(runPrompt('new', { mode: 'interactive', repo: 'owner/repo' })).resolves.toBe(0);

    expect(createWriteStreamMock).not.toHaveBeenCalled();
    expect(parseAgentUsageMock).not.toHaveBeenCalled();
    expect(formatUsageLineMock).not.toHaveBeenCalled();
    const interactiveMeta = writeSessionMetaMock.mock.calls[0]?.[1];
    expect(interactiveMeta).toBeDefined();
    expect(interactiveMeta).toMatchObject({ usage: undefined });
  });

  it('persists partial usage on failed headless runs without changing the exit code', async () => {
    resolveModeMock.mockReturnValue('headless');
    readFileMock.mockResolvedValueOnce(makePrompt('claude'));
    parseAgentUsageMock.mockResolvedValueOnce({
      inputTokens: 11,
      outputTokens: 4,
      cacheReadTokens: 3,
      cacheWriteTokens: 1,
    });
    mockSpawnResult({ code: 17 });

    await expect(runPrompt('test', { mode: 'headless', repo: 'owner/repo' })).resolves.toBe(17);

    expect(writeSessionMetaMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        exitCode: 17,
        usage: {
          inputTokens: 11,
          outputTokens: 4,
          cacheReadTokens: 3,
          cacheWriteTokens: 1,
        },
      })
    );
  });

  it('ignores usage parser failures and preserves the original exit code', async () => {
    resolveModeMock.mockReturnValue('headless');
    readFileMock.mockResolvedValueOnce(makePrompt('claude'));
    parseAgentUsageMock.mockRejectedValueOnce(new Error('parse failed'));
    const logMock = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnMock = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockSpawnResult({ code: 23 });

    await expect(runPrompt('test', { mode: 'headless', repo: 'owner/repo' })).resolves.toBe(23);

    expect(formatUsageLineMock).not.toHaveBeenCalled();
    expect(logMock).not.toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalledWith(
      expect.stringContaining('[shipper] Failed to parse agent usage from ')
    );
    const failedMeta = writeSessionMetaMock.mock.calls[0]?.[1];
    expect(failedMeta).toBeDefined();
    expect(failedMeta).toMatchObject({ usage: undefined });

    logMock.mockRestore();
  });

  it('injects codex headless args when absent', async () => {
    resolveAgentMock.mockReturnValue('codex');
    resolveModeMock.mockReturnValue('headless');
    readFileMock.mockResolvedValueOnce(makePrompt('codex'));
    mockSpawnResult();

    await runPrompt('test', { mode: 'headless' });

    expect(spawnedArgs().slice(0, 5)).toEqual([
      'exec',
      '--full-auto',
      '--json',
      '-c',
      'sandbox_workspace_write.network_access=true',
    ]);
    expect(spawnedOptions()?.env).toBe(process.env);
    expect(driveQuestionBridgeMock).not.toHaveBeenCalled();
  });

  it('fills in missing codex headless args when exec is already present', async () => {
    resolveAgentMock.mockReturnValue('codex');
    resolveModeMock.mockReturnValue('headless');
    readFileMock.mockResolvedValueOnce(makePrompt('codex', ['exec']));
    mockSpawnResult();

    await runPrompt('test', { mode: 'headless' });

    expect(spawnedArgs().slice(0, 5)).toEqual([
      'exec',
      '--full-auto',
      '--json',
      '-c',
      'sandbox_workspace_write.network_access=true',
    ]);
  });

  it('adds json output and persists usage for default-mode codex prompts', async () => {
    resolveAgentMock.mockReturnValue('codex');
    readFileMock.mockResolvedValueOnce(makePrompt('codex', ['exec']));
    parseAgentUsageMock.mockResolvedValueOnce({
      inputTokens: 21,
      outputTokens: 9,
      cacheReadTokens: 5,
      cacheWriteTokens: 0,
    });
    const logMock = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockSpawnResult();

    await expect(
      runPrompt('design', { mode: 'default', repo: 'owner/repo', issueRef: '77' })
    ).resolves.toBe(0);

    expect(spawnedArgs()).toContain('exec');
    expect(spawnedArgs()).toContain('--json');
    expect(createWriteStreamMock).toHaveBeenCalledWith(
      expect.stringContaining('/home/user/.shipper/sessions/owner-repo/77-design-')
    );
    expect(parseAgentUsageMock).toHaveBeenCalledWith(
      'codex',
      expect.stringContaining('/home/user/.shipper/sessions/owner-repo/77-design-')
    );
    expect(writeSessionMetaMock).toHaveBeenCalledWith(
      expect.stringContaining('/home/user/.shipper/sessions/owner-repo/77-design-'),
      expect.objectContaining({
        stage: 'design',
        agent: 'codex',
        usage: {
          inputTokens: 21,
          outputTokens: 9,
          cacheReadTokens: 5,
          cacheWriteTokens: 0,
        },
      })
    );

    logMock.mockRestore();
  });

  it('strips codex headless args for interactive mode', async () => {
    resolveAgentMock.mockReturnValue('codex');
    resolveModeMock.mockReturnValue('interactive');
    readFileMock.mockResolvedValueOnce(
      makePrompt('codex', [
        'exec',
        '--full-auto',
        '--json',
        '-c',
        'sandbox_workspace_write.network_access=true',
      ])
    );
    mockSpawnResult();

    await runPrompt('test', { mode: 'interactive' });

    expect(spawnedArgs()).not.toContain('exec');
    expect(spawnedArgs()).toContain('--full-auto');
    expect(spawnedArgs()).not.toContain('--json');
    expect(spawnedArgs()).toContain('-c');
    expect(spawnedArgs()).toContain('sandbox_workspace_write.network_access=true');
    expect(spawnedArgs()).toContain('prompt body');
  });

  it('preserves unrelated codex -c args in interactive mode', async () => {
    resolveAgentMock.mockReturnValue('codex');
    resolveModeMock.mockReturnValue('interactive');
    readFileMock.mockResolvedValueOnce(
      makePrompt('codex', [
        '-c',
        'config1',
        'exec',
        '--full-auto',
        '-c',
        'sandbox_workspace_write.network_access=true',
      ])
    );
    mockSpawnResult();

    await runPrompt('test', { mode: 'interactive' });

    expect(spawnedArgs()).toContain('-c');
    expect(spawnedArgs()).toContain('config1');
    expect(spawnedArgs()).not.toContain('exec');
    expect(spawnedArgs()).toContain('--full-auto');
    expect(spawnedArgs()).toContain('sandbox_workspace_write.network_access=true');
  });

  it('does not inject codex network config for prompts authored directly for interactive mode', async () => {
    resolveAgentMock.mockReturnValue('codex');
    resolveModeMock.mockReturnValue('interactive');
    readFileMock.mockResolvedValueOnce(makePrompt('codex'));
    mockSpawnResult();

    await runPrompt('test', { mode: 'interactive' });

    expect(spawnedArgs()).not.toContain('exec');
    expect(spawnedArgs()).not.toContain('--json');
    expect(spawnedArgs()).not.toContain('-c');
    expect(spawnedArgs()).not.toContain('sandbox_workspace_write.network_access=true');
    expect(spawnedArgs()).toContain('prompt body');
  });
});

describe('worktree --add-dir', () => {
  it('adds --add-dir for both gitdir and commondir before exec for codex in a worktree', async () => {
    resolveAgentMock.mockReturnValue('codex');
    resolveModeMock.mockReturnValue('headless');
    readFileMock.mockResolvedValueOnce(makePrompt('codex'));
    statSyncMock.mockImplementation((p: string) => {
      if (p.endsWith('.git')) return { isFile: () => true };
      return { isFile: () => false };
    });
    readFileSyncMock
      .mockReturnValueOnce('gitdir: /repo/.git/worktrees/my-wt\n')
      .mockReturnValueOnce('../..\n');
    mockSpawnResult();

    await runPrompt('test', { cwd: '/tmp/wt' });

    const args = spawnedArgs();
    const firstAddDir = args.indexOf('--add-dir');
    expect(firstAddDir).toBeGreaterThanOrEqual(0);
    expect(args[firstAddDir + 1]).toBe('/repo/.git/worktrees/my-wt');
    const secondAddDir = args.indexOf('--add-dir', firstAddDir + 1);
    expect(secondAddDir).toBeGreaterThanOrEqual(0);
    expect(args[secondAddDir + 1]).toBe('/repo/.git');
    expect(secondAddDir).toBeLessThan(args.indexOf('exec'));
  });

  it('does not add --add-dir when .git is a directory (non-worktree)', async () => {
    resolveAgentMock.mockReturnValue('codex');
    resolveModeMock.mockReturnValue('headless');
    readFileMock.mockResolvedValueOnce(makePrompt('codex'));
    statSyncMock.mockImplementation(() => ({ isFile: () => false }));
    mockSpawnResult();

    await runPrompt('test', { cwd: '/tmp/wt' });

    expect(spawnedArgs()).not.toContain('--add-dir');
  });

  it('does not add --add-dir for claude agent regardless of .git status', async () => {
    resolveAgentMock.mockReturnValue('claude');
    resolveModeMock.mockReturnValue('headless');
    readFileMock.mockResolvedValueOnce(makePrompt('claude'));
    mockSpawnResult();

    await runPrompt('test', { cwd: '/tmp/wt' });

    expect(spawnedArgs()).not.toContain('--add-dir');
    expect(statSyncMock).not.toHaveBeenCalled();
  });

  it('does not add --add-dir for copilot agent in a worktree', async () => {
    resolveAgentMock.mockReturnValue('copilot');
    resolveModeMock.mockReturnValue('headless');
    readFileMock.mockResolvedValueOnce(makePrompt('copilot'));
    statSyncMock.mockReturnValue({ isFile: () => true });
    readFileSyncMock.mockReturnValue('gitdir: /repo/.git/worktrees/copilot-wt\n');
    mockSpawnResult();

    await runPrompt('test', { cwd: '/tmp/wt' });

    expect(spawnedArgs()).toEqual([
      '--autopilot',
      '--allow-all-tools',
      '--allow-all-urls',
      '--no-ask-user',
      '--output-format',
      'json',
      '-p',
      'prompt body',
    ]);
    expect(spawnedArgs()).not.toContain('--add-dir');
    expect(statSyncMock).not.toHaveBeenCalled();
  });

  it('warns and skips --add-dir when .git file has no gitdir line', async () => {
    resolveAgentMock.mockReturnValue('codex');
    resolveModeMock.mockReturnValue('headless');
    readFileMock.mockResolvedValueOnce(makePrompt('codex'));
    statSyncMock.mockImplementation((p: string) => {
      if (p.endsWith('.git')) return { isFile: () => true };
      return { isFile: () => false };
    });
    readFileSyncMock.mockReturnValueOnce('invalid content\n');
    const warnMock = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockSpawnResult();

    await runPrompt('test', { cwd: '/tmp/wt' });

    expect(spawnedArgs()).not.toContain('--add-dir');
    expect(warnMock).toHaveBeenCalledWith(expect.stringContaining('[shipper] Warning: .git file'));
    expect(spawnMock).toHaveBeenCalled();
    warnMock.mockRestore();
  });

  it('warns and skips --add-dir when gitdir path does not exist', async () => {
    resolveAgentMock.mockReturnValue('codex');
    resolveModeMock.mockReturnValue('headless');
    readFileMock.mockResolvedValueOnce(makePrompt('codex'));

    let callCount = 0;
    statSyncMock.mockImplementation((p: string) => {
      if (callCount === 0 && p.endsWith('.git')) {
        callCount += 1;
        return { isFile: () => true };
      }
      throw new Error('ENOENT');
    });

    readFileSyncMock.mockReturnValueOnce('gitdir: /repo/.git/worktrees/my-wt\n');
    const warnMock = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockSpawnResult();

    await runPrompt('test', { cwd: '/tmp/wt' });

    expect(spawnedArgs()).not.toContain('--add-dir');
    expect(warnMock).toHaveBeenCalledWith(
      expect.stringContaining('[shipper] Warning: gitdir path')
    );
    expect(spawnMock).toHaveBeenCalled();
    warnMock.mockRestore();
  });

  it('returns 1 with a clear error when the copilot binary is missing', async () => {
    resolveAgentMock.mockReturnValue('copilot');
    readFileMock.mockResolvedValueOnce(makePrompt('copilot'));
    execFileSyncMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    });
    const errorMock = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runPrompt('test', {})).resolves.toBe(1);

    expect(errorMock).toHaveBeenCalledWith(
      '[shipper] Error: copilot binary not found on PATH.\nInstall the GitHub Copilot CLI: https://docs.github.com/copilot/cli'
    );
    expect(spawnMock).not.toHaveBeenCalled();
    errorMock.mockRestore();
  });

  it('fails buildPromptCommand early when the copilot binary is missing', async () => {
    resolveAgentMock.mockReturnValue('copilot');
    readFileMock.mockResolvedValueOnce(makePrompt('copilot'));
    execFileSyncMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    });

    await expect(buildPromptCommand('test', {})).rejects.toThrow(
      'copilot binary not found on PATH.\nInstall the GitHub Copilot CLI: https://docs.github.com/copilot/cli'
    );
  });

  it('surfaces non-ENOENT copilot preflight errors without masking them as missing binaries', async () => {
    resolveAgentMock.mockReturnValue('copilot');
    readFileMock.mockResolvedValueOnce(makePrompt('copilot'));
    execFileSyncMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });
    const errorMock = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runPrompt('test', {})).resolves.toBe(1);

    expect(errorMock).toHaveBeenCalledWith('[shipper] Error: permission denied');
    expect(spawnMock).not.toHaveBeenCalled();
    errorMock.mockRestore();
  });
});

describe('agent timeout', () => {
  let errorMock: MockInstance<typeof console.error>;

  beforeEach(() => {
    vi.useFakeTimers();
    errorMock = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    errorMock.mockRestore();
  });

  it('sends SIGTERM after timeout in headless mode', async () => {
    resolveModeMock.mockReturnValue('headless');
    getSettingsMock.mockReturnValue({ agentTimeoutMinutes: 60 });
    readFileMock.mockResolvedValueOnce(makePrompt('claude'));

    const child = makeTimeoutChild();
    spawnMock.mockReturnValueOnce(child);

    const promise = runPrompt('test', { mode: 'headless' });
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(60 * 60_000);

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(errorMock).toHaveBeenCalledWith('[shipper] Agent timed out after 60 minutes');

    child.emit('close', 143);
    child.finishLog();
    await expect(promise).resolves.toBe(143);
  });

  it('sends SIGKILL after 10s grace period if process does not exit', async () => {
    resolveModeMock.mockReturnValue('headless');
    getSettingsMock.mockReturnValue({ agentTimeoutMinutes: 60 });
    readFileMock.mockResolvedValueOnce(makePrompt('claude'));

    const child = makeTimeoutChild();
    spawnMock.mockReturnValueOnce(child);

    const promise = runPrompt('test', { mode: 'headless' });
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');

    child.emit('close', 137);
    child.finishLog();
    await expect(promise).resolves.toBe(137);
  });

  it('does not set timeout in interactive mode', async () => {
    resolveModeMock.mockReturnValue('interactive');
    getSettingsMock.mockReturnValue({ agentTimeoutMinutes: 60 });
    readFileMock.mockResolvedValueOnce(makePrompt('claude'));

    const child = makeTimeoutChild();
    spawnMock.mockReturnValueOnce(child);

    const promise = runPrompt('test', { mode: 'interactive' });
    await Promise.resolve();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(60 * 60_000 + 10_000);
    expect(child.kill).not.toHaveBeenCalled();

    child.emit('close', 0);
    child.finishLog();
    await expect(promise).resolves.toBe(0);
  });

  it('does not set timeout when agentTimeoutMinutes is 0', async () => {
    resolveModeMock.mockReturnValue('headless');
    getSettingsMock.mockReturnValue({ agentTimeoutMinutes: 0 });
    readFileMock.mockResolvedValueOnce(makePrompt('claude'));

    const child = makeTimeoutChild();
    spawnMock.mockReturnValueOnce(child);

    const promise = runPrompt('test', { mode: 'headless' });
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(120 * 60_000);
    expect(child.kill).not.toHaveBeenCalled();

    child.emit('close', 0);
    child.finishLog();
    await expect(promise).resolves.toBe(0);
  });

  it('forces non-zero exit code when agent exits 0 after timeout', async () => {
    resolveModeMock.mockReturnValue('headless');
    getSettingsMock.mockReturnValue({ agentTimeoutMinutes: 60 });
    readFileMock.mockResolvedValueOnce(makePrompt('claude'));

    const child = makeTimeoutChild();
    spawnMock.mockReturnValueOnce(child);

    const promise = runPrompt('test', { mode: 'headless' });
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    // Agent handles SIGTERM and exits with 0
    child.emit('close', 0);
    child.finishLog();
    await expect(promise).resolves.toBe(1);
  });

  it('clears timers on normal exit before timeout', async () => {
    resolveModeMock.mockReturnValue('headless');
    getSettingsMock.mockReturnValue({ agentTimeoutMinutes: 60 });
    readFileMock.mockResolvedValueOnce(makePrompt('claude'));

    const child = makeTimeoutChild();
    spawnMock.mockReturnValueOnce(child);

    const promise = runPrompt('test', { mode: 'headless' });
    await Promise.resolve();
    await Promise.resolve();

    // Flush microtasks so runPrompt reaches the spawn call
    await vi.advanceTimersByTimeAsync(0);

    // Process exits normally before timeout
    child.emit('close', 0);
    child.finishLog();
    await expect(promise).resolves.toBe(0);

    // Advance past the timeout — should not fire
    await vi.advanceTimersByTimeAsync(60 * 60_000 + 10_000);
    expect(child.kill).not.toHaveBeenCalled();
  });
});
