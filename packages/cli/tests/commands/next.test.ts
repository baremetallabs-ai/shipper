import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { gh, resolveRef, tryResolvePrForIssue, withIssueLock } from '@dnsquared/shipper-core';
import { groomCommand } from '../../src/commands/groom.js';
import { designCommand } from '../../src/commands/design.js';
import { planCommand } from '../../src/commands/plan.js';
import { implementCommand } from '../../src/commands/implement.js';
import { prOpenCommand } from '../../src/commands/pr-open.js';
import { prReviewCommand } from '../../src/commands/pr-review.js';
import { prRemediateCommand } from '../../src/commands/pr-remediate.js';

const { parseIssueNumberLabelsMock } = vi.hoisted(() => ({
  parseIssueNumberLabelsMock: (json: string) =>
    JSON.parse(json) as { number: number; labels: Array<{ name: string }> },
}));

vi.mock('@dnsquared/shipper-core', () => ({
  logger: {
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
  gh: vi.fn(),
  parseIssueNumberLabels: parseIssueNumberLabelsMock,
  resolveRef: vi.fn(),
  tryResolvePrForIssue: vi.fn(),
  BLOCKED_LABEL: 'shipper:blocked',
  CONTROL_LABEL_NAMES: ['shipper:blocked', 'shipper:locked', 'shipper:failed'],
  FAILED_LABEL: 'shipper:failed',
  LOCKED_LABEL: 'shipper:locked',
  NEW_LABEL: 'shipper:new',
  GROOMED_LABEL: 'shipper:groomed',
  DESIGNED_LABEL: 'shipper:designed',
  PLANNED_LABEL: 'shipper:planned',
  IMPLEMENTED_LABEL: 'shipper:implemented',
  PR_OPEN_LABEL: 'shipper:pr-open',
  PRIORITY_LABEL_NAMES: ['shipper:priority-high', 'shipper:priority-low'],
  PR_REVIEWED_LABEL: 'shipper:pr-reviewed',
  READY_LABEL: 'shipper:ready',
  withIssueLock: vi.fn((_repo: string, _issue: string, fn: () => Promise<void>) => fn()),
}));

vi.mock('../../src/commands/groom.js', () => ({
  groomCommand: vi.fn(),
}));

vi.mock('../../src/commands/design.js', () => ({
  designCommand: vi.fn(),
}));

vi.mock('../../src/commands/plan.js', () => ({
  planCommand: vi.fn(),
}));

vi.mock('../../src/commands/implement.js', () => ({
  implementCommand: vi.fn(),
}));

vi.mock('../../src/commands/pr-open.js', () => ({
  prOpenCommand: vi.fn(),
}));

vi.mock('../../src/commands/pr-review.js', () => ({
  prReviewCommand: vi.fn(),
}));

vi.mock('../../src/commands/pr-remediate.js', () => ({
  prRemediateCommand: vi.fn(),
}));

import { nextCommand } from '../../src/commands/next.js';

const mockGh = vi.mocked(gh);
const mockResolveRef = vi.mocked(resolveRef);
const mockTryResolvePrForIssue = vi.mocked(tryResolvePrForIssue);
const mockWithIssueLock = vi.mocked(withIssueLock);
const mockGroomCommand = vi.mocked(groomCommand);
const mockDesignCommand = vi.mocked(designCommand);
const mockPlanCommand = vi.mocked(planCommand);
const mockImplementCommand = vi.mocked(implementCommand);
const mockPrOpenCommand = vi.mocked(prOpenCommand);
const mockPrReviewCommand = vi.mocked(prReviewCommand);
const mockPrRemediateCommand = vi.mocked(prRemediateCommand);
const repo = 'owner/repo';

describe('nextCommand', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveRef.mockResolvedValue({ issueNumber: '159' });
    mockTryResolvePrForIssue.mockResolvedValue('200');
    mockGh.mockResolvedValue({ stdout: '', stderr: '' });
    mockWithIssueLock.mockImplementation((_repo: string, _issue: string, fn: () => Promise<void>) =>
      fn()
    );
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('dispatches to grooming for blocked shipper:new issues', async () => {
    mockGh.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 159,
        labels: [{ name: 'shipper:new' }, { name: 'shipper:blocked' }],
      }),
      stderr: '',
    });

    await nextCommand(repo, '159');

    expect(mockResolveRef).toHaveBeenCalledWith(repo, '159', 'issue');
    expect(mockWithIssueLock).toHaveBeenCalledWith(repo, '159', expect.any(Function));
    expect(mockGroomCommand).toHaveBeenCalledWith(repo, '159', {
      auto: false,
      mode: undefined,
      agent: undefined,
      model: undefined,
    });
    expect(errorSpy).not.toHaveBeenCalled();
    expect(mockDesignCommand).not.toHaveBeenCalled();
    expect(mockPlanCommand).not.toHaveBeenCalled();
    expect(mockImplementCommand).not.toHaveBeenCalled();
    expect(mockPrOpenCommand).not.toHaveBeenCalled();
    expect(mockPrReviewCommand).not.toHaveBeenCalled();
    expect(mockPrRemediateCommand).not.toHaveBeenCalled();
  });

  it('forwards mode, agent, and model overrides to the groom command', async () => {
    mockGh.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 159,
        labels: [{ name: 'shipper:new' }],
      }),
      stderr: '',
    });

    await nextCommand(repo, '159', 'interactive', 'codex', 'gpt-5');

    expect(mockGroomCommand).toHaveBeenCalledWith(repo, '159', {
      auto: false,
      mode: 'interactive',
      agent: 'codex',
      model: 'gpt-5',
    });
  });

  it('surfaces groom failures unchanged for shipper:new issues', async () => {
    mockGh.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 159,
        labels: [{ name: 'shipper:new' }],
      }),
      stderr: '',
    });
    const error = new Error(
      'Error: shipper groom requires an interactive terminal. stdin is not a TTY.'
    );
    mockGroomCommand.mockRejectedValueOnce(error);

    await expect(nextCommand(repo, '159')).rejects.toThrow(error.message);

    expect(mockGroomCommand).toHaveBeenCalledWith(repo, '159', {
      auto: false,
      mode: undefined,
      agent: undefined,
      model: undefined,
    });
    expect(mockDesignCommand).not.toHaveBeenCalled();
    expect(mockPlanCommand).not.toHaveBeenCalled();
    expect(mockImplementCommand).not.toHaveBeenCalled();
    expect(mockPrOpenCommand).not.toHaveBeenCalled();
    expect(mockPrReviewCommand).not.toHaveBeenCalled();
    expect(mockPrRemediateCommand).not.toHaveBeenCalled();
  });

  it('forwards mode, agent, and model overrides to downstream workflow commands', async () => {
    mockGh.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 159,
        labels: [{ name: 'shipper:planned' }],
      }),
      stderr: '',
    });

    await nextCommand(repo, '159', 'interactive', 'codex', 'gpt-5');

    expect(mockImplementCommand).toHaveBeenCalledWith(repo, '159', 'interactive', 'codex', 'gpt-5');
  });

  it('dispatches using the stage label when a priority label is also present', async () => {
    mockGh.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 159,
        labels: [{ name: 'shipper:planned' }, { name: 'shipper:priority-high' }],
      }),
      stderr: '',
    });

    await nextCommand(repo, '159');

    expect(mockImplementCommand).toHaveBeenCalledWith(repo, '159', undefined, undefined, undefined);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['shipper:groomed', mockDesignCommand, '159'],
    ['shipper:designed', mockPlanCommand, '159'],
    ['shipper:planned', mockImplementCommand, '159'],
    ['shipper:implemented', mockPrOpenCommand, '159'],
    ['shipper:pr-open', mockPrReviewCommand, '200'],
    ['shipper:pr-reviewed', mockPrRemediateCommand, '200'],
  ])(
    'forwards explicit mode to the %s stage dispatch',
    async (stageLabel, commandMock, expectedRef) => {
      mockGh.mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 159,
          labels: [{ name: stageLabel }],
        }),
        stderr: '',
      });

      await nextCommand(repo, '159', 'headless', 'codex', 'sonnet');

      expect(commandMock).toHaveBeenCalledWith(repo, expectedRef, 'headless', 'codex', 'sonnet');
    }
  );

  it.each([
    'shipper:groomed',
    'shipper:designed',
    'shipper:planned',
    'shipper:implemented',
    'shipper:pr-open',
    'shipper:pr-reviewed',
    'shipper:ready',
  ])('throws for blocked %s issues before dispatch', async (stageLabel) => {
    mockGh.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 159,
        labels: [{ name: stageLabel }, { name: 'shipper:blocked' }],
      }),
      stderr: '',
    });

    await expect(nextCommand(repo, '159')).rejects.toThrow(
      "Issue #159 is blocked. Run 'shipper unblock 159' to check if it can proceed."
    );
    expect(errorSpy).not.toHaveBeenCalled();
    expect(mockWithIssueLock).not.toHaveBeenCalled();
    expect(mockGroomCommand).not.toHaveBeenCalled();
    expect(mockDesignCommand).not.toHaveBeenCalled();
    expect(mockPlanCommand).not.toHaveBeenCalled();
    expect(mockImplementCommand).not.toHaveBeenCalled();
    expect(mockPrOpenCommand).not.toHaveBeenCalled();
    expect(mockPrReviewCommand).not.toHaveBeenCalled();
    expect(mockPrRemediateCommand).not.toHaveBeenCalled();
  });

  it.each([
    'shipper:new',
    'shipper:groomed',
    'shipper:designed',
    'shipper:planned',
    'shipper:implemented',
    'shipper:pr-open',
    'shipper:pr-reviewed',
    'shipper:ready',
  ])('throws for failed %s issues before dispatch', async (stageLabel) => {
    mockGh.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 159,
        labels: [{ name: stageLabel }, { name: 'shipper:failed' }],
      }),
      stderr: '',
    });

    await expect(nextCommand(repo, '159')).rejects.toThrow(
      'Issue #159 has the shipper:failed label.'
    );
    expect(errorSpy).not.toHaveBeenCalled();
    expect(mockWithIssueLock).not.toHaveBeenCalled();
    expect(mockGroomCommand).not.toHaveBeenCalled();
    expect(mockDesignCommand).not.toHaveBeenCalled();
    expect(mockPlanCommand).not.toHaveBeenCalled();
    expect(mockImplementCommand).not.toHaveBeenCalled();
    expect(mockPrOpenCommand).not.toHaveBeenCalled();
    expect(mockPrReviewCommand).not.toHaveBeenCalled();
    expect(mockPrRemediateCommand).not.toHaveBeenCalled();
  });

  it('throws with the failed message when shipper:failed is the only shipper label', async () => {
    mockGh.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 159,
        labels: [{ name: 'shipper:failed' }],
      }),
      stderr: '',
    });

    await expect(nextCommand(repo, '159')).rejects.toThrow(
      'Issue #159 has the shipper:failed label.'
    );
    expect(errorSpy).not.toHaveBeenCalled();
    expect(mockWithIssueLock).not.toHaveBeenCalled();
    expect(mockGroomCommand).not.toHaveBeenCalled();
    expect(mockDesignCommand).not.toHaveBeenCalled();
    expect(mockPlanCommand).not.toHaveBeenCalled();
    expect(mockImplementCommand).not.toHaveBeenCalled();
    expect(mockPrOpenCommand).not.toHaveBeenCalled();
    expect(mockPrReviewCommand).not.toHaveBeenCalled();
    expect(mockPrRemediateCommand).not.toHaveBeenCalled();
  });

  it('throws with the failed message before reporting multiple workflow labels', async () => {
    mockGh.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 159,
        labels: [
          { name: 'shipper:groomed' },
          { name: 'shipper:planned' },
          { name: 'shipper:failed' },
        ],
      }),
      stderr: '',
    });

    await expect(nextCommand(repo, '159')).rejects.toThrow(
      'Issue #159 has the shipper:failed label.'
    );
    expect(errorSpy).not.toHaveBeenCalled();
    expect(mockWithIssueLock).not.toHaveBeenCalled();
    expect(mockGroomCommand).not.toHaveBeenCalled();
    expect(mockDesignCommand).not.toHaveBeenCalled();
    expect(mockPlanCommand).not.toHaveBeenCalled();
    expect(mockImplementCommand).not.toHaveBeenCalled();
    expect(mockPrOpenCommand).not.toHaveBeenCalled();
    expect(mockPrReviewCommand).not.toHaveBeenCalled();
    expect(mockPrRemediateCommand).not.toHaveBeenCalled();
  });
});
