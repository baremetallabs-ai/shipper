import { EventEmitter } from 'node:events';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
const readFileMock = vi.fn();
const statSyncMock = vi.fn();
const readFileSyncMock = vi.fn();
const fetchIssueMock = vi.fn();
const fetchPRMock = vi.fn();
const resolveAgentMock = vi.fn().mockReturnValue('claude');
const resolveModelMock = vi.fn().mockReturnValue(undefined);
const resolveModeMock = vi.fn().mockReturnValue('default');
const getSettingsMock = vi.fn().mockReturnValue({ agentTimeoutMinutes: 60 });

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: (...args: unknown[]) => spawnMock(...args) };
});

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, readFile: (...args: unknown[]) => readFileMock(...args) };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
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
  },
}));

function mockSpawnResult(opts: { code?: number; error?: Error } = {}): void {
  const { code = 0, error } = opts;
  spawnMock.mockImplementationOnce(() => {
    const child = new EventEmitter() as EventEmitter & {
      stderr?: EventEmitter;
      stdout?: EventEmitter;
    };
    globalThis.queueMicrotask(() => {
      if (error) {
        child.emit('error', error);
        return;
      }
      child.emit('close', code);
    });
    return child;
  });
}

const { runPrompt } = await import('../../src/lib/prompt-runner.js');

function makePrompt(cmd: 'claude' | 'codex', args: string[] = [], body = 'prompt body'): string {
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
  return spawnMock.mock.calls[0][1] as string[];
}

