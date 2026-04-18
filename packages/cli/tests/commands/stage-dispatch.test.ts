import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StageRunResult } from '@dnsquared/shipper-core';

const tryResolvePrForIssueMock =
  vi.fn<(repo: string, issueNumber: number) => Promise<string | undefined>>();
const loggerLogMock = vi.fn<(message: string) => void>();
const runGroomStageMock =
  vi.fn<
    (
      repo: string,
      issue: string,
      mode?: string,
      agent?: string,
      model?: string
    ) => Promise<StageRunResult>
  >();
const runDesignStageMock =
  vi.fn<
    (
      repo: string,
      issue: string,
      mode?: string,
      agent?: string,
      model?: string
    ) => Promise<StageRunResult>
  >();
const runPlanStageMock =
  vi.fn<
    (
      repo: string,
      issue: string,
      mode?: string,
      agent?: string,
      model?: string
    ) => Promise<StageRunResult>
  >();
const runImplementStageMock =
  vi.fn<
    (
      repo: string,
      issue: string,
      mode?: string,
      agent?: string,
      model?: string
    ) => Promise<StageRunResult>
  >();
const runPrOpenStageMock =
  vi.fn<
    (
      repo: string,
      issue: string,
      mode?: string,
      agent?: string,
      model?: string
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
      model?: string
    ) => Promise<StageRunResult>
  >();
const runPrRemediateStageMock =
  vi.fn<
    (
      repo: string,
      issue: string,
      pr: string,
      options?: { mode?: string; agent?: string; model?: string; skipInitialWait?: boolean }
    ) => Promise<StageRunResult>
  >();

const successResult: StageRunResult = { success: true, exitCode: 0, verdict: 'accept' };

vi.mock('@dnsquared/shipper-core', () => ({
  DESIGNED_LABEL: 'shipper:designed',
  GROOMED_LABEL: 'shipper:groomed',
  IMPLEMENTED_LABEL: 'shipper:implemented',
  NEW_LABEL: 'shipper:new',
  PLANNED_LABEL: 'shipper:planned',
  PR_OPEN_LABEL: 'shipper:pr-open',
  PR_REVIEWED_LABEL: 'shipper:pr-reviewed',
  READY_LABEL: 'shipper:ready',
  logger: {
    log: loggerLogMock,
  },
  tryResolvePrForIssue: tryResolvePrForIssueMock,
}));

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

describe('runStageForLabel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runGroomStageMock.mockResolvedValue(successResult);
    runDesignStageMock.mockResolvedValue(successResult);
    runPlanStageMock.mockResolvedValue(successResult);
    runImplementStageMock.mockResolvedValue(successResult);
    runPrOpenStageMock.mockResolvedValue(successResult);
    runPrReviewStageMock.mockResolvedValue(successResult);
    runPrRemediateStageMock.mockResolvedValue(successResult);
    tryResolvePrForIssueMock.mockResolvedValue('200');
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
      'gpt-5'
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
      'gpt-5'
    );
  });

  it('resolves the linked PR before review dispatch', async () => {
    const { runStageForLabel } = await import('../../src/commands/stage-dispatch.js');

    await expect(
      runStageForLabel('owner/repo', '159', 'shipper:pr-open', {
        mode: 'headless',
        agent: 'codex',
        model: 'gpt-5',
      })
    ).resolves.toEqual(successResult);

    expect(tryResolvePrForIssueMock).toHaveBeenCalledWith('owner/repo', 159);
    expect(runPrReviewStageMock).toHaveBeenCalledWith(
      'owner/repo',
      '159',
      '200',
      'headless',
      'codex',
      'gpt-5'
    );
  });

  it('forwards the remediate skip-wait option through the dispatcher', async () => {
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
      skipInitialWait: true,
    });
  });

  it('treats ready as a no-op success', async () => {
    const { runStageForLabel } = await import('../../src/commands/stage-dispatch.js');

    await expect(runStageForLabel('owner/repo', '159', 'shipper:ready')).resolves.toEqual({
      success: true,
      exitCode: 0,
    });
    expect(runPrRemediateStageMock).not.toHaveBeenCalled();
    expect(loggerLogMock).toHaveBeenCalledWith(
      'Issue #159 is ready — no remaining workflow steps.'
    );
  });

  it('throws when the linked PR is missing for PR stages', async () => {
    tryResolvePrForIssueMock.mockResolvedValueOnce(undefined);
    const { runStageForLabel } = await import('../../src/commands/stage-dispatch.js');

    await expect(runStageForLabel('owner/repo', '159', 'shipper:pr-open')).rejects.toThrow(
      'No open PR found for issue #159. Run `shipper pr open 159` first.'
    );
    expect(runPrReviewStageMock).not.toHaveBeenCalled();
  });
});
