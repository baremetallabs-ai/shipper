import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  fetchIssueMock,
  ghMock,
  handleAgentCrashMock,
  loggerMock,
  processResultMock,
  retryOnInvalidOutputMock,
  runPromptMock,
  scrubOutputDirMock,
  setupProtocolDirsMock,
  validatedResult,
  withIssueLockMock,
  writeContextFileMock,
} = vi.hoisted(() => {
  const validatedResult = {
    verdict: 'accept' as const,
    comment: '.shipper/output/comment-250.md',
  };

  return {
    fetchIssueMock: vi.fn(),
    ghMock: vi.fn<(args: string[]) => Promise<{ stdout: string; stderr: string }>>(),
    handleAgentCrashMock: vi.fn(() => Promise.resolve()),
    loggerMock: {
      log: (message: string) => {
        console.log(`[shipper] ${message}`);
      },
      warn: (message: string) => {
        console.warn(`[shipper] ${message}`);
      },
      error: (message: string) => {
        console.error(`[shipper] ${message}`);
      },
    },
    processResultMock: vi.fn(() => Promise.resolve(validatedResult)),
    retryOnInvalidOutputMock: vi.fn<
      (opts: {
        cwd: string;
        stage: string;
        retry: (message: string) => Promise<number>;
      }) => Promise<typeof validatedResult>
    >(() => Promise.resolve(validatedResult)),
    runPromptMock: vi.fn(() => Promise.resolve(0)),
    scrubOutputDirMock: vi.fn(() => Promise.resolve()),
    setupProtocolDirsMock: vi.fn(() => Promise.resolve()),
    validatedResult,
    withIssueLockMock: vi.fn((_repo: unknown, _issue: unknown, fn: () => Promise<unknown>) => fn()),
    writeContextFileMock: vi.fn(() => Promise.resolve()),
  };
});

vi.mock('@dnsquared/shipper-core', async () => {
  const { parseIssueStateTitle, parsePrStateMergedTitle, toError, toErrorMessage } =
    await vi.importActual<typeof import('@dnsquared/shipper-core')>('@dnsquared/shipper-core');

  return {
    logger: loggerMock,
    toError,
    toErrorMessage,
    parseIssueStateTitle,
    parsePrStateMergedTitle,
    fetchIssue: fetchIssueMock,
    gh: ghMock,
    handleAgentCrash: handleAgentCrashMock,
    processResult: processResultMock,
    retryOnInvalidOutput: retryOnInvalidOutputMock,
    runPrompt: runPromptMock,
    scrubOutputDir: scrubOutputDirMock,
    setupProtocolDirs: setupProtocolDirsMock,
    withIssueLock: withIssueLockMock,
    writeContextFile: writeContextFileMock,
  };
});

