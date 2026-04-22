// @vitest-environment jsdom

import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  DESIGNED_LABEL,
  FAILED_LABEL,
  GROOMED_LABEL,
  IMPLEMENTED_LABEL,
  NEW_LABEL,
  PLANNED_LABEL,
  PR_OPEN_LABEL,
  PR_REVIEWED_LABEL,
  READY_LABEL,
  type TokenUsage,
} from '@dnsquared/shipper-core';
import { PipelineBoard } from '../../src/renderer/components/pipeline-board.js';
import { PIPELINE_COLUMNS } from '../../src/renderer/lib/constants.js';
import type {
  ActiveShippingCommand,
  PipelineIssue,
  ResetSelection,
} from '../../src/renderer/types.js';

vi.mock('../../src/renderer/components/ui/dropdown-menu.js', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
    className,
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
    disabled?: boolean;
    className?: string;
  }) => (
    <button
      type="button"
      className={className}
      disabled={disabled}
      onClick={() => {
        onSelect?.();
      }}
    >
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuSub: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSubTrigger: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
  DropdownMenuSubContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../src/renderer/components/ui/tooltip.js', async () => {
  const { createTooltipMock } = await import('../test-utils/tooltip-mock.js');
  return createTooltipMock();
});

function createTokenUsage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...overrides,
  };
}

function createStageTokenUsage(): TokenUsage {
  return createTokenUsage({ inputTokens: 1_200, outputTokens: 1_000 });
}

function createFailedTokenUsage(): TokenUsage {
  return createTokenUsage({
    inputTokens: 2_000,
    outputTokens: 1_000,
    cacheReadTokens: 1_000,
    cacheWriteTokens: 200,
  });
}

function createIssue(overrides: Partial<PipelineIssue> = {}): PipelineIssue {
  return {
    number: 22,
    title: 'Verify pipeline board extraction',
    labels: [IMPLEMENTED_LABEL],
    state: 'open',
    author: 'dnsquared',
    createdAt: '2026-04-03T12:00:00.000Z',
    url: 'https://github.com/owner/repo/issues/22',
    tokenUsage: createStageTokenUsage(),
    ...overrides,
  };
}

function createColumnMap(
  entries: Partial<Record<(typeof PIPELINE_COLUMNS)[number], PipelineIssue[]>>
): Map<string, PipelineIssue[]> {
  return new Map<string, PipelineIssue[]>(
    PIPELINE_COLUMNS.map((label) => [label, entries[label] ?? []])
  );
}

function renderBoard({
  issues = [createIssue()],
  columnMap = createColumnMap({
    [IMPLEMENTED_LABEL]: [createIssue()],
  }),
  attentionIssues = {
    failed: [] as PipelineIssue[],
    new: [
      createIssue({
        number: 7,
        title: 'Needs grooming',
        labels: [NEW_LABEL],
        tokenUsage: createTokenUsage(),
      }),
    ],
  },
  shippingCommands = new Map<number, ActiveShippingCommand>(),
  pausedIssues = new Set<number>(),
  pausePendingIssues = new Set<number>(),
  resettingIssues = new Set<number>(),
  onResetSelect = vi.fn<(selection: ResetSelection) => void>(),
  onToggleAutoMerge = vi.fn(),
  onToggleAutoShip = vi.fn(),
  onPauseIssue = vi.fn(),
  onResumeIssue = vi.fn(),
} = {}) {
  const props = {
    repo: 'owner/repo',
    issues,
    columnMap,
    attentionIssues,
    resettingIssues,
    unlockingIssues: new Set<number>(),
    unblockingIssues: new Set<number>(),
    settingPriorityIssues: new Set<number>(),
    pausedIssues,
    pausePendingIssues,
    shippingCommands,
    autoMergeEnabled: false,
    autoShipEnabled: false,
    isLoading: false,
    canFetch: true,
    hasActiveRepo: true,
    isSavingAutoMerge: false,
    onToggleAutoMerge,
    onToggleAutoShip,
    onResetSelect,
    onCloseNotPlanned: vi.fn(),
    onSetPriority: vi.fn(),
    onUnlockClick: vi.fn(),
    onUnblockClick: vi.fn(),
    onPauseIssue,
    onResumeIssue,
    onGroom: vi.fn(),
    onShip: vi.fn(),
    onCancelShip: vi.fn(),
  };

  return render(<PipelineBoard {...props} />);
}

