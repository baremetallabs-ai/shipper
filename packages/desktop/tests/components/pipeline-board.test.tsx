// @vitest-environment jsdom

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ListIssueItem } from '@dnsquared/shipper-core';
import { IMPLEMENTED_LABEL, NEW_LABEL } from '../../../core/src/lib/labels.js';
import { PipelineBoard } from '../../src/renderer/components/pipeline-board.js';
import { PIPELINE_COLUMNS } from '../../src/renderer/lib/constants.js';
import type { ActiveShippingCommand, ResetSelection } from '../../src/renderer/types.js';

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

function createIssue(overrides: Partial<ListIssueItem> = {}): ListIssueItem {
  return {
    number: 22,
    title: 'Verify pipeline board extraction',
    labels: [IMPLEMENTED_LABEL],
    state: 'open',
    author: 'dnsquared',
    createdAt: '2026-04-03T12:00:00.000Z',
    ...overrides,
  };
}

function createColumnMap(
  entries: Partial<Record<(typeof PIPELINE_COLUMNS)[number], ListIssueItem[]>>
): Map<string, ListIssueItem[]> {
  return new Map<string, ListIssueItem[]>(
    PIPELINE_COLUMNS.map((label) => [label, entries[label] ?? []])
  );
}

function renderBoard({
  issues = [createIssue()],
  columnMap = createColumnMap({
    [IMPLEMENTED_LABEL]: [createIssue()],
  }),
  attentionIssues = [createIssue({ number: 7, title: 'Needs grooming', labels: [NEW_LABEL] })],
  shippingCommands = new Map<number, ActiveShippingCommand>(),
  onResetSelect = vi.fn<(selection: ResetSelection) => void>(),
  onToggleAutoMerge = vi.fn(),
  onToggleAutoShip = vi.fn(),
} = {}) {
  const props = {
    repo: 'owner/repo',
    issues,
    columnMap,
    attentionIssues,
    resettingIssues: new Set<number>(),
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
    expect(screen.getByText('Needs attention')).toBeTruthy();
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
      attentionIssues: [],
      onResetSelect,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    fireEvent.click(screen.getByRole('button', { name: 'Planned' }));

    const [selection] = onResetSelect.mock.calls[0] ?? [];
    expect(selection?.issue.number).toBe(22);
    expect(selection?.targetStage).toBe('planned');
  });

  it('allows valid leftward drops and rejects invalid rightward drops', () => {
    const onResetSelect = vi.fn<(selection: ResetSelection) => void>();

    renderBoard({
      attentionIssues: [],
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
});