describe('prepareUnblockContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes dependency context for referenced issues and PRs while deduplicating refs', async () => {
    fetchIssueMock.mockResolvedValue(`
<issue number="250">
  <comments>
    <comment>Blocked by #248, #248, and #249. Ignore #250.</comment>
  </comments>
</issue>`);
    ghMock.mockImplementation((args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view' && args[2] === '248') {
        return Promise.resolve({
          stdout: JSON.stringify({ title: 'Core protocol infra', state: 'CLOSED' }),
          stderr: '',
        });
      }

      if (args[0] === 'issue' && args[1] === 'view' && args[2] === '249') {
        return Promise.resolve({
          stdout: JSON.stringify({ title: 'Protocol PR', state: 'CLOSED' }),
          stderr: '',
        });
      }

      if (args[0] === 'pr' && args[1] === 'view' && args[2] === '248') {
        throw new Error('not a pr');
      }

      if (args[0] === 'pr' && args[1] === 'view' && args[2] === '249') {
        return Promise.resolve({
          stdout: JSON.stringify({
            title: 'Protocol PR',
            state: 'MERGED',
            mergedAt: '2026-03-14T03:00:00Z',
          }),
          stderr: '',
        });
      }

      throw new Error(`Unexpected gh args: ${args.join(' ')}`);
    });

    const { prepareUnblockContext } = await import('../../src/commands/unblock.js');

    await prepareUnblockContext('owner/repo', '250', '/tmp/project');

    expect(setupProtocolDirsMock).toHaveBeenCalledWith('/tmp/project');
    expect(writeContextFileMock).toHaveBeenCalledTimes(1);
    expect(writeContextFileMock).toHaveBeenCalledWith(
      '/tmp/project',
      'dependencies.md',
      expect.stringContaining('# Dependency Status')
    );
    const markdown = writeContextFileMock.mock.calls[0]?.[2];
    expect(markdown).toContain('## #248');
    expect(markdown).toContain('- **Type**: Issue');
    expect(markdown).toContain('- **Title**: Core protocol infra');
    expect(markdown).toContain('- **State**: CLOSED');
    expect(markdown).toContain('## #249');
    expect(markdown).toContain('- **Type**: PR');
    expect(markdown).toContain('- **State**: MERGED (merged 2026-03-14)');
    expect(markdown).not.toContain('## #250');
    expect(ghMock).toHaveBeenCalledTimes(4);
  });

  it('writes an empty dependency status file when no refs remain after filtering', async () => {
    fetchIssueMock.mockResolvedValue(`
<issue number="250">
  <comments>
    <comment>No dependencies here.</comment>
  </comments>
</issue>`);
    const { prepareUnblockContext } = await import('../../src/commands/unblock.js');

    await prepareUnblockContext('owner/repo', '250', '/tmp/project');

    expect(setupProtocolDirsMock).toHaveBeenCalledWith('/tmp/project');
    expect(writeContextFileMock).toHaveBeenCalledWith(
      '/tmp/project',
      'dependencies.md',
      '# Dependency Status\n'
    );
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('excludes self references when building dependency context', async () => {
    fetchIssueMock.mockResolvedValue(`
<issue number="250">
  <comments>
    <comment>Blocked by #250 and #251.</comment>
  </comments>
</issue>`);
    ghMock.mockImplementation((args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view' && args[2] === '251') {
        return Promise.resolve({
          stdout: JSON.stringify({ title: 'Follow-up issue', state: 'OPEN' }),
          stderr: '',
        });
      }

      if (args[0] === 'pr' && args[1] === 'view' && args[2] === '251') {
        throw new Error('not a pr');
      }

      throw new Error(`Unexpected gh args: ${args.join(' ')}`);
    });
    const { prepareUnblockContext } = await import('../../src/commands/unblock.js');

    await prepareUnblockContext('owner/repo', '250', '/tmp/project');

    const markdown = writeContextFileMock.mock.calls[0]?.[2];
    expect(markdown).toContain('## #251');
    expect(markdown).not.toContain('## #250');
  });

  it('records unknown dependency refs instead of aborting when an issue lookup fails', async () => {
    fetchIssueMock.mockResolvedValue(`
<issue number="250">
  <comments>
    <comment>Blocked by #248 and #9999.</comment>
  </comments>
</issue>`);
    ghMock.mockImplementation((args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view' && args[2] === '248') {
        return Promise.resolve({
          stdout: JSON.stringify({ title: 'Core protocol infra', state: 'CLOSED' }),
          stderr: '',
        });
      }

      if (args[0] === 'issue' && args[1] === 'view' && args[2] === '9999') {
        throw new Error('issue not found');
      }

      if (args[0] === 'pr' && args[1] === 'view' && args[2] === '248') {
        throw new Error('not a pr');
      }

      throw new Error(`Unexpected gh args: ${args.join(' ')}`);
    });

    const { prepareUnblockContext } = await import('../../src/commands/unblock.js');

    await prepareUnblockContext('owner/repo', '250', '/tmp/project');

    const markdown = writeContextFileMock.mock.calls[0]?.[2];
    expect(markdown).toContain('## #248');
    expect(markdown).toContain('## #9999');
    expect(markdown).toContain('- **Type**: Unknown');
    expect(markdown).toContain('- **Detail**: issue not found');
  });
});

