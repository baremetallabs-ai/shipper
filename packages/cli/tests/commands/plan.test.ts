import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const autoSelectIssueMock = vi.fn();
const handleAgentCrashMock = vi.fn(async () => {});
const processResultMock = vi.fn(async () => ({
  verdict: 'accept',
  comment: '.shipper/output/comment-123.md',
}));
const runPromptMock = vi.fn(async () => 9);
const scrubOutputDirMock = vi.fn(async () => {});
const withIssueLockMock = vi.fn(
  async (_repo: unknown, _issue: unknown, fn: () => Promise<unknown>) => await fn()
);
const withStageHooksMock = vi.fn(
  async (_stage: unknown, _env: unknown, fn: () => Promise<unknown>) => await fn()
);

vi.mock('@dnsquared/shipper-core', () => ({
  autoSelectIssue: autoSelectIssueMock,
  handleAgentCrash: handleAgentCrashMock,
  processResult: processResultMock,
  runPrompt: runPromptMock,
  scrubOutputDir: scrubOutputDirMock,
  withIssueLock: withIssueLockMock,
  withStageHooks: withStageHooksMock,
}));

describe('planCommand', () => {
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

  it('scrubs output and processes protocol results after running the prompt', async () => {
    const { planCommand } = await import('../../src/commands/plan.js');
    const cwd = process.cwd();

    await expect(planCommand('owner/repo', '123')).resolves.toBeUndefined();

    expect(scrubOutputDirMock).toHaveBeenCalledWith(cwd);
    expect(runPromptMock).toHaveBeenCalledWith('plan', {
      repo: 'owner/repo',
      issueRef: '123',
      mode: undefined,
      agent: undefined,
      model: undefined,
    });
    expect(processResultMock).toHaveBeenCalledWith({
      repo: 'owner/repo',
      issueNumber: '123',
      stage: 'plan',
      cwd,
    });
    expect(handleAgentCrashMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('reports protocol crashes and exits with code 1', async () => {
    processResultMock.mockRejectedValueOnce(new Error('Invalid result.json'));
    const { planCommand } = await import('../../src/commands/plan.js');

    await expect(planCommand('owner/repo', '123')).resolves.toBeUndefined();

    expect(handleAgentCrashMock).toHaveBeenCalledWith(
      'owner/repo',
      '123',
      'plan',
      'Invalid result.json'
    );
    expect(process.exitCode).toBe(1);
  });
});
