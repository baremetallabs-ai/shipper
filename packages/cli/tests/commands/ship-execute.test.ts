import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import * as core from '@baremetallabs-ai/shipper-core';

import { createFakeCore } from '../_harness/fake-core.js';

const {
  spawnMock,
  forkMock,
  runStageForLabelMock,
  buildReadyCheckMock,
  resolvePrForIssueMock,
  mergePrMock,
} = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  forkMock: vi.fn(),
  runStageForLabelMock: vi.fn(),
  buildReadyCheckMock: vi.fn(),
  resolvePrForIssueMock: vi.fn(),
  mergePrMock: vi.fn(),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: spawnMock,
    fork: forkMock,
    spawnSync: vi.fn(),
  };
});

vi.mock('../../src/commands/stage-dispatch.js', () => ({
  runStageForLabel: runStageForLabelMock,
}));

vi.mock('../../src/commands/pr-remediate.js', () => ({
  buildReadyCheck: buildReadyCheckMock,
}));

vi.mock('../../src/commands/ship-merge.js', () => ({
  resolvePrForIssue: resolvePrForIssueMock,
  mergePr: mergePrMock,
  isRetriableMergeFailure: (message?: string) => message?.includes('retriable') ?? false,
}));

type FakeCore = ReturnType<typeof createFakeCore>;