describe('PipelineBoard', () => {
  it('renders board sections, issues, empty columns, and toolbar toggles', () => {
    const onToggleAutoMerge = vi.fn();
    const onToggleAutoShip = vi.fn();

    renderBoard({ onToggleAutoMerge, onToggleAutoShip });

    expect(screen.getByText('Issues by workflow stage')).toBeTruthy();
    expect(screen.getByText('owner/repo')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'New' })).toBeTruthy();
    expect(screen.getByText('Needs grooming')).toBeTruthy();
    expect(screen.getByText('Verify pipeline board extraction')).toBeTruthy();
    expect(screen.getAllByText('No issues').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Auto-merge' }));
    fireEvent.click(screen.getByRole('button', { name: 'Auto-ship' }));

    expect(onToggleAutoMerge).toHaveBeenCalledTimes(1);
    expect(onToggleAutoShip).toHaveBeenCalledTimes(1);
  });

  it('fires reset selection from the issue-card menu', () => {
    const onResetSelect = vi.fn<(selection: ResetSelection) => void>();

    renderBoard({
      attentionIssues: { failed: [], new: [] },
      onResetSelect,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    fireEvent.click(screen.getByRole('button', { name: 'Planned' }));

    const [selection] = onResetSelect.mock.calls[0] ?? [];
    expect(selection?.issue.number).toBe(22);
    expect(selection?.targetStage).toBe('planned');
  });

  it('threads pause and resume actions through to issue cards', () => {
    const onPauseIssue = vi.fn();
    const onResumeIssue = vi.fn();

    const { rerender } = renderBoard({
      attentionIssues: { failed: [], new: [] },
      onPauseIssue,
      onResumeIssue,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(onPauseIssue).toHaveBeenCalledWith(expect.objectContaining({ number: 22 }));

    rerender(
      <PipelineBoard
        repo="owner/repo"
        issues={[createIssue()]}
        columnMap={createColumnMap({ [IMPLEMENTED_LABEL]: [createIssue()] })}
        attentionIssues={{ failed: [], new: [] }}
        resettingIssues={new Set<number>()}
        unlockingIssues={new Set<number>()}
        unblockingIssues={new Set<number>()}
        settingPriorityIssues={new Set<number>()}
        pausedIssues={new Set([22])}
        pausePendingIssues={new Set<number>()}
        shippingCommands={new Map<number, ActiveShippingCommand>()}
        autoMergeEnabled={false}
        autoShipEnabled={false}
        isLoading={false}
        canFetch
        hasActiveRepo
        isSavingAutoMerge={false}
        onToggleAutoMerge={vi.fn()}
        onToggleAutoShip={vi.fn()}
        onResetSelect={vi.fn()}
        onCloseNotPlanned={vi.fn()}
        onSetPriority={vi.fn()}
        onUnlockClick={vi.fn()}
        onUnblockClick={vi.fn()}
        onPauseIssue={vi.fn()}
        onResumeIssue={onResumeIssue}
        onGroom={vi.fn()}
        onShip={vi.fn()}
        onCancelShip={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(onResumeIssue).toHaveBeenCalledWith(22);
  });

  it('shows a primary Reset action on failed attention cards and keeps overflow Reset available', () => {
    const onResetSelect = vi.fn<(selection: ResetSelection) => void>();

    renderBoard({
      attentionIssues: {
        failed: [
          createIssue({
            number: 8,
            title: 'Investigate failed run',
            labels: [FAILED_LABEL],
            tokenUsage: createFailedTokenUsage(),
          }),
        ],
        new: [
          createIssue({
            number: 7,
            title: 'Needs grooming',
            labels: [NEW_LABEL],
            tokenUsage: createTokenUsage(),
          }),
        ],
      },
      onResetSelect,
    });

    const failedSection = screen.getByTestId('failed-attention-section');

    expect(within(failedSection).getAllByRole('button', { name: 'Reset' })).toHaveLength(2);
    expect(within(failedSection).queryByRole('button', { name: 'Groom' })).toBeNull();
    expect(within(failedSection).queryByRole('button', { name: 'Ship' })).toBeNull();
    expect(within(failedSection).getAllByRole('button', { name: 'Planned' })).toHaveLength(2);

    fireEvent.click(within(failedSection).getAllByRole('button', { name: 'Planned' })[0]);

    const [selection] = onResetSelect.mock.calls[0] ?? [];
    expect(selection?.issue.number).toBe(8);
    expect(selection?.targetStage).toBe('planned');
  });

  it('allows valid leftward drops and rejects invalid rightward drops', () => {
    const onResetSelect = vi.fn<(selection: ResetSelection) => void>();

    renderBoard({
      attentionIssues: { failed: [], new: [] },
      onResetSelect,
    });

    const dataTransfer = { effectAllowed: '', dropEffect: '' };
    const issueTitle = screen.getByText('Verify pipeline board extraction');
    const plannedHeading = screen.getByRole('heading', { name: 'Planned' });
    const prOpenHeading = screen.getByRole('heading', { name: 'PR Open' });

    fireEvent.dragStart(issueTitle, { dataTransfer });
    fireEvent.dragEnter(plannedHeading, { dataTransfer });
    fireEvent.drop(plannedHeading, { dataTransfer });

    const [selection] = onResetSelect.mock.calls[0] ?? [];
    expect(selection?.issue.number).toBe(22);
    expect(selection?.targetStage).toBe('planned');

    fireEvent.dragStart(issueTitle, { dataTransfer });
    fireEvent.dragEnter(prOpenHeading, { dataTransfer });
    fireEvent.drop(prOpenHeading, { dataTransfer });

    expect(onResetSelect).toHaveBeenCalledTimes(1);
  });

  it('allows failed attention cards to reset via drag-and-drop to eligible stages', () => {
    const onResetSelect = vi.fn<(selection: ResetSelection) => void>();

    renderBoard({
      attentionIssues: {
        failed: [
          createIssue({
            number: 8,
            title: 'Investigate failed run',
            labels: [FAILED_LABEL],
            tokenUsage: createFailedTokenUsage(),
          }),
        ],
        new: [
          createIssue({
            number: 7,
            title: 'Needs grooming',
            labels: [NEW_LABEL],
            tokenUsage: createTokenUsage(),
          }),
        ],
      },
      onResetSelect,
    });

    const failedIssueTitle = screen.getByText('Investigate failed run');
    const newSection = screen.getByTestId('new-attention-section');
    const targets = [
      { stage: 'new', element: newSection },
      {
        stage: 'groomed',
        element: screen.getByTestId(`pipeline-column-${GROOMED_LABEL}`),
      },
      {
        stage: 'designed',
        element: screen.getByTestId(`pipeline-column-${DESIGNED_LABEL}`),
      },
      {
        stage: 'planned',
        element: screen.getByTestId(`pipeline-column-${PLANNED_LABEL}`),
      },
      {
        stage: 'implemented',
        element: screen.getByTestId(`pipeline-column-${IMPLEMENTED_LABEL}`),
      },
    ] as const;

    for (const [index, target] of targets.entries()) {
      const dataTransfer = { effectAllowed: '', dropEffect: '' };
      fireEvent.dragStart(failedIssueTitle, { dataTransfer });
      fireEvent.dragEnter(target.element, { dataTransfer });

      expect(target.element.className).toContain('bg-blue-500/10');

      fireEvent.drop(target.element, { dataTransfer });

      const [selection] = onResetSelect.mock.calls[index] ?? [];
      expect(selection?.issue.number).toBe(8);
      expect(selection?.targetStage).toBe(target.stage);
    }
  });

  it('rejects failed-card drops on PR Open, PR Reviewed, and Ready', () => {
    const onResetSelect = vi.fn<(selection: ResetSelection) => void>();

    renderBoard({
      attentionIssues: {
        failed: [
          createIssue({
            number: 8,
            title: 'Investigate failed run',
            labels: [FAILED_LABEL],
            tokenUsage: createFailedTokenUsage(),
          }),
        ],
        new: [
          createIssue({
            number: 7,
            title: 'Needs grooming',
            labels: [NEW_LABEL],
            tokenUsage: createTokenUsage(),
          }),
        ],
      },
      onResetSelect,
    });

    const failedIssueTitle = screen.getByText('Investigate failed run');
    const blockedTargets = [
      screen.getByTestId(`pipeline-column-${PR_OPEN_LABEL}`),
      screen.getByTestId(`pipeline-column-${PR_REVIEWED_LABEL}`),
      screen.getByTestId(`pipeline-column-${READY_LABEL}`),
    ];

    for (const target of blockedTargets) {
      const dataTransfer = { effectAllowed: '', dropEffect: '' };
      fireEvent.dragStart(failedIssueTitle, { dataTransfer });
      fireEvent.dragEnter(target, { dataTransfer });

      expect(target.className).not.toContain('bg-blue-500/10');

      fireEvent.drop(target, { dataTransfer });
    }

    expect(onResetSelect).not.toHaveBeenCalled();
  });

  it('rejects pipeline-card drops on the New attention section', () => {
    const onResetSelect = vi.fn<(selection: ResetSelection) => void>();

    renderBoard({ onResetSelect });

    const issueTitle = screen.getByText('Verify pipeline board extraction');
    const newSection = screen.getByTestId('new-attention-section');
    const dataTransfer = { effectAllowed: '', dropEffect: '' };

    fireEvent.dragStart(issueTitle, { dataTransfer });
    fireEvent.dragEnter(newSection, { dataTransfer });

    expect(newSection.className).not.toContain('bg-blue-500/10');

    fireEvent.drop(newSection, { dataTransfer });

    expect(onResetSelect).not.toHaveBeenCalled();
  });

  it('renders separate Failed and New attention sections', () => {
    renderBoard({
      attentionIssues: {
        failed: [
          createIssue({
            number: 8,
            title: 'Investigate failed run',
            labels: [FAILED_LABEL],
            tokenUsage: createFailedTokenUsage(),
          }),
        ],
        new: [
          createIssue({
            number: 7,
            title: 'Needs grooming',
            labels: [NEW_LABEL],
            tokenUsage: createTokenUsage(),
          }),
        ],
      },
    });

    const failedSection = screen.getByTestId('failed-attention-section');
    const newSection = screen.getByTestId('new-attention-section');

    expect(within(failedSection).getByRole('heading', { name: 'Failed' })).toBeTruthy();
    expect(within(failedSection).getByText('Investigate failed run')).toBeTruthy();
    expect(within(failedSection).queryByText('Needs grooming')).toBeNull();
    expect(within(newSection).getByRole('heading', { name: 'New' })).toBeTruthy();
    expect(within(newSection).getByText('Needs grooming')).toBeTruthy();
    expect(within(newSection).queryByText('Investigate failed run')).toBeNull();
  });

  it('shows Groom only for new attention cards', () => {
    renderBoard({
      attentionIssues: {
        failed: [
          createIssue({
            number: 8,
            title: 'Investigate failed run',
            labels: [FAILED_LABEL],
            tokenUsage: createFailedTokenUsage(),
          }),
        ],
        new: [
          createIssue({
            number: 7,
            title: 'Needs grooming',
            labels: [NEW_LABEL],
            tokenUsage: createTokenUsage(),
          }),
        ],
      },
    });

    expect(screen.getAllByRole('button', { name: 'Groom' })).toHaveLength(1);
  });

  it('keeps failed Reset actions available when the New section is not rendered', () => {
    renderBoard({
      attentionIssues: {
        failed: [
          createIssue({
            number: 8,
            title: 'Investigate failed run',
            labels: [FAILED_LABEL],
            tokenUsage: createFailedTokenUsage(),
          }),
        ],
        new: [],
      },
    });

    const failedSection = screen.getByTestId('failed-attention-section');

    expect(screen.queryByTestId('new-attention-section')).toBeNull();
    expect(within(failedSection).getAllByRole('button', { name: 'Reset' })).toHaveLength(2);
  });

  it('shows resetting overlays for attention cards in either section', () => {
    renderBoard({
      attentionIssues: {
        failed: [
          createIssue({
            number: 8,
            title: 'Investigate failed run',
            labels: [FAILED_LABEL],
            tokenUsage: createFailedTokenUsage(),
          }),
        ],
        new: [
          createIssue({
            number: 7,
            title: 'Needs grooming',
            labels: [NEW_LABEL],
            tokenUsage: createTokenUsage(),
          }),
        ],
      },
      resettingIssues: new Set([7, 8]),
    });

    expect(screen.getAllByText('Resetting...')).toHaveLength(2);
  });

  it('renders token indicators for attention and stage cards alongside existing controls', () => {
    renderBoard({
      attentionIssues: {
        failed: [
          createIssue({
            number: 8,
            title: 'Investigate failed run',
            labels: [FAILED_LABEL],
            tokenUsage: createFailedTokenUsage(),
          }),
        ],
        new: [
          createIssue({
            number: 7,
            title: 'Needs grooming',
            labels: [NEW_LABEL],
            tokenUsage: createTokenUsage(),
          }),
        ],
      },
    });

    const failedSection = screen.getByTestId('failed-attention-section');
    const newSection = screen.getByTestId('new-attention-section');
    const stageCard = screen.getByTestId('issue-card-22');

    expect(
      within(failedSection).getByRole('button', {
        name: '4,200 total tokens: 2,000 input, 1,000 output, 1,000 cache read, 200 cache write',
      })
    ).toBeTruthy();
    expect(within(failedSection).getByText('4.2k tokens')).toBeTruthy();
    expect(
      within(newSection).getByRole('button', {
        name: '0 total tokens: 0 input, 0 output, 0 cache read, 0 cache write',
      })
    ).toBeTruthy();
    expect(within(newSection).getByText('0 tokens')).toBeTruthy();
    expect(within(newSection).getByRole('button', { name: 'Groom' })).toBeTruthy();
    expect(
      within(stageCard).getByRole('button', {
        name: '2,200 total tokens: 1,200 input, 1,000 output, 0 cache read, 0 cache write',
      })
    ).toBeTruthy();
    expect(within(stageCard).getByText('2.2k tokens')).toBeTruthy();
    expect(within(stageCard).getByRole('button', { name: 'Ship' })).toBeTruthy();
  });
});
