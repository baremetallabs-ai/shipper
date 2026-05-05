import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StageRunResult } from '@baremetallabs-ai/shipper-core';

import { createFakeCore } from '../_harness/fake-core.js';

const runGroomStageMock =
  vi.fn<
    (
      repo: string,
      issue: string,
      mode?: string,
      agent?: string,
      model?: string,
      disableMcp?: boolean
    ) => Promise<StageRunResult>
  >();
const runDesignStageMock =
  vi.fn<
    (
      repo: string,
      issue: string,
      mode?: string,
      agent?: string,
      model?: string,
      disableMcp?: boolean
    ) => Promise<StageRunResult>
  >();
const runPlanStageMock =
  vi.fn<
    (
      repo: string,
      issue: string,
      mode?: string,
      agent?: string,
      model?: string,
      disableMcp?: boolean
    ) => Promise<StageRunResult>
  >();
const runImplementStageMock =
  vi.fn<
    (
      repo: string,
      issue: string,
      mode?: string,
      agent?: string,
      model?: string,
      disableMcp?: boolean
    ) => Promise<StageRunResult>
  >();
const runPrOpenStageMock =
  vi.fn<
    (
      repo: string,
      issue: string,
      mode?: string,
      agent?: string,
      model?: string,
      disableMcp?: boolean
    ) => Promise<StageRunResult>
  >();
const runPrReviewStageMock =
  vi.fn<
    (
      repo: string,
      issue: string,
      pr: string,
      mode?: string,
      agent?: string,
      model?: string,
      disableMcp?: boolean
    ) => Promise<StageRunResult>
  >();
const runPrRemediateStageMock = vi.fn<
  (
    repo: string,
    issue: string,
    pr: string,
    options?: {
      mode?: string;
      agent?: string;
      model?: string;
      disableMcp?: boolean;
      skipInitialWait?: boolean;
    }
  ) => Promise<StageRunResult>
>();

const successResult: StageRunResult = { success: true, exitCode: 0, verdict: 'accept' };

vi.mock('../../src/commands/groom.js', () => ({
  runGroomStage: runGroomStageMock,
}));

vi.mock('../../src/commands/design.js', () => ({
  runDesignStage: runDesignStageMock,
}));

vi.mock('../../src/commands/plan.js', () => ({
  runPlanStage: runPlanStageMock,
}));

vi.mock('../../src/commands/implement.js', () => ({
  runImplementStage: runImplementStageMock,
}));

vi.mock('../../src/commands/pr-open.js', () => ({
  runPrOpenStage: runPrOpenStageMock,
}));

vi.mock('../../src/commands/pr-review.js', () => ({
  runPrReviewStage: runPrReviewStageMock,
}));

vi.mock('../../src/commands/pr-remediate.js', () => ({
  runPrRemediateStage: runPrRemediateStageMock,
}));

type FakeCore = ReturnType<typeof createFakeCore>;

