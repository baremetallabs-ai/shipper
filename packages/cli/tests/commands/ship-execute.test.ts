import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShipIssueResult } from '../../src/commands/ship-execute.js';

const spawnMock = vi.fn();
const forkMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  fork: forkMock,
  spawnSync: vi.fn(),
}));

const ghMock = vi.fn<(args: string[]) => Promise<{ stdout: string; stderr: string }>>();
const withIssueLockMock =
  vi.fn<
    (repo: string, issue: string, fn: () => Promise<ShipIssueResult>) => Promise<ShipIssueResult>
  >();
const resolveModeMock =
  vi.fn<
    (
      step: string,
      override?: 'default' | 'interactive' | 'headless'
    ) => 'default' | 'interactive' | 'headless'
  >();
const aggregateSessionUsageMock = vi.fn();
const totalTokensMock = vi.fn<(usage: { inputTokens: number; outputTokens: number }) => number>();
const loggerLogMock = vi.fn<(message: string) => void>();
const loggerWarnMock = vi.fn<(message: string) => void>();
const loggerErrorMock = vi.fn<(message: string) => void>();
const runStageForLabelMock = vi.fn<
  (
    repo: string,
    issue: string,
    label: string,
    options: {
      mode: 'default' | 'interactive' | 'headless';
      agent?: string;
      model?: string;
      skipInitialPrRemediateWait?: boolean;
    }
  ) => Promise<{ success: boolean; exitCode: number; verdict?: 'accept' | 'reject' | 'fail' }>
>();
const buildReadyCheckMock =
  vi.fn<
    (
      repo: string,
      prNumber: number,
      issue: string,
      options?: { logSkipMessage?: boolean; skipInitialWait?: boolean }
    ) => Promise<() => Promise<boolean>>
  >();
const resolvePrForIssueMock = vi.fn<
  (
    issueNumber: number,
    repo: string
  ) => Promise<{
    number: number;
    title: string;
    headRefName: string;
    baseRefName: string;
  }>
>();
const mergePrMock =
  vi.fn<
    (
      pr: { number: number; title: string; headRefName: string; baseRefName: string },
      repo: string,
      options?: { logPrefix?: string }
    ) => Promise<void>
  >();
const issueEditCalls: string[][] = [];
let labelQueue: Array<string | undefined> = [];

function queueLabels(labels: Array<string | undefined>): void {
  labelQueue = [...labels];
}

vi.mock('@dnsquared/shipper-core', () => ({
  STAGE_NAME_MAP: {
    'shipper:new': 'groom',
    'shipper:groomed': 'design',
    'shipper:designed': 'plan',
    'shipper:planned': 'implement',
    'shipper:implemented': 'pr open',
    'shipper:pr-open': 'pr review',
    'shipper:pr-reviewed': 'pr remediate',
    'shipper:ready': 'ready',
  },
  NEW_LABEL: 'shipper:new',
  PR_REVIEWED_LABEL: 'shipper:pr-reviewed',
  PRIORITY_LABEL_NAMES: ['shipper:priority-high', 'shipper:priority-low'],
  READY_LABEL: 'shipper:ready',
  BLOCKED_LABEL: 'shipper:blocked',
  LOCKED_LABEL: 'shipper:locked',
  FAILED_LABEL: 'shipper:failed',
  gh: ghMock,
  withIssueLock: withIssueLockMock,
  withLogCapture: async (_stream: unknown, fn: () => Promise<ShipIssueResult>) => await fn(),
  resolveMode: resolveModeMock,
  aggregateSessionUsage: aggregateSessionUsageMock,
  totalTokens: totalTokensMock,
  createLogger: () => ({
    log: loggerLogMock,
    warn: loggerWarnMock,
    error: loggerErrorMock,
  }),
  logger: {
    log: loggerLogMock,
    warn: loggerWarnMock,
    error: loggerErrorMock,
  },
  getSettings: () => ({
    prReviewWait: { mode: 'checks', maxDurationMinutes: 30 },
  }),
  toError: (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  toErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

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

describe('shipOneIssue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    issueEditCalls.length = 0;
    labelQueue = [];
    withIssueLockMock.mockImplementation(async (_repo, _issue, fn) => await fn());
    resolveModeMock.mockImplementation((_step, override) => override ?? 'default');
    totalTokensMock.mockImplementation((usage) => usage.inputTokens + usage.outputTokens);
    aggregateSessionUsageMock.mockResolvedValue({ inputTokens: 12, outputTokens: 8 });
    runStageForLabelMock.mockResolvedValue({ success: true, exitCode: 0, verdict: 'accept' });
    buildReadyCheckMock.mockResolvedValue(() => Promise.resolve(false));
    ghMock.mockImplementation((args) => {
      if (args[0] === 'issue' && args[1] === 'view') {
        const label = labelQueue.shift();
        return Promise.resolve({ stdout: label === undefined ? '' : `${label}\n`, stderr: '' });
      }
      if (args[0] === 'issue' && args[1] === 'edit') {
        issueEditCalls.push(args);
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    resolvePrForIssueMock.mockResolvedValue({
      number: 101,
      title: 'PR',
      headRefName: 'shipper/42',
      baseRefName: 'main',
    });
    mergePrMock.mockResolvedValue(undefined);
  });

  it('runs sequential stages in-process without spawning child processes', async () => {
    queueLabels(['shipper:planned', 'shipper:ready']);
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
    expect(spawnMock).not.toHaveBeenCalled();
    expect(forkMock).not.toHaveBeenCalled();
  });

  it('skips interactive stages directly when configured to avoid them', async () => {
    queueLabels(['shipper:new']);
    resolveModeMock.mockReturnValue('interactive');
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
    queueLabels(['shipper:pr-reviewed', 'shipper:ready']);
    let parked = false;
    buildReadyCheckMock.mockResolvedValue(() => Promise.resolve(false));
    resolvePrForIssueMock.mockResolvedValue({
      number: 101,
      title: 'PR',
      headRefName: 'shipper/42',
      baseRefName: 'main',
    });

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
    expect(runStageForLabelMock).toHaveBeenCalledWith('owner/repo', '42', 'shipper:pr-reviewed', {
      mode: 'default',
      agent: undefined,
      model: undefined,
      skipInitialPrRemediateWait: true,
    });
  });

  it('stops when a skipped path resets work to shipper:new', async () => {
    queueLabels(['shipper:planned', 'shipper:new']);
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
    queueLabels([
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

    expect(issueEditCalls).toContainEqual([
      'issue',
      'edit',
      '42',
      '-R',
      'owner/repo',
      '--add-label',
      'shipper:failed',
      '--remove-label',
      'shipper:pr-reviewed',
    ]);
  });

  it('merges ready issues through the shared merge helper', async () => {
    queueLabels(['shipper:ready']);
    const { shipOneIssue } = await import('../../src/commands/ship-execute.js');

    await expect(
      shipOneIssue({ repo: 'owner/repo', issue: '42', merge: true, collectTokens: false })
    ).resolves.toEqual({ success: true });

    expect(runStageForLabelMock).not.toHaveBeenCalled();
    expect(resolvePrForIssueMock).toHaveBeenCalledWith(42, 'owner/repo');
    expect(mergePrMock).toHaveBeenCalled();
  });
});
