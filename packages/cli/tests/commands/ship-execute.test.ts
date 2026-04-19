import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as core from '@dnsquared/shipper-core';

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
  let resolveModeSpy: ReturnType<typeof vi.spyOn>;

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
      skipInitialPrRemediateWait: true,
    });
  });

  it('stops when a skipped path resets work to shipper:new', async () => {
    scriptLabels(['shipper:planned', 'shipper:new']);
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
        'Issue #42 was reset to shipper:new by stage "implement" - stopping to avoid interactive groom stage.',
    });
  });

  it('applies the transition cap and relabels the issue as failed', async () => {
    const labels = [
      'shipper:planned',
      'shipper:implemented',
      'shipper:pr-open',
      'shipper:pr-reviewed',
      'shipper:groomed',
      'shipper:designed',
    ];
    scriptLabels([
      labels[0],
      ...Array.from({ length: 15 }, (_, index) => labels[(index + 1) % labels.length]),
    ]);
    const { shipOneIssue } = await import('../../src/commands/ship-execute.js');

    const result = await shipOneIssue({
      repo: 'owner/repo',
      issue: '42',
      merge: false,
      collectTokens: false,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Issue #42 hit transition cap (15)');
    expect(fake.state.labelTransitions).toContainEqual({
      target: 'issue',
      number: '42',
      add: ['shipper:failed'],
      remove: ['shipper:pr-reviewed'],
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
