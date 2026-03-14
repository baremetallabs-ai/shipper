import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchIssueMock = vi.fn();
const ghMock = vi.fn();
const handleAgentCrashMock = vi.fn(async () => {});
const processResultMock = vi.fn(async () => ({
  verdict: 'accept',
  comment: '.shipper/output/comment-250.md',
}));
const runPromptMock = vi.fn(async () => 0);
const scrubOutputDirMock = vi.fn(async () => {});
const setupProtocolDirsMock = vi.fn(async () => {});
const withIssueLockMock = vi.fn(
  async (_repo: unknown, _issue: unknown, fn: () => Promise<unknown>) => await fn()
);
const writeContextFileMock = vi.fn(async () => {});

vi.mock('@dnsquared/shipper-core', () => ({
  fetchIssue: fetchIssueMock,
  gh: ghMock,
  handleAgentCrash: handleAgentCrashMock,
  processResult: processResultMock,
  runPrompt: runPromptMock,
  scrubOutputDir: scrubOutputDirMock,
  setupProtocolDirs: setupProtocolDirsMock,
  withIssueLock: withIssueLockMock,
  writeContextFile: writeContextFileMock,
}));

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
    ghMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view' && args[2] === '248') {
        return {
          stdout: JSON.stringify({ title: 'Core protocol infra', state: 'CLOSED' }),
          stderr: '',
        };
      }

      if (args[0] === 'issue' && args[1] === 'view' && args[2] === '249') {
        return {
          stdout: JSON.stringify({ title: 'Protocol PR', state: 'CLOSED' }),
          stderr: '',
        };
      }

      if (args[0] === 'pr' && args[1] === 'view' && args[2] === '248') {
        throw new Error('not a pr');
      }

      if (args[0] === 'pr' && args[1] === 'view' && args[2] === '249') {
        return {
          stdout: JSON.stringify({
            title: 'Protocol PR',
            state: 'MERGED',
            mergedAt: '2026-03-14T03:00:00Z',
          }),
          stderr: '',
        };
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
    ghMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view' && args[2] === '251') {
        return {
          stdout: JSON.stringify({ title: 'Follow-up issue', state: 'OPEN' }),
          stderr: '',
        };
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
    ghMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view' && args[2] === '248') {
        return {
          stdout: JSON.stringify({ title: 'Core protocol infra', state: 'CLOSED' }),
          stderr: '',
        };
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

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    });
  });

  afterEach(() => {
    process.exitCode = undefined;
    exitSpy.mockRestore();
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
    ghMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view' && args[2] === '248') {
        return {
          stdout: JSON.stringify({ title: 'Core protocol infra', state: 'CLOSED' }),
          stderr: '',
        };
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
      mode: undefined,
      agent: undefined,
      model: undefined,
    });
    expect(processResultMock).toHaveBeenCalledWith({
      repo: 'owner/repo',
      issueNumber: '250',
      stage: 'unblock',
      cwd,
    });
    expect(handleAgentCrashMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('reports protocol crashes and exits with code 1', async () => {
    const unblockModule = await import('../../src/commands/unblock.js');
    fetchIssueMock.mockResolvedValue('<issue number="250"><comments></comments></issue>');
    processResultMock.mockRejectedValueOnce(new Error('Invalid result.json'));

    await expect(unblockModule.unblockCommand('owner/repo', '250')).resolves.toBeUndefined();

    expect(handleAgentCrashMock).toHaveBeenCalledWith(
      'owner/repo',
      '250',
      'unblock',
      'Invalid result.json'
    );
    expect(process.exitCode).toBe(1);
  });
});