describe('unblockCommand', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    });
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = undefined;
    exitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('scrubs output, prepares dependency context, and processes protocol results', async () => {
    const unblockModule = await import('../../src/commands/unblock.js');
    const cwd = process.cwd();
    fetchIssueMock.mockResolvedValue(`
<issue number="250">
  <comments>
    <comment>Blocked by #248.</comment>
  </comments>
</issue>`);
    ghMock.mockImplementation((args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view' && args[2] === '248') {
        return Promise.resolve({
          stdout: JSON.stringify({ title: 'Core protocol infra', state: 'CLOSED' }),
          stderr: '',
        });
      }

      if (args[0] === 'pr' && args[1] === 'view' && args[2] === '248') {
        throw new Error('not a pr');
      }

      throw new Error(`Unexpected gh args: ${args.join(' ')}`);
    });

    await expect(unblockModule.unblockCommand('owner/repo', '250')).resolves.toBeUndefined();

    expect(scrubOutputDirMock).toHaveBeenCalledWith(cwd);
    expect(setupProtocolDirsMock).toHaveBeenCalledWith(cwd);
    expect(writeContextFileMock).toHaveBeenCalledWith(
      cwd,
      'dependencies.md',
      expect.stringContaining('## #248')
    );
    expect(runPromptMock).toHaveBeenCalledWith('unblock', {
      repo: 'owner/repo',
      issueRef: '250',
      cwd,
      mode: undefined,
      agent: undefined,
      model: undefined,
    });
    const retryCall = retryOnInvalidOutputMock.mock.calls[0]?.[0] as
      | { cwd: string; stage: string; retry: (message: string) => Promise<number> }
      | undefined;
    expect(retryCall?.cwd).toBe(cwd);
    expect(retryCall?.stage).toBe('unblock');
    expect(retryCall?.retry).toEqual(expect.any(Function));
    expect(processResultMock).toHaveBeenCalledWith({
      repo: 'owner/repo',
      issueNumber: '250',
      stage: 'unblock',
      cwd,
      result: validatedResult,
    });
    expect(handleAgentCrashMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();

    await expect(retryCall?.retry('Fix result')).resolves.toBe(0);
    expect(runPromptMock).toHaveBeenLastCalledWith('unblock', {
      repo: 'owner/repo',
      issueRef: '250',
      cwd,
      mode: undefined,
      agent: undefined,
      model: undefined,
      userInput: 'Fix result',
    });
  });

  it('reports non-zero prompt exits and skips output validation', async () => {
    const unblockModule = await import('../../src/commands/unblock.js');
    fetchIssueMock.mockResolvedValue('<issue number="250"><comments></comments></issue>');
    runPromptMock.mockResolvedValueOnce(13);

    await expect(unblockModule.unblockCommand('owner/repo', '250')).resolves.toBeUndefined();

    expect(setupProtocolDirsMock).toHaveBeenCalled();
    expect(retryOnInvalidOutputMock).not.toHaveBeenCalled();
    expect(processResultMock).not.toHaveBeenCalled();
    expect(handleAgentCrashMock).toHaveBeenCalledWith(
      'owner/repo',
      '250',
      'unblock',
      'Agent exited with code 13',
      'The `unblock` agent run exited with code 13.'
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith('[shipper] Agent exited with code 13');
    expect(process.exitCode).toBe(1);
  });

  it('reports protocol crashes during result processing and exits with code 1', async () => {
    const unblockModule = await import('../../src/commands/unblock.js');
    fetchIssueMock.mockResolvedValue('<issue number="250"><comments></comments></issue>');
    processResultMock.mockRejectedValueOnce(new Error('Missing result.json'));

    await expect(unblockModule.unblockCommand('owner/repo', '250')).resolves.toBeUndefined();

    expect(retryOnInvalidOutputMock).toHaveBeenCalledTimes(1);
    expect(handleAgentCrashMock).toHaveBeenCalledWith(
      'owner/repo',
      '250',
      'unblock',
      'Missing result.json'
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith('[shipper] Missing result.json');
    expect(process.exitCode).toBe(1);
  });
});
