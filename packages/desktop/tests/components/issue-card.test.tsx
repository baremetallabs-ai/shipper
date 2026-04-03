// @vitest-environment jsdom

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ListIssueItem, WorkflowStage } from '@dnsquared/shipper-core';
import {
  BLOCKED_LABEL,
  LOCKED_LABEL,
  PLANNED_LABEL,
  PR_OPEN_LABEL,
  PRIORITY_HIGH_LABEL,
} from '../../../core/src/lib/labels.js';
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
        onGroom={vi.fn()}
        onShip={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Groom' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Ship' })).toHaveProperty('disabled', true);
  });

  it('fires groom, ship, and drag callbacks', () => {
    const onGroom = vi.fn();
    const onShip = vi.fn();
    const onDragStart = vi.fn();

    render(
      <IssueCard
        issue={createIssue()}
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

  it('invokes reset and priority menu actions', () => {
    const onResetSelect = vi.fn();
    const onSetPriority = vi.fn();

    render(
      <IssueCard
        issue={createIssue()}
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
});
