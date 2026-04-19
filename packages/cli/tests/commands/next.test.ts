import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StageRunResult } from './stage-result.js';

import { createFakeCore } from '../_harness/fake-core.js';

type FakeCore = ReturnType<typeof createFakeCore>;
type DispatchOptions = {
  mode?: 'default' | 'interactive' | 'headless';
  agent?: string;
  model?: string;
};

const repo = 'owner/repo';
const runStageForLabelMock =
  vi.fn<
    (
      repo: string,
      issue: string,
      label: string,
      options: DispatchOptions
    ) => Promise<StageRunResult>
  >();

vi.mock('../../src/commands/stage-dispatch.js', () => ({
  runStageForLabel: runStageForLabelMock,
}));

describe('nextCommand', () => {
  let fake: FakeCore;

  const stubIssueRefLookup = (issueNumber: string): void => {
    fake.stubGh((args) => {
      if (
        args[0] === 'pr' &&
        args[1] === 'view' &&
        args[2] === issueNumber &&
        args.includes('--json') &&
        args.includes('number,body')
      ) {
        throw new Error('not a pull request');
      }

      if (
        args[0] === 'issue' &&
        args[1] === 'view' &&
        args[2] === issueNumber &&
        args.includes('--json') &&
        args.includes('number,labels')
      ) {
        const issue = fake.state.issues.get(issueNumber);
        return {
          stdout: JSON.stringify({
            number: Number(issueNumber),
            labels: [...(issue?.labels ?? [])].map((name) => ({ name })),
          }),
          stderr: '',
        };
      }

      return undefined;
    });
  };

  beforeEach(() => {
    fake = createFakeCore();
    fake.install();
    process.exitCode = undefined;
    runStageForLabelMock.mockResolvedValue({
      success: true,
      exitCode: 0,
      verdict: 'accept',
    });
  });

  afterEach(async () => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    await fake.dispose();
  });

  it('wraps dispatch in the issue lock and forwards prompt overrides', async () => {
    fake.setIssue('159', {
      labels: ['shipper:planned', 'shipper:priority-high'],
      title: 'Next issue',
    });
    stubIssueRefLookup('159');

    const { nextCommand } = await import('../../src/commands/next.js');

    await expect(nextCommand(repo, '159', 'interactive', 'codex', 'gpt-5')).resolves.toBe(
      undefined
    );

    expect(runStageForLabelMock).toHaveBeenCalledWith(repo, '159', 'shipper:planned', {
      mode: 'interactive',
      agent: 'codex',
      model: 'gpt-5',
    });
    expect(fake.state.labelTransitions).toEqual([
      { target: 'issue', number: '159', add: ['shipper:locked'], remove: [] },
      { target: 'issue', number: '159', add: [], remove: ['shipper:locked'] },
    ]);
    expect(process.exitCode).toBe(0);
  });

  it('allows blocked shipper:new issues to proceed', async () => {
    fake.setIssue('159', {
      labels: ['shipper:new', 'shipper:blocked'],
      title: 'Blocked new issue',
    });
    stubIssueRefLookup('159');

    const { nextCommand } = await import('../../src/commands/next.js');

    await nextCommand(repo, '159');

    expect(runStageForLabelMock).toHaveBeenCalledWith(repo, '159', 'shipper:new', {
      mode: undefined,
      agent: undefined,
      model: undefined,
    });
  });

  it('rejects blocked non-new issues before dispatch', async () => {
    fake.setIssue('159', {
      labels: ['shipper:planned', 'shipper:blocked'],
      title: 'Blocked planned issue',
    });
    stubIssueRefLookup('159');

    const { nextCommand } = await import('../../src/commands/next.js');

    await expect(nextCommand(repo, '159')).rejects.toThrow(
      "Issue #159 is blocked. Run 'shipper unblock 159' to check if it can proceed."
    );
    expect(runStageForLabelMock).not.toHaveBeenCalled();
    expect(fake.state.labelTransitions).toEqual([]);
  });

  it('rejects failed issues before dispatch', async () => {
    fake.setIssue('159', {
      labels: ['shipper:planned', 'shipper:failed'],
      title: 'Failed issue',
    });
    stubIssueRefLookup('159');

    const { nextCommand } = await import('../../src/commands/next.js');

    await expect(nextCommand(repo, '159')).rejects.toThrow(
      'Issue #159 has the shipper:failed label.'
    );
    expect(runStageForLabelMock).not.toHaveBeenCalled();
    expect(fake.state.labelTransitions).toEqual([]);
  });

  it('rejects issues with multiple workflow labels', async () => {
    fake.setIssue('159', {
      labels: ['shipper:groomed', 'shipper:planned'],
      title: 'Conflicted issue',
    });
    stubIssueRefLookup('159');

    const { nextCommand } = await import('../../src/commands/next.js');

    await expect(nextCommand(repo, '159')).rejects.toThrow(
      'Multiple shipper labels found on issue #159. Please resolve manually.'
    );
    expect(runStageForLabelMock).not.toHaveBeenCalled();
    expect(fake.state.labelTransitions).toEqual([]);
  });

  it('rejects issues without a workflow label', async () => {
    fake.setIssue('159', {
      labels: ['shipper:blocked'],
      title: 'No workflow issue',
    });
    stubIssueRefLookup('159');

    const { nextCommand } = await import('../../src/commands/next.js');

    await expect(nextCommand(repo, '159')).rejects.toThrow(
      'No shipper label found on issue #159. Use `shipper new` to start the workflow.'
    );
    expect(runStageForLabelMock).not.toHaveBeenCalled();
    expect(fake.state.labelTransitions).toEqual([]);
  });

  it('propagates the dispatcher exit code back to the CLI boundary', async () => {
    fake.setIssue('159', {
      labels: ['shipper:planned'],
      title: 'Planned issue',
    });
    stubIssueRefLookup('159');
    runStageForLabelMock.mockResolvedValueOnce({
      success: false,
      exitCode: 7,
      error: 'stage failed',
    });

    const { nextCommand } = await import('../../src/commands/next.js');

    await expect(nextCommand(repo, '159')).resolves.toBeUndefined();

    expect(process.exitCode).toBe(7);
  });
});