describe('shipOneIssue', () => {
  let fake: FakeCore;
  let resolveModeSpy: MockInstance;

  const scriptLabels = (labels: Array<string | undefined>): void => {
    fake.setIssue('42', { labels: labels[0] ? [labels[0]] : [] });
    const queued = [...labels];
    let readCount = 0;

    fake.stubGh((args) => {
      if (
        args[0] !== 'issue' ||
        args[1] !== 'view' ||
        args[2] !== '42' ||
        getArgValue(args, '--json') !== 'labels' ||
        getArgValue(args, '--jq') !== '.labels[].name'
      ) {
        return undefined;
      }

      if (readCount === 0) {
        // The lock probe inside acquireIssueLock consumes the first matching label read
        // before shipOneIssue starts its stage loop, so the queued labels stay aligned
        // with the subsequent getCurrentLabel calls under test.
        readCount += 1;
        return undefined;
      }

      const label = queued.shift();
      readCount += 1;
      return {
        stdout: label === undefined ? '' : `${label}\n`,
        stderr: '',
      };
    });
  };

  beforeEach(() => {
    fake = createFakeCore();
    fake.install();
    vi.clearAllMocks();
    resolveModeSpy = vi
      .spyOn(core, 'resolveMode')
      .mockImplementation((_step, override) => override ?? 'default');
    vi.spyOn(core, 'getSettings').mockReturnValue({
      ...core.DEFAULTS,
      prReviewWait: { mode: 'checks', maxDurationMinutes: 30 },
    });
    fake.scriptAggregateSessionUsage(() => ({
      inputTokens: 12,
      outputTokens: 8,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }));
    runStageForLabelMock.mockResolvedValue({ success: true, exitCode: 0, verdict: 'accept' });
    buildReadyCheckMock.mockResolvedValue(() => Promise.resolve(false));
    resolvePrForIssueMock.mockResolvedValue({
      number: 101,
      title: 'PR',
      headRefName: 'shipper/42',
      baseRefName: 'main',
    });
    mergePrMock.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fake.dispose();
  });

  it('runs sequential stages in-process without spawning child processes', async () => {
    scriptLabels(['shipper:planned', 'shipper:ready']);
    const { shipOneIssue } = await import('../../src/commands/ship-execute.js');

    await expect(shipOneIssue({ repo: 'owner/repo', issue: '42', merge: false })).resolves.toEqual({
      success: true,
      totalTokens: 20,
    });

    expect(runStageForLabelMock).toHaveBeenCalledWith('owner/repo', '42', 'shipper:planned', {
      mode: 'default',
      agent: undefined,
      model: undefined,
      disableMcp: undefined,
      skipInitialPrRemediateWait: false,
    });
    expect(fake.state.labelTransitions).toEqual(
      expect.arrayContaining([
        { target: 'issue', number: '42', add: ['shipper:locked'], remove: [] },
        { target: 'issue', number: '42', add: [], remove: ['shipper:locked'] },
      ])
    );
    expect(spawnMock).not.toHaveBeenCalled();
    expect(forkMock).not.toHaveBeenCalled();
  });

  it('skips interactive stages directly when configured to avoid them', async () => {
    scriptLabels(['shipper:new']);
    resolveModeSpy.mockReturnValue('interactive');
    const { shipOneIssue } = await import('../../src/commands/ship-execute.js');

    await expect(
      shipOneIssue({
        repo: 'owner/repo',
        issue: '42',
        merge: false,
        skipInteractiveStages: true,
        collectTokens: false,
      })
    ).resolves.toEqual({ success: true });

    expect(runStageForLabelMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(forkMock).not.toHaveBeenCalled();
  });

  it('passes the skip-initial-wait flag when resuming parked pr-remediate work', async () => {
    scriptLabels(['shipper:pr-reviewed', 'shipper:ready']);
    let parked = false;

    const { shipOneIssue } = await import('../../src/commands/ship-execute.js');

    await shipOneIssue({
      repo: 'owner/repo',
      issue: '42',
      merge: false,
      collectTokens: false,
      parkHooks: {
        shouldPark: () => Promise.resolve(true),
        park: ({ resume }) => {
          parked = true;
          resume();
        },
      },
    });

    expect(parked).toBe(true);
    expect(buildReadyCheckMock).toHaveBeenCalledWith('owner/repo', '101', {
      mode: 'checks',
      maxDurationMinutes: 30,
    });
    expect(runStageForLabelMock).toHaveBeenCalledWith('owner/repo', '42', 'shipper:pr-reviewed', {
      mode: 'default',
      agent: undefined,
      model: undefined,
      disableMcp: undefined,
      skipInitialPrRemediateWait: true,
    });
  });

  it('continues normal stage progression when the pause probe returns false', async () => {
    scriptLabels(['shipper:planned', 'shipper:ready']);
    const pauseProbe = vi.fn().mockResolvedValue(false);
    const { shipOneIssue } = await import('../../src/commands/ship-execute.js');

    await expect(
      shipOneIssue({
        repo: 'owner/repo',
        issue: '42',
        merge: false,
        collectTokens: false,
        pauseProbe,
      })
    ).resolves.toEqual({ success: true });

    expect(pauseProbe).toHaveBeenCalledTimes(1);
    expect(runStageForLabelMock).toHaveBeenCalledWith('owner/repo', '42', 'shipper:planned', {
      mode: 'default',
      agent: undefined,
      model: undefined,
      disableMcp: undefined,
      skipInitialPrRemediateWait: false,
    });
  });

  it('forwards disableMcp into stage dispatch during ship loops', async () => {
    scriptLabels(['shipper:planned', 'shipper:ready']);
    const { shipOneIssue } = await import('../../src/commands/ship-execute.js');

    await expect(
      shipOneIssue({
        repo: 'owner/repo',
        issue: '42',
        merge: false,
        disableMcp: true,
        collectTokens: false,
      })
    ).resolves.toEqual({ success: true });

    expect(runStageForLabelMock).toHaveBeenCalledWith('owner/repo', '42', 'shipper:planned', {
      mode: 'default',
      agent: undefined,
      model: undefined,
      disableMcp: true,
      skipInitialPrRemediateWait: false,
    });
  });

  it('exits cleanly with a paused result before starting the next stage when pause is requested', async () => {
    scriptLabels(['shipper:planned']);
    const pauseProbe = vi.fn().mockResolvedValue(true);
    const { shipOneIssue } = await import('../../src/commands/ship-execute.js');

    await expect(
      shipOneIssue({
        repo: 'owner/repo',
        issue: '42',
        merge: false,
        collectTokens: false,
        pauseProbe,
      })
    ).resolves.toEqual({ success: true, paused: true });

    expect(pauseProbe).toHaveBeenCalledTimes(1);
    expect(runStageForLabelMock).not.toHaveBeenCalled();
  });

  it('resumes after a reject, prints the reject transcript entry, and can still finish', async () => {
    scriptLabels([
      'shipper:groomed',
      'shipper:designed',
      'shipper:groomed',
      'shipper:designed',
      'shipper:planned',
      'shipper:implemented',
      'shipper:pr-open',
      'shipper:pr-reviewed',
      'shipper:ready',
    ]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let planRuns = 0;
    runStageForLabelMock.mockImplementation((_repo, _issue, label) => {
      if (label === 'shipper:designed') {
        planRuns += 1;
        return planRuns === 1
          ? { success: false, exitCode: 1, verdict: 'reject' }
          : { success: true, exitCode: 0, verdict: 'accept' };
      }
      return { success: true, exitCode: 0, verdict: 'accept' };
    });
    const { shipOneIssue } = await import('../../src/commands/ship-execute.js');

    await expect(
      shipOneIssue({ repo: 'owner/repo', issue: '42', merge: false, collectTokens: false })
    ).resolves.toEqual({ success: true });

    const dispatchedLabels = runStageForLabelMock.mock.calls.map((call): string => String(call[2]));
    expect(dispatchedLabels).toEqual([
      'shipper:groomed',
      'shipper:designed',
      'shipper:groomed',
      'shipper:designed',
      'shipper:planned',
      'shipper:implemented',
      'shipper:pr-open',
      'shipper:pr-reviewed',
    ]);
    const logs = logSpy.mock.calls.map(([line]) => String(line));
    const rejectIndex = logs.findIndex((line) =>
      line.includes('↻ plan — rejected to shipper:groomed')
    );
    const beforeIndex = logs.findIndex((line) => line.includes('✓ design'));
    const afterIndex = logs.findIndex(
      (line, index) => index > rejectIndex && line.includes('✓ design')
    );
    expect(rejectIndex).toBeGreaterThan(beforeIndex);
    expect(afterIndex).toBeGreaterThan(rejectIndex);
  });

  it('resumes a pr-remediate reject from shipper:pr-open and runs another review cycle', async () => {
    scriptLabels([
      'shipper:pr-reviewed',
      'shipper:pr-open',
      'shipper:pr-reviewed',
      'shipper:ready',
    ]);
    let prRemediateRuns = 0;
    runStageForLabelMock.mockImplementation((_repo, _issue, label) => {
      if (label === 'shipper:pr-reviewed') {
        prRemediateRuns += 1;
        return prRemediateRuns === 1
          ? { success: false, exitCode: 1, verdict: 'reject' }
          : { success: true, exitCode: 0, verdict: 'accept' };
      }
      return { success: true, exitCode: 0, verdict: 'accept' };
    });
    const { shipOneIssue } = await import('../../src/commands/ship-execute.js');

    await expect(
      shipOneIssue({ repo: 'owner/repo', issue: '42', merge: false, collectTokens: false })
    ).resolves.toEqual({ success: true });

    const dispatchedLabels = runStageForLabelMock.mock.calls.map((call): string => String(call[2]));
    expect(dispatchedLabels).toEqual([
      'shipper:pr-reviewed',
      'shipper:pr-open',
      'shipper:pr-reviewed',
    ]);
  });

  it('stops a single-issue run at shipper:new after a reject and asks for grooming', async () => {
    scriptLabels(['shipper:groomed', 'shipper:new']);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    runStageForLabelMock.mockResolvedValueOnce({ success: false, exitCode: 1, verdict: 'reject' });
    const { shipOneIssue } = await import('../../src/commands/ship-execute.js');

    await expect(
      shipOneIssue({ repo: 'owner/repo', issue: '42', merge: false, collectTokens: false })
    ).resolves.toEqual({ success: true });

    expect(runStageForLabelMock).toHaveBeenCalledTimes(1);
    expect(
      logSpy.mock.calls.some(([line]) =>
        String(line).includes(
          'Issue #42 rolled back to shipper:new after stage "design". Re-invoke after grooming.'
        )
      )
    ).toBe(true);
  });

  it('fails auto or worker-style runs when a reject rolls work back to shipper:new', async () => {
    scriptLabels(['shipper:groomed', 'shipper:new']);
    runStageForLabelMock.mockResolvedValueOnce({ success: false, exitCode: 1, verdict: 'reject' });
    const { shipOneIssue } = await import('../../src/commands/ship-execute.js');

    await expect(
      shipOneIssue({
        repo: 'owner/repo',
        issue: '42',
        merge: false,
        skipInteractiveStages: true,
        collectTokens: false,
      })
    ).resolves.toEqual({
      success: false,
      error:
        'Issue #42 rolled back to shipper:new after stage "design" - stopping to avoid interactive groom stage.',
    });
  });

  it('counts reject resumes toward the transition cap and relabels the issue as failed', async () => {
    scriptLabels([
      'shipper:designed',
      ...Array.from({ length: 15 }, (_, index) =>
        index % 2 === 0 ? 'shipper:groomed' : 'shipper:designed'
      ),
    ]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    runStageForLabelMock.mockImplementation((_repo, _issue, label) =>
      label === 'shipper:designed'
        ? { success: false, exitCode: 1, verdict: 'reject' }
        : { success: true, exitCode: 0, verdict: 'accept' }
    );
    const { shipOneIssue } = await import('../../src/commands/ship-execute.js');

    const result = await shipOneIssue({
      repo: 'owner/repo',
      issue: '42',
      merge: false,
      collectTokens: false,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Issue #42 hit transition cap (15)');
    expect(runStageForLabelMock).toHaveBeenCalledTimes(15);
    expect(fake.state.labelTransitions).toContainEqual({
      target: 'issue',
      number: '42',
      add: ['shipper:failed'],
      remove: ['shipper:groomed'],
    });
    expect(
      logSpy.mock.calls.some(([line]) =>
        String(line).includes('↻ plan — rejected to shipper:groomed')
      )
    ).toBe(true);
    expect(logSpy.mock.calls.some(([line]) => String(line).includes('✗ design — failed'))).toBe(
      true
    );
  });

  it('treats explicit fail verdicts as terminal failures', async () => {
    scriptLabels(['shipper:planned']);
    runStageForLabelMock.mockResolvedValueOnce({
      success: false,
      exitCode: 1,
      verdict: 'fail',
      error: 'stage failed',
    });
    const { shipOneIssue } = await import('../../src/commands/ship-execute.js');

    await expect(
      shipOneIssue({ repo: 'owner/repo', issue: '42', merge: false, collectTokens: false })
    ).resolves.toEqual({ success: false, error: 'stage failed' });
    expect(runStageForLabelMock).toHaveBeenCalledTimes(1);
  });

  it('treats crashes without a verdict as terminal failures', async () => {
    scriptLabels(['shipper:planned']);
    runStageForLabelMock.mockResolvedValueOnce({
      success: false,
      exitCode: 1,
      error: 'stage crashed',
    });
    const { shipOneIssue } = await import('../../src/commands/ship-execute.js');

    await expect(
      shipOneIssue({ repo: 'owner/repo', issue: '42', merge: false, collectTokens: false })
    ).resolves.toEqual({ success: false, error: 'stage crashed' });
    expect(runStageForLabelMock).toHaveBeenCalledTimes(1);
  });

  it('aborts when a reject does not move the workflow label', async () => {
    scriptLabels(['shipper:designed', 'shipper:designed']);
    runStageForLabelMock.mockResolvedValueOnce({ success: false, exitCode: 1, verdict: 'reject' });
    const { shipOneIssue } = await import('../../src/commands/ship-execute.js');

    await expect(
      shipOneIssue({ repo: 'owner/repo', issue: '42', merge: false, collectTokens: false })
    ).resolves.toEqual({
      success: false,
      error:
        'Label did not advance after stage "plan" (still "shipper:designed"). Aborting to avoid infinite loop.',
    });
  });

  it('merges ready issues through the shared merge helper', async () => {
    scriptLabels(['shipper:ready']);
    const { shipOneIssue } = await import('../../src/commands/ship-execute.js');

    await expect(
      shipOneIssue({ repo: 'owner/repo', issue: '42', merge: true, collectTokens: false })
    ).resolves.toEqual({ success: true });

    expect(runStageForLabelMock).not.toHaveBeenCalled();
    expect(resolvePrForIssueMock).toHaveBeenCalledWith(42, 'owner/repo');
    expect(mergePrMock).toHaveBeenCalled();
  });
});

function getArgValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}