afterEach(() => {
  vi.clearAllMocks();
  resolveAgentMock.mockReturnValue('claude');
  resolveModelMock.mockReturnValue(undefined);
  resolveModeMock.mockReturnValue('default');
  getSettingsMock.mockReturnValue({ agentTimeoutMinutes: 60 });
  fetchIssueMock.mockResolvedValue('issue body');
  fetchPRMock.mockResolvedValue('pr body');
  statSyncMock.mockImplementation(() => {
    throw new Error('ENOENT');
  });
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

  it('throws when appended issue or PR context is requested without a repo', async () => {
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

    await expect(runPrompt('test', { issueRef: '42', prRef: '5' })).rejects.toThrow(
      'Prompt "test" requires opts.repo when append-issue is enabled.'
    );
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

    expect(spawnedArgs().slice(0, 6)).toEqual([
      '-m',
      'gpt-5',
      'exec',
      '--full-auto',
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

  it('injects -p for claude headless mode when absent', async () => {
    resolveModeMock.mockReturnValue('headless');
    readFileMock.mockResolvedValueOnce(makePrompt('claude', ['--model', 'opus']));
    mockSpawnResult();

    await runPrompt('test', { mode: 'headless' });

    expect(spawnedArgs().slice(0, 3)).toEqual(['-p', '--model', 'opus']);
  });

  it('does not duplicate -p for claude headless mode when already present', async () => {
    resolveModeMock.mockReturnValue('headless');
    readFileMock.mockResolvedValueOnce(makePrompt('claude', ['-p', '--model', 'opus']));
    mockSpawnResult();

    await runPrompt('test', { mode: 'headless' });

    expect(spawnedArgs().filter((arg) => arg === '-p')).toHaveLength(1);
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

  it('injects codex headless args when absent', async () => {
    resolveAgentMock.mockReturnValue('codex');
    resolveModeMock.mockReturnValue('headless');
    readFileMock.mockResolvedValueOnce(makePrompt('codex'));
    mockSpawnResult();

    await runPrompt('test', { mode: 'headless' });

    expect(spawnedArgs().slice(0, 4)).toEqual([
      'exec',
      '--full-auto',
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

    expect(spawnedArgs().slice(0, 4)).toEqual([
      'exec',
      '--full-auto',
      '-c',
      'sandbox_workspace_write.network_access=true',
    ]);
  });

  it('strips codex headless args for interactive mode', async () => {
    resolveAgentMock.mockReturnValue('codex');
    resolveModeMock.mockReturnValue('interactive');
    readFileMock.mockResolvedValueOnce(
      makePrompt('codex', [
        'exec',
        '--full-auto',
        '-c',
        'sandbox_workspace_write.network_access=true',
      ])
    );
    mockSpawnResult();

    await runPrompt('test', { mode: 'interactive' });

    expect(spawnedArgs()).not.toContain('exec');
    expect(spawnedArgs()).not.toContain('--full-auto');
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
    expect(spawnedArgs()).not.toContain('--full-auto');
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

    const child = Object.assign(new EventEmitter(), { kill: vi.fn() }) as EventEmitter & {
      kill: ReturnType<typeof vi.fn>;
    };
    spawnMock.mockReturnValueOnce(child);

    const promise = runPrompt('test', { mode: 'headless' });

    await vi.advanceTimersByTimeAsync(60 * 60_000);

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(errorMock).toHaveBeenCalledWith('Agent timed out after 60 minutes');

    child.emit('close', 143);
    await expect(promise).resolves.toBe(143);
  });

  it('sends SIGKILL after 10s grace period if process does not exit', async () => {
    resolveModeMock.mockReturnValue('headless');
    getSettingsMock.mockReturnValue({ agentTimeoutMinutes: 60 });
    readFileMock.mockResolvedValueOnce(makePrompt('claude'));

    const child = Object.assign(new EventEmitter(), { kill: vi.fn() }) as EventEmitter & {
      kill: ReturnType<typeof vi.fn>;
    };
    spawnMock.mockReturnValueOnce(child);

    const promise = runPrompt('test', { mode: 'headless' });

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');

    child.emit('close', 137);
    await expect(promise).resolves.toBe(137);
  });

  it('does not set timeout in interactive mode', async () => {
    resolveModeMock.mockReturnValue('interactive');
    getSettingsMock.mockReturnValue({ agentTimeoutMinutes: 60 });
    readFileMock.mockResolvedValueOnce(makePrompt('claude'));

    const child = Object.assign(new EventEmitter(), { kill: vi.fn() }) as EventEmitter & {
      kill: ReturnType<typeof vi.fn>;
    };
    spawnMock.mockReturnValueOnce(child);

    const promise = runPrompt('test', { mode: 'interactive' });

    await vi.advanceTimersByTimeAsync(60 * 60_000 + 10_000);
    expect(child.kill).not.toHaveBeenCalled();

    child.emit('close', 0);
    await expect(promise).resolves.toBe(0);
  });

  it('does not set timeout when agentTimeoutMinutes is 0', async () => {
    resolveModeMock.mockReturnValue('headless');
    getSettingsMock.mockReturnValue({ agentTimeoutMinutes: 0 });
    readFileMock.mockResolvedValueOnce(makePrompt('claude'));

    const child = Object.assign(new EventEmitter(), { kill: vi.fn() }) as EventEmitter & {
      kill: ReturnType<typeof vi.fn>;
    };
    spawnMock.mockReturnValueOnce(child);

    const promise = runPrompt('test', { mode: 'headless' });

    await vi.advanceTimersByTimeAsync(120 * 60_000);
    expect(child.kill).not.toHaveBeenCalled();

    child.emit('close', 0);
    await expect(promise).resolves.toBe(0);
  });

  it('forces non-zero exit code when agent exits 0 after timeout', async () => {
    resolveModeMock.mockReturnValue('headless');
    getSettingsMock.mockReturnValue({ agentTimeoutMinutes: 60 });
    readFileMock.mockResolvedValueOnce(makePrompt('claude'));

    const child = Object.assign(new EventEmitter(), { kill: vi.fn() }) as EventEmitter & {
      kill: ReturnType<typeof vi.fn>;
    };
    spawnMock.mockReturnValueOnce(child);

    const promise = runPrompt('test', { mode: 'headless' });

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    // Agent handles SIGTERM and exits with 0
    child.emit('close', 0);
    await expect(promise).resolves.toBe(1);
  });

  it('clears timers on normal exit before timeout', async () => {
    resolveModeMock.mockReturnValue('headless');
    getSettingsMock.mockReturnValue({ agentTimeoutMinutes: 60 });
    readFileMock.mockResolvedValueOnce(makePrompt('claude'));

    const child = Object.assign(new EventEmitter(), { kill: vi.fn() }) as EventEmitter & {
      kill: ReturnType<typeof vi.fn>;
    };
    spawnMock.mockReturnValueOnce(child);

    const promise = runPrompt('test', { mode: 'headless' });

    // Flush microtasks so runPrompt reaches the spawn call
    await vi.advanceTimersByTimeAsync(0);

    // Process exits normally before timeout
    child.emit('close', 0);
    await expect(promise).resolves.toBe(0);

    // Advance past the timeout — should not fire
    await vi.advanceTimersByTimeAsync(60 * 60_000 + 10_000);
    expect(child.kill).not.toHaveBeenCalled();
  });
});
