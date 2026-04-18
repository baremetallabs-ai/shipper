import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StageRunResult } from '@dnsquared/shipper-core';

type DispatchOptions = {
  mode?: 'default' | 'interactive' | 'headless';
  agent?: string;
  model?: string;
};

const ghMock = vi.fn<(args: string[]) => Promise<{ stdout: string; stderr: string }>>();
const resolveRefMock =
  vi.fn<(repo: string, ref: string, type: 'issue') => Promise<{ issueNumber: string }>>();
const withIssueLockMock =
  vi.fn<
    (repo: string, issue: string, fn: () => Promise<StageRunResult>) => Promise<StageRunResult>
  >();
const runStageForLabelMock =
  vi.fn<
    (
      repo: string,
      issue: string,
      label: string,
      options: DispatchOptions
    ) => Promise<StageRunResult>
  >();
const parseIssueNumberLabelsMock = (json: string) =>
  JSON.parse(json) as { number: number; labels: Array<{ name: string }> };

vi.mock('@dnsquared/shipper-core', () => ({
  BLOCKED_LABEL: 'shipper:blocked',
  CONTROL_LABEL_NAMES: ['shipper:blocked', 'shipper:locked', 'shipper:failed'],
  FAILED_LABEL: 'shipper:failed',
  NEW_LABEL: 'shipper:new',
  PRIORITY_LABEL_NAMES: ['shipper:priority-high', 'shipper:priority-low'],
  gh: ghMock,
  parseIssueNumberLabels: parseIssueNumberLabelsMock,
  resolveRef: resolveRefMock,
  withIssueLock: withIssueLockMock,
}));

vi.mock('../../src/commands/stage-dispatch.js', () => ({
  runStageForLabel: runStageForLabelMock,
}));

describe('nextCommand', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    resolveRefMock.mockResolvedValue({ issueNumber: '159' });
    ghMock.mockResolvedValue({ stdout: '', stderr: '' });
    withIssueLockMock.mockImplementation(
      async (_repo: string, _issue: string, fn: () => Promise<StageRunResult>) => await fn()
    );
    runStageForLabelMock.mockResolvedValue({
      success: true,
      exitCode: 0,
      verdict: 'accept',
    } satisfies StageRunResult);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = undefined;
    errorSpy.mockRestore();
  });

  it('wraps dispatch in the issue lock and forwards prompt overrides', async () => {
    ghMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 159,
        labels: [{ name: 'shipper:planned' }, { name: 'shipper:priority-high' }],
      }),
      stderr: '',
    });

    const { nextCommand } = await import('../../src/commands/next.js');

    await expect(nextCommand('owner/repo', '159', 'interactive', 'codex', 'gpt-5')).resolves.toBe(
      undefined
    );

    expect(resolveRefMock).toHaveBeenCalledWith('owner/repo', '159', 'issue');
    expect(withIssueLockMock).toHaveBeenCalledWith('owner/repo', '159', expect.any(Function));
    expect(runStageForLabelMock).toHaveBeenCalledWith('owner/repo', '159', 'shipper:planned', {
      mode: 'interactive',
      agent: 'codex',
      model: 'gpt-5',
    });
    expect(process.exitCode).toBe(0);
  });

  it('allows blocked shipper:new issues to proceed', async () => {
    ghMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 159,
        labels: [{ name: 'shipper:new' }, { name: 'shipper:blocked' }],
      }),
      stderr: '',
    });

    const { nextCommand } = await import('../../src/commands/next.js');

    await nextCommand('owner/repo', '159');

    expect(runStageForLabelMock).toHaveBeenCalledWith('owner/repo', '159', 'shipper:new', {
      mode: undefined,
      agent: undefined,
      model: undefined,
    });
  });

  it('rejects blocked non-new issues before dispatch', async () => {
    ghMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 159,
        labels: [{ name: 'shipper:planned' }, { name: 'shipper:blocked' }],
      }),
      stderr: '',
    });

    const { nextCommand } = await import('../../src/commands/next.js');

    await expect(nextCommand('owner/repo', '159')).rejects.toThrow(
      "Issue #159 is blocked. Run 'shipper unblock 159' to check if it can proceed."
    );
    expect(withIssueLockMock).not.toHaveBeenCalled();
    expect(runStageForLabelMock).not.toHaveBeenCalled();
  });

  it('rejects failed issues before dispatch', async () => {
    ghMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 159,
        labels: [{ name: 'shipper:planned' }, { name: 'shipper:failed' }],
      }),
      stderr: '',
    });

    const { nextCommand } = await import('../../src/commands/next.js');

    await expect(nextCommand('owner/repo', '159')).rejects.toThrow(
      'Issue #159 has the shipper:failed label.'
    );
    expect(withIssueLockMock).not.toHaveBeenCalled();
  });

  it('rejects issues with multiple workflow labels', async () => {
    ghMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 159,
        labels: [{ name: 'shipper:groomed' }, { name: 'shipper:planned' }],
      }),
      stderr: '',
    });

    const { nextCommand } = await import('../../src/commands/next.js');

    await expect(nextCommand('owner/repo', '159')).rejects.toThrow(
      'Multiple shipper labels found on issue #159. Please resolve manually.'
    );
    expect(withIssueLockMock).not.toHaveBeenCalled();
  });

  it('rejects issues without a workflow label', async () => {
    ghMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 159,
        labels: [{ name: 'shipper:blocked' }],
      }),
      stderr: '',
    });

    const { nextCommand } = await import('../../src/commands/next.js');

    await expect(nextCommand('owner/repo', '159')).rejects.toThrow(
      'No shipper label found on issue #159. Use `shipper new` to start the workflow.'
    );
    expect(withIssueLockMock).not.toHaveBeenCalled();
  });

  it('propagates the dispatcher exit code back to the CLI boundary', async () => {
    ghMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 159,
        labels: [{ name: 'shipper:planned' }],
      }),
      stderr: '',
    });
    runStageForLabelMock.mockResolvedValueOnce({
      success: false,
      exitCode: 7,
      error: 'stage failed',
    } satisfies StageRunResult);

    const { nextCommand } = await import('../../src/commands/next.js');

    await expect(nextCommand('owner/repo', '159')).resolves.toBeUndefined();

    expect(process.exitCode).toBe(7);
  });
});
