import { EventEmitter } from 'node:events';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  stdin?: PromptStdin;
  stderr?: EventEmitter;
  stdout?: PromptStdout;
};

const spawnMock =
  vi.fn<(command: string, args?: string[], options?: Record<string, unknown>) => PromptChild>();
const execFileSyncMock =
  vi.fn<(command: string, args?: string[], options?: Record<string, unknown>) => void>();
const readFileMock = vi.fn<(path: string, encoding: string) => Promise<string>>();
const mkdirMock = vi.fn<(path: string, options?: Record<string, unknown>) => Promise<void>>();
const statSyncMock = vi.fn<(path: string) => unknown>();
const createWriteStreamMock = vi.fn<(path: string) => MockLogStream>();
const readFileSyncMock = vi.fn<(path: string, encoding: string) => string>();
const fetchIssueMock = vi.fn<(repo: string, issueRef: string) => Promise<string>>();
const fetchPRMock = vi.fn<(repo: string, prRef: string) => Promise<string>>();
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
    ) => { logFile: string; metaFile: string }
  >()
  .mockImplementation((repoSlug, issueRef = 'unlinked', stage = 'test', timestamp = new Date()) => {
    const token = timestamp.toISOString().replace(/[:.]/g, '-');
    const base = `${issueRef}-${stage}-${token}`;
    return {
      logFile: `/home/user/.shipper/sessions/${repoSlug}/${base}.jsonl`,
      metaFile: `/home/user/.shipper/sessions/${repoSlug}/${base}.meta.json`,
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
const resolveAgentMock = vi
  .fn<(promptName: string, agent?: string) => 'claude' | 'codex' | 'copilot'>()
  .mockReturnValue('claude');
const resolveModelMock = vi
  .fn<(promptName: string, model?: string) => string | undefined>()
  .mockReturnValue(undefined);
const resolveModeMock = vi
  .fn<(promptName: string, mode?: string) => string>()
  .mockReturnValue('default');
const getSettingsMock = vi.fn<() => { agentTimeoutMinutes: number }>().mockReturnValue({
  agentTimeoutMinutes: 60,
});
const stdinPipeMock = vi.spyOn(process.stdin, 'pipe').mockImplementation(() => undefined as never);
const stdinUnpipeMock = vi
  .spyOn(process.stdin, 'unpipe')
  .mockImplementation(() => process.stdin as never);
const stdinPauseMock = vi
  .spyOn(process.stdin, 'pause')
  .mockImplementation(() => process.stdin as never);

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

vi.mock('../../src/lib/settings.js', () => ({
  resolveAgent: (...args: unknown[]) => resolveAgentMock(...args),
  resolveModel: (...args: unknown[]) => resolveModelMock(...args),
  resolveMode: (...args: unknown[]) => resolveModeMock(...args),
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
  resolveSessionRepo: (...args: unknown[]) => resolveSessionRepoMock(...args),
  getSessionPaths: (...args: unknown[]) => getSessionPathsMock(...args),
  writeSessionMeta: (...args: unknown[]) => writeSessionMetaMock(...args),
}));

vi.mock('../../src/lib/usage.js', () => ({
  parseAgentUsage: (...args: unknown[]) => parseAgentUsageMock(...args),
  formatUsageLine: (...args: unknown[]) => formatUsageLineMock(...args),
}));

function mockSpawnResult(
  opts: {
    code?: number;
    error?: Error;
    logError?: Error;
    stdoutChunks?: string[];
  } = {}
): void {
  const { code = 0, error, logError, stdoutChunks = [] } = opts;
  spawnMock.mockImplementationOnce(() => {
    let pipedStream: EventEmitter | undefined;
    const stdout = Object.assign(new EventEmitter(), {
      pipe(destination: EventEmitter) {
        pipedStream = destination;
        return destination;
      },
      resume() {
        return undefined;
      },
      unpipe(destination?: EventEmitter) {
        if (pipedStream === destination || destination === undefined) {
          pipedStream = undefined;
        }
        return this;
      },
    }) as PromptStdout;
    const child = new EventEmitter() as PromptChild & {
      stdin?: PromptStdin;
      stderr?: EventEmitter;
      stdout?: PromptStdout;
    };
    child.stdin = Object.assign(new EventEmitter(), {
      end: vi.fn(),
      write: vi.fn(),
    }) as PromptStdin;
    child.stdout = stdout;
    globalThis.queueMicrotask(() => {
      if (error) {
        child.emit('error', error);
        return;
      }
      for (const chunk of stdoutChunks) {
        child.stdout?.emit('data', chunk);
      }
      child.stdout?.emit('end');
      if (logError) {
        pipedStream?.emit('error', logError);
      }
      child.emit('close', code);
      globalThis.queueMicrotask(() => {
        if (!logError) {
          pipedStream?.emit('finish');
        }
      });
    });
    return child;
  });
}

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

function makeTimeoutChild(): PromptChild & {
  kill: ReturnType<typeof vi.fn>;
  finishLog: () => void;
} {
  let pipedStream: EventEmitter | undefined;
  const stdout = Object.assign(new EventEmitter(), {
    pipe(destination: EventEmitter) {
      pipedStream = destination;
      return destination;
    },
    resume() {
      return undefined;
    },
    unpipe(destination?: EventEmitter) {
      if (pipedStream === destination || destination === undefined) {
        pipedStream = undefined;
      }
      return this;
    },
  }) as PromptStdout;

  return Object.assign(new EventEmitter(), {
    stdout,
    kill: vi.fn(),
    finishLog() {
      stdout.emit('end');
      pipedStream?.emit('finish');
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
  mkdirMock.mockReset();
  statSyncMock.mockReset();
  createWriteStreamMock.mockReset();
  readFileSyncMock.mockReset();
  execFileSyncMock.mockReset();
  execFileSyncMock.mockImplementation(() => {});
  resolveAgentMock.mockReturnValue('claude');
  resolveModelMock.mockReturnValue(undefined);
  resolveModeMock.mockReturnValue('default');
  getSettingsMock.mockReturnValue({ agentTimeoutMinutes: 60 });
  fetchIssueMock.mockResolvedValue('issue body');
  fetchPRMock.mockResolvedValue('pr body');
  resolveSessionRepoMock.mockResolvedValue({ repo: 'owner/repo', repoSlug: 'owner-repo' });
  writeSessionMetaMock.mockResolvedValue(undefined);
  parseAgentUsageMock.mockReset();
  parseAgentUsageMock.mockResolvedValue(undefined);
  formatUsageLineMock.mockReset();
  formatUsageLineMock.mockReturnValue(
    'Usage: 45 input │ 12 output │ 8 cache read │ 2 cache write tokens'
  );
  statSyncMock.mockImplementation(() => {
    throw new Error('ENOENT');
  });
  readFileSyncMock.mockReset();
  mkdirMock.mockResolvedValue(undefined);
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

  it('appends fetched issue and PR text when requested by frontmatter', async () => {
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
    mockSpawnResult();

    await runPrompt('test', { repo: 'owner/repo', issueRef: '42', prRef: '5' });

    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain('issue details\n\n---\n\npr details');
    expect(fetchIssueMock).toHaveBeenCalledWith('owner/repo', '42');
    expect(fetchPRMock).toHaveBeenCalledWith('owner/repo', '5');
  });

  it('appends user input as a trailing argument for claude prompts', async () => {
    readFileMock.mockResolvedValueOnce(
      ['---', 'cmd: claude', 'append-user-input: true', '---', '', 'prompt body'].join('\n')
    );
    mockSpawnResult();

    await expect(runPrompt('test', { userInput: 'resolve the merge conflict' })).resolves.toBe(0);

    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args.at(-1)).toBe('resolve the merge conflict');
  });

  it('appends user input into the combined prompt body for codex prompts', async () => {
    resolveAgentMock.mockReturnValue('codex');
    readFileMock.mockResolvedValueOnce(
      ['---', 'cmd: codex', 'append-user-input: true', '---', '', 'prompt body'].join('\n')
    );
    mockSpawnResult();

    await expect(runPrompt('test', { userInput: 'resolve the merge conflict' })).resolves.toBe(0);

    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain('prompt body\n\n---\n\nresolve the merge conflict');
  });

  it('appends user input into the combined prompt body for copilot prompts', async () => {
    resolveAgentMock.mockReturnValue('copilot');
    readFileMock.mockResolvedValueOnce(
      ['---', 'cmd: copilot', 'append-user-input: true', '---', '', 'prompt body'].join('\n')
    );
    mockSpawnResult();

    await expect(runPrompt('test', { userInput: 'resolve the merge conflict' })).resolves.toBe(0);

    expect(spawnedArgs()).toEqual([]);
    expect(spawnedChild().stdin?.write).toHaveBeenCalledWith(
      'prompt body\n\n---\n\nresolve the merge conflict\n'
    );
  });

  it('throws from buildPromptCommand when combined prompt inputs exceed the budget', async () => {
    const promptBody = 'p'.repeat(60_000);
    readFileMock.mockResolvedValueOnce(
      [
        '---',
        'cmd: claude',
        'append-issue: true',
        'append-pr: true',
        'append-user-input: true',
        '---',
        '',
        promptBody,
      ].join('\n')
    );
    fetchIssueMock.mockResolvedValueOnce('i'.repeat(60_000));
    fetchPRMock.mockResolvedValueOnce('r'.repeat(60_000));

    await expect(
      buildPromptCommand('test', {
        repo: 'owner/repo',
        issueRef: '42',
        prRef: '5',
        userInput: 'u'.repeat(60_000),
      })
    ).rejects.toThrow(/Total prompt input size \(\d+ bytes\) exceeds the 200000-byte budget/);
  });

  it('returns 1 and does not spawn when the combined prompt inputs exceed the budget', async () => {
    const promptBody = 'p'.repeat(60_000);
    readFileMock.mockResolvedValueOnce(
      [
        '---',
        'cmd: claude',
        'append-issue: true',
        'append-pr: true',
        'append-user-input: true',
        '---',
        '',
        promptBody,
      ].join('\n')
    );
    fetchIssueMock.mockResolvedValueOnce('i'.repeat(60_000));
    fetchPRMock.mockResolvedValueOnce('r'.repeat(60_000));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      runPrompt('test', {
        repo: 'owner/repo',
        issueRef: '42',
        prRef: '5',
        userInput: 'u'.repeat(60_000),
      })
    ).resolves.toBe(1);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /Error: Total prompt input size \(\d+ bytes\) exceeds the 200000-byte budget/
      )
    );
    expect(spawnMock).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('still spawns when combined prompt inputs stay within the budget', async () => {
    const promptBody = 'p'.repeat(20_000);
    readFileMock.mockResolvedValueOnce(
      [
        '---',
        'cmd: claude',
        'append-issue: true',
        'append-pr: true',
        'append-user-input: true',
        '---',
        '',
        promptBody,
      ].join('\n')
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
      "Warning: Ejected prompt 'test' contains gh commands for state mutations.\nThese are now handled by shipper. Re-eject with 'shipper eject test' or manually update."
    );
    expect(spawnMock).toHaveBeenCalled();
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
      [
        '---',
        'cmd: copilot',
        'args:',
        '  - --autopilot',
        'append-user-input: true',
        '---',
        '',
        'prompt body',
      ].join('\n')
    );

    await expect(buildPromptCommand('test', { userInput: 'extra context' })).resolves.toEqual({
      command: 'copilot',
      args: [],
      cwd: undefined,
      initialInput: 'prompt body\n\n---\n\nextra context',
    });
  });

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
      env: process.env,
      stdio: ['inherit', 'pipe', 'inherit'],
    });
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
      stdio: ['inherit', 'pipe', 'inherit'],
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
      stdio: ['inherit', 'pipe', 'inherit'],
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
      stdio: ['inherit', 'pipe', 'inherit'],
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

  it('does not echo headless stdout back to the terminal while capturing session logs', async () => {
    resolveModeMock.mockReturnValue('headless');
    readFileMock.mockResolvedValueOnce(makePrompt('claude'));
    const stdoutWriteMock = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    mockSpawnResult({ stdoutChunks: ['headless output\n'] });

    await expect(runPrompt('test', { mode: 'headless', repo: 'owner/repo' })).resolves.toBe(0);

    expect(stdoutWriteMock).not.toHaveBeenCalledWith('headless output\n');
    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({
      stdio: ['inherit', 'pipe', 'inherit'],
    });

    stdoutWriteMock.mockRestore();
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

    expect(warnMock).toHaveBeenCalledWith('Warning: Failed to write session metadata: disk full');
    warnMock.mockRestore();
  });

  it('warns when session logging setup fails and still runs headless mode', async () => {
    resolveModeMock.mockReturnValue('headless');
    readFileMock.mockResolvedValueOnce(makePrompt('claude'));
    mkdirMock.mockRejectedValueOnce(new Error('EACCES'));
    const warnMock = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockSpawnResult({ code: 9 });

    await expect(runPrompt('test', { mode: 'headless', repo: 'owner/repo' })).resolves.toBe(9);

    expect(warnMock).toHaveBeenCalledWith('Warning: Failed to initialize session logging: EACCES');
    expect(createWriteStreamMock).not.toHaveBeenCalled();
    expect(writeSessionMetaMock).not.toHaveBeenCalled();
    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({
      stdio: 'inherit',
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

    expect(warnMock).toHaveBeenCalledWith('Warning: Session log capture failed: disk full');
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
      'Usage: 45 input │ 12 output │ 8 cache read │ 2 cache write tokens'
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
    mockSpawnResult({ code: 23 });

    await expect(runPrompt('test', { mode: 'headless', repo: 'owner/repo' })).resolves.toBe(23);

    expect(formatUsageLineMock).not.toHaveBeenCalled();
    expect(logMock).not.toHaveBeenCalled();
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
    expect(spawnedArgs()).not.toContain('-c');
    expect(spawnedArgs()).not.toContain('sandbox_workspace_write.network_access=true');
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
    expect(spawnedArgs()).not.toContain('sandbox_workspace_write.network_access=true');
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
    expect(warnMock).toHaveBeenCalledWith(expect.stringContaining('no gitdir: line'));
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
    expect(warnMock).toHaveBeenCalledWith(expect.stringContaining('does not exist'));
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
      'Error: copilot binary not found on PATH.\nInstall the GitHub Copilot CLI: https://docs.github.com/copilot/cli'
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

    expect(errorMock).toHaveBeenCalledWith('Error: permission denied');
    expect(spawnMock).not.toHaveBeenCalled();
    errorMock.mockRestore();
  });
});

describe('agent timeout', () => {
  let errorMock: ReturnType<typeof vi.spyOn>;

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
    expect(errorMock).toHaveBeenCalledWith('Agent timed out after 60 minutes');

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
