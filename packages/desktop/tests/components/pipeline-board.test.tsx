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

function createIssue(overrides: Partial<PipelineIssue> = {}): PipelineIssue {
  return {
    number: 22,
    title: 'Verify pipeline board extraction',
    labels: [IMPLEMENTED_LABEL],
    state: 'open',
    author: 'dnsquared',
    createdAt: '2026-04-03T12:00:00.000Z',
    url: 'https://github.com/owner/repo/issues/22',
    totalTokens: 2_200,
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
    new: [createIssue({ number: 7, title: 'Needs grooming', labels: [NEW_LABEL], totalTokens: 0 })],
  },
  shippingCommands = new Map<number, ActiveShippingCommand>(),
  resettingIssues = new Set<number>(),
  onResetSelect = vi.fn<(selection: ResetSelection) => void>(),
  onToggleAutoMerge = vi.fn(),
  onToggleAutoShip = vi.fn(),
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

  it('shows a primary Reset action on failed attention cards and keeps overflow Reset available', () => {
    const onResetSelect = vi.fn<(selection: ResetSelection) => void>();

    renderBoard({
      attentionIssues: {
        failed: [
          createIssue({
            number: 8,
            title: 'Investigate failed run',
            labels: [FAILED_LABEL],
            totalTokens: 4_200,
          }),
        ],
        new: [
          createIssue({ number: 7, title: 'Needs grooming', labels: [NEW_LABEL], totalTokens: 0 }),
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
            totalTokens: 4_200,
          }),
        ],
        new: [
          createIssue({ number: 7, title: 'Needs grooming', labels: [NEW_LABEL], totalTokens: 0 }),
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
            totalTokens: 4_200,
          }),
        ],
        new: [
          createIssue({ number: 7, title: 'Needs grooming', labels: [NEW_LABEL], totalTokens: 0 }),
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
            totalTokens: 4_200,
          }),
        ],
        new: [
          createIssue({ number: 7, title: 'Needs grooming', labels: [NEW_LABEL], totalTokens: 0 }),
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
            totalTokens: 4_200,
          }),
        ],
        new: [
          createIssue({ number: 7, title: 'Needs grooming', labels: [NEW_LABEL], totalTokens: 0 }),
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
            totalTokens: 4_200,
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
            totalTokens: 4_200,
          }),
        ],
        new: [
          createIssue({ number: 7, title: 'Needs grooming', labels: [NEW_LABEL], totalTokens: 0 }),
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
            totalTokens: 4_200,
          }),
        ],
        new: [
          createIssue({ number: 7, title: 'Needs grooming', labels: [NEW_LABEL], totalTokens: 0 }),
        ],
      },
    });

    const failedSection = screen.getByTestId('failed-attention-section');
    const newSection = screen.getByTestId('new-attention-section');
    const stageCard = screen.getByTestId('issue-card-22');

    expect(within(failedSection).getByText('4200 total tokens')).toBeTruthy();
    expect(within(failedSection).getByText('4.2k')).toBeTruthy();
    expect(within(newSection).getByText('0 total tokens')).toBeTruthy();
    expect(within(newSection).getByText('0')).toBeTruthy();
    expect(within(newSection).getByRole('button', { name: 'Groom' })).toBeTruthy();
    expect(within(stageCard).getByText('2200 total tokens')).toBeTruthy();
    expect(within(stageCard).getByText('2.2k')).toBeTruthy();
    expect(within(stageCard).getByRole('button', { name: 'Ship' })).toBeTruthy();
  });
});