describe('runStageForLabel', () => {
  let fake: FakeCore;

  const stubPrList = (issueNumber: string, prNumber?: string): void => {
    fake.stubGh((args) => {
      if (
        args[0] !== 'pr' ||
        args[1] !== 'list' ||
        getArgValue(args, '-R') !== 'owner/repo' ||
        getArgValue(args, '--state') !== 'open' ||
        getArgValue(args, '--json') !== 'number,headRefName' ||
        getArgValue(args, '--limit') !== '100'
      ) {
        return undefined;
      }

      const stdout = prNumber
        ? JSON.stringify([
            {
              number: Number(prNumber),
              headRefName: `shipper/${issueNumber}`,
            },
          ])
        : '[]';
      return { stdout, stderr: '' };
    });
  };

  beforeEach(() => {
    fake = createFakeCore();
    fake.install();
    fake.setIssue('159', { labels: ['shipper:pr-open'] });
    fake.setPr('200', { headRefName: 'shipper/159' });
    vi.clearAllMocks();
    runGroomStageMock.mockResolvedValue(successResult);
    runDesignStageMock.mockResolvedValue(successResult);
    runPlanStageMock.mockResolvedValue(successResult);
    runImplementStageMock.mockResolvedValue(successResult);
    runPrOpenStageMock.mockResolvedValue(successResult);
    runPrReviewStageMock.mockResolvedValue(successResult);
    runPrRemediateStageMock.mockResolvedValue(successResult);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fake.dispose();
  });

  it('dispatches the issue stages directly by label', async () => {
    const { runStageForLabel } = await import('../../src/commands/stage-dispatch.js');

    await expect(
      runStageForLabel('owner/repo', '159', 'shipper:new', {
        mode: 'interactive',
        agent: 'codex',
        model: 'gpt-5',
      })
    ).resolves.toEqual(successResult);
    expect(runGroomStageMock).toHaveBeenCalledWith(
      'owner/repo',
      '159',
      'interactive',
      'codex',
      'gpt-5',
      undefined
    );

    await expect(
      runStageForLabel('owner/repo', '159', 'shipper:designed', {
        mode: 'headless',
        agent: 'codex',
        model: 'gpt-5',
      })
    ).resolves.toEqual(successResult);
    expect(runPlanStageMock).toHaveBeenCalledWith(
      'owner/repo',
      '159',
      'headless',
      'codex',
      'gpt-5',
      undefined
    );
  });

  it('resolves the linked PR before review dispatch', async () => {
    stubPrList('159', '200');
    const { runStageForLabel } = await import('../../src/commands/stage-dispatch.js');

    await expect(
      runStageForLabel('owner/repo', '159', 'shipper:pr-open', {
        mode: 'headless',
        agent: 'codex',
        model: 'gpt-5',
      })
    ).resolves.toEqual(successResult);

    expect(runPrReviewStageMock).toHaveBeenCalledWith(
      'owner/repo',
      '159',
      '200',
      'headless',
      'codex',
      'gpt-5',
      undefined
    );
  });

  it('forwards the remediate skip-wait option through the dispatcher', async () => {
    stubPrList('159', '200');
    const { runStageForLabel } = await import('../../src/commands/stage-dispatch.js');

    await expect(
      runStageForLabel('owner/repo', '159', 'shipper:pr-reviewed', {
        mode: 'headless',
        agent: 'codex',
        model: 'gpt-5',
        skipInitialPrRemediateWait: true,
      })
    ).resolves.toEqual(successResult);

    expect(runPrRemediateStageMock).toHaveBeenCalledWith('owner/repo', '159', '200', {
      mode: 'headless',
      agent: 'codex',
      model: 'gpt-5',
      disableMcp: undefined,
      skipInitialWait: true,
    });
  });

  it('forwards disableMcp to stage runners', async () => {
    const { runStageForLabel } = await import('../../src/commands/stage-dispatch.js');

    await expect(
      runStageForLabel('owner/repo', '159', 'shipper:new', {
        disableMcp: true,
      })
    ).resolves.toEqual(successResult);

    expect(runGroomStageMock).toHaveBeenCalledWith(
      'owner/repo',
      '159',
      undefined,
      undefined,
      undefined,
      true
    );
  });

  it('treats ready as a no-op success', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runStageForLabel } = await import('../../src/commands/stage-dispatch.js');

    await expect(runStageForLabel('owner/repo', '159', 'shipper:ready')).resolves.toEqual({
      success: true,
      exitCode: 0,
    });
    expect(runPrRemediateStageMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      '[shipper] Issue #159 is ready — no remaining workflow steps.'
    );
  });

  it('throws when the linked PR is missing for PR stages', async () => {
    stubPrList('159');
    const { runStageForLabel } = await import('../../src/commands/stage-dispatch.js');

    await expect(runStageForLabel('owner/repo', '159', 'shipper:pr-open')).rejects.toThrow(
      'No open PR found for issue #159. Run `shipper pr open 159` first.'
    );
    expect(runPrReviewStageMock).not.toHaveBeenCalled();
  });
});

function getArgValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}
