// @vitest-environment jsdom

import React from 'react';
import { createEvent, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  BLOCKED_LABEL,
  FAILED_LABEL,
  LOCKED_LABEL,
  PLANNED_LABEL,
  PR_OPEN_LABEL,
  PRIORITY_HIGH_LABEL,
  type ListIssueItem,
  type WorkflowStage,
} from '@dnsquared/shipper-core';
import {
  IssueCard,
  getResetTargets,
  isValidDropTarget,
} from '../../src/renderer/components/issue-card.js';

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

const getResetTargetsForTest = getResetTargets as unknown as (labels: string[]) => WorkflowStage[];
const isValidDropTargetForTest = isValidDropTarget as unknown as (
  source: { issue: ListIssueItem; columnIndex: number },
  targetColumnIndex: number
) => boolean;

function createIssue(overrides: Partial<ListIssueItem> = {}): ListIssueItem {
  return {
    number: 12,
    title: 'Extract renderer components',
    labels: [PLANNED_LABEL],
    state: 'open',
    author: 'dnsquared',
    createdAt: '2026-04-03T12:00:00.000Z',
    url: 'https://github.com/owner/repo/issues/12',
    ...overrides,
  };
}

describe('IssueCard', () => {
  it('renders issue details, badges, busy overlay, and stop-ship action', () => {
    render(
      <IssueCard
        issue={createIssue({
          labels: [PLANNED_LABEL, PRIORITY_HIGH_LABEL, BLOCKED_LABEL, LOCKED_LABEL],
        })}
        totalTokens={0}
        isResetting
        shippingStatus="running"
        onStopShip={vi.fn()}
      />
    );

    expect(screen.getByText('#12')).toBeTruthy();
    expect(screen.getByText('Extract renderer components')).toBeTruthy();
    expect(screen.getByText('High')).toBeTruthy();
    expect(screen.getByText('Blocked')).toBeTruthy();
    expect(screen.getByText('Locked')).toBeTruthy();
    expect(screen.getByText('Resetting...')).toBeTruthy();
    expect(screen.getByLabelText('Stop shipping #12')).toBeTruthy();
  });

  it('disables groom and ship actions when the card is blocked or locked', () => {
    render(
      <IssueCard
        issue={createIssue({ labels: [PLANNED_LABEL, BLOCKED_LABEL, LOCKED_LABEL] })}
        totalTokens={0}
        onGroom={vi.fn()}
        onShip={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Groom' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Ship' })).toHaveProperty('disabled', true);
  });

  it('renders failed styling on the card surface', () => {
    render(<IssueCard issue={createIssue({ labels: [FAILED_LABEL] })} totalTokens={0} />);

    const card = screen.getByTestId('issue-card-12');

    expect(card.className).toContain('border-destructive/50');
    expect(card.className).toContain('bg-destructive/10');
    expect(screen.getByText('Failed')).toBeTruthy();
  });

  it('renders failed and blocked indicators together', () => {
    render(
      <IssueCard issue={createIssue({ labels: [FAILED_LABEL, BLOCKED_LABEL] })} totalTokens={0} />
    );

    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getByText('Blocked')).toBeTruthy();
  });

  it('renders failed and locked indicators together', () => {
    render(
      <IssueCard issue={createIssue({ labels: [FAILED_LABEL, LOCKED_LABEL] })} totalTokens={0} />
    );

    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getByText('Locked')).toBeTruthy();
  });

  it('fires groom, ship, and drag callbacks', () => {
    const onGroom = vi.fn();
    const onShip = vi.fn();
    const onDragStart = vi.fn();

    render(
      <IssueCard
        issue={createIssue()}
        totalTokens={0}
        onGroom={onGroom}
        onShip={onShip}
        draggable
        onDragStart={onDragStart}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Groom' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ship' }));

    const issueTitle = screen.getByText('Extract renderer components');
    fireEvent.dragStart(issueTitle, {
      dataTransfer: { effectAllowed: 'move' },
    });

    expect(onGroom).toHaveBeenCalledWith(12);
    expect(onShip).toHaveBeenCalledWith(12);
    expect(onDragStart).toHaveBeenCalledTimes(1);
  });

  it('renders the issue number as a GitHub link', () => {
    render(<IssueCard issue={createIssue()} totalTokens={0} />);
    const link = screen.getByRole('link', { name: '#12' });

    expect(link).toHaveProperty('href', 'https://github.com/owner/repo/issues/12');
    expect(link).toHaveProperty('target', '_blank');
    expect(link).toHaveProperty('rel', 'noreferrer');
  });

  it('prevents drag from starting on the issue link', () => {
    const onDragStart = vi.fn();

    render(<IssueCard issue={createIssue()} totalTokens={0} draggable onDragStart={onDragStart} />);
    const link = screen.getByRole('link', { name: '#12' });
    const dragEvent = createEvent.dragStart(link, {
      dataTransfer: { effectAllowed: 'move' },
    });
    fireEvent(link, dragEvent);

    expect(dragEvent.defaultPrevented).toBe(true);
    expect(onDragStart).not.toHaveBeenCalled();
  });

  it('keeps the issue title as plain text', () => {
    render(<IssueCard issue={createIssue()} totalTokens={0} />);

    expect(screen.queryByRole('link', { name: 'Extract renderer components' })).toBeNull();
  });

  it('invokes reset and priority menu actions', () => {
    const onResetSelect = vi.fn();
    const onSetPriority = vi.fn();

    render(
      <IssueCard
        issue={createIssue()}
        totalTokens={0}
        resetTargets={['groomed']}
        onResetSelect={onResetSelect}
        onSetPriority={onSetPriority}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    fireEvent.click(screen.getByRole('button', { name: 'Groomed' }));

    fireEvent.click(screen.getByRole('button', { name: 'Priority' }));
    fireEvent.click(screen.getByRole('button', { name: 'High' }));

    expect(onResetSelect).toHaveBeenCalledWith('groomed');
    expect(onSetPriority).toHaveBeenCalledWith('high');
  });

  it('derives reset targets and validates only leftward drops', () => {
    expect(getResetTargetsForTest([PLANNED_LABEL])).toEqual(['new', 'groomed', 'designed']);
    expect(getResetTargetsForTest([PR_OPEN_LABEL])).toEqual([
      'new',
      'groomed',
      'designed',
      'planned',
      'implemented',
    ]);

    const source = {
      issue: createIssue({ labels: [PLANNED_LABEL] }),
      columnIndex: 2,
    };

    expect(isValidDropTargetForTest(source, 1)).toBe(true);
    expect(isValidDropTargetForTest(source, 2)).toBe(false);
    expect(isValidDropTargetForTest(source, 3)).toBe(false);
  });

  it('renders zero token totals when there is no session history', () => {
    render(<IssueCard issue={createIssue()} totalTokens={0} />);

    expect(screen.getByLabelText('0 total tokens').textContent).toBe('0');
  });

  it('renders compact token totals as non-interactive text', () => {
    render(<IssueCard issue={createIssue()} totalTokens={12_345} onShip={vi.fn()} />);

    const indicator = screen.getByLabelText('12345 total tokens');

    expect(indicator.textContent).toBe('12.3k');
    expect(screen.queryByRole('button', { name: '12.3k' })).toBeNull();
    expect(screen.queryByRole('link', { name: '12.3k' })).toBeNull();
  });
});
