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
  type TokenUsage,
  type WorkflowStage,
} from '@dnsquared/shipper-core';
import type { DragSource } from '../../src/renderer/hooks/use-drag-drop.js';
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

vi.mock('../../src/renderer/components/ui/tooltip.js', async () => {
  const { createTooltipMock } = await import('../test-utils/tooltip-mock.js');
  return createTooltipMock();
});

const getResetTargetsForTest = getResetTargets as unknown as (labels: string[]) => WorkflowStage[];
const isValidDropTargetForTest = isValidDropTarget as unknown as (
  source: DragSource,
  targetStage: WorkflowStage
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

function createTokenUsage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
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
        tokenUsage={createTokenUsage()}
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
        tokenUsage={createTokenUsage()}
        onGroom={vi.fn()}
        onShip={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Groom' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Ship' })).toHaveProperty('disabled', true);
  });

  it('renders disabled Groom button feedback while a groom launch is pending', () => {
    render(
      <IssueCard
        issue={createIssue()}
        tokenUsage={createTokenUsage()}
        onGroom={vi.fn()}
        isGroomPending
      />
    );

    const groomButton = screen.getByRole('button', { name: 'Groom' });

    expect(groomButton).toHaveProperty('disabled', true);
    expect(groomButton.textContent).toContain('Groom');
    expect(groomButton.innerHTML).toContain('animate-spin');
  });

  it('renders failed styling on the card surface', () => {
    render(
      <IssueCard issue={createIssue({ labels: [FAILED_LABEL] })} tokenUsage={createTokenUsage()} />
    );

    const card = screen.getByTestId('issue-card-12');

    expect(card.className).toContain('border-destructive/50');
    expect(card.className).toContain('bg-destructive/10');
    expect(screen.getByText('Failed')).toBeTruthy();
  });

  it('renders paused styling, the pause icon, and a Resume menu action', () => {
    const onResume = vi.fn();

    render(
      <IssueCard
        issue={createIssue()}
        tokenUsage={createTokenUsage()}
        isPaused
        onResume={onResume}
      />
    );

    const card = screen.getByTestId('issue-card-12');
    expect(card.className).toContain('border-orange-500');
    expect(card.className).toContain('bg-orange-500/5');
    expect(screen.getByLabelText('Issue #12 is paused')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('renders paused and blocked indicators together', () => {
    render(
      <IssueCard
        issue={createIssue({ labels: [PLANNED_LABEL, BLOCKED_LABEL] })}
        tokenUsage={createTokenUsage()}
        isPaused
      />
    );

    expect(screen.getByLabelText('Issue #12 is paused')).toBeTruthy();
    expect(screen.getByText('Blocked')).toBeTruthy();
  });

  it('renders a non-blocking pausing indicator while leaving stop available', () => {
    render(
      <IssueCard
        issue={createIssue()}
        tokenUsage={createTokenUsage()}
        isPausePending
        shippingStatus="running"
        onStopShip={vi.fn()}
      />
    );

    expect(screen.getByText('Pausing...')).toBeTruthy();
    expect(screen.getByLabelText('Stop shipping #12')).toBeTruthy();
  });

  it('renders failed and blocked indicators together', () => {
    render(
      <IssueCard
        issue={createIssue({ labels: [FAILED_LABEL, BLOCKED_LABEL] })}
        tokenUsage={createTokenUsage()}
      />
    );

    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getByText('Blocked')).toBeTruthy();
  });

  it('renders failed and locked indicators together', () => {
    render(
      <IssueCard
        issue={createIssue({ labels: [FAILED_LABEL, LOCKED_LABEL] })}
        tokenUsage={createTokenUsage()}
      />
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
        tokenUsage={createTokenUsage()}
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
    render(<IssueCard issue={createIssue()} tokenUsage={createTokenUsage()} />);
    const link = screen.getByRole('link', { name: '#12' });

    expect(link).toHaveProperty('href', 'https://github.com/owner/repo/issues/12');
    expect(link).toHaveProperty('target', '_blank');
    expect(link).toHaveProperty('rel', 'noreferrer');
  });

  it('prevents drag from starting on the issue link', () => {
    const onDragStart = vi.fn();

    render(
      <IssueCard
        issue={createIssue()}
        tokenUsage={createTokenUsage()}
        draggable
        onDragStart={onDragStart}
      />
    );
    const link = screen.getByRole('link', { name: '#12' });
    const dragEvent = createEvent.dragStart(link, {
      dataTransfer: { effectAllowed: 'move' },
    });
    fireEvent(link, dragEvent);

    expect(dragEvent.defaultPrevented).toBe(true);
    expect(onDragStart).not.toHaveBeenCalled();
  });

  it('keeps the issue title as plain text', () => {
    render(<IssueCard issue={createIssue()} tokenUsage={createTokenUsage()} />);

    expect(screen.queryByRole('link', { name: 'Extract renderer components' })).toBeNull();
  });

  it('renders a primary Reset control for failed cards and keeps the overflow Reset menu', () => {
    const onResetSelect = vi.fn();

    render(
      <IssueCard
        issue={createIssue({ labels: [FAILED_LABEL] })}
        tokenUsage={createTokenUsage()}
        onGroom={vi.fn()}
        onShip={vi.fn()}
        resetTargets={['new', 'groomed']}
        onResetSelect={onResetSelect}
      />
    );

    expect(screen.queryByRole('button', { name: 'Groom' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ship' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Reset' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'New' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Groomed' })).toHaveLength(2);

    fireEvent.click(screen.getAllByRole('button', { name: 'New' })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Groomed' })[1]);

    expect(onResetSelect).toHaveBeenNthCalledWith(1, 'new');
    expect(onResetSelect).toHaveBeenNthCalledWith(2, 'groomed');
  });

  it('invokes reset and priority menu actions', () => {
    const onResetSelect = vi.fn();
    const onSetPriority = vi.fn();

    render(
      <IssueCard
        issue={createIssue()}
        tokenUsage={createTokenUsage()}
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

  it('renders a Pause menu action when the issue is not paused', () => {
    const onPause = vi.fn();

    render(<IssueCard issue={createIssue()} tokenUsage={createTokenUsage()} onPause={onPause} />);

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(onPause).toHaveBeenCalledTimes(1);
  });

  it('derives reset targets for failed-only and failed-plus-stage issues', () => {
    expect(getResetTargetsForTest([PLANNED_LABEL])).toEqual(['new', 'groomed', 'designed']);
    expect(getResetTargetsForTest([PR_OPEN_LABEL])).toEqual([
      'new',
      'groomed',
      'designed',
      'planned',
      'implemented',
    ]);
    expect(getResetTargetsForTest([FAILED_LABEL])).toEqual([
      'new',
      'groomed',
      'designed',
      'planned',
      'implemented',
    ]);
    expect(getResetTargetsForTest([FAILED_LABEL, PLANNED_LABEL])).toEqual([
      'new',
      'groomed',
      'designed',
    ]);
  });

  it('validates reset drop targets for attention and pipeline drag sources', () => {
    const attentionSource: DragSource = {
      kind: 'attention',
      issue: createIssue({ labels: [FAILED_LABEL] }),
    };
    const pipelineSource: DragSource = {
      kind: 'pipeline',
      issue: createIssue({ labels: [PLANNED_LABEL] }),
      columnIndex: 2,
    };

    expect(isValidDropTargetForTest(attentionSource, 'implemented')).toBe(true);
    expect(isValidDropTargetForTest(attentionSource, 'new')).toBe(true);
    expect(isValidDropTargetForTest(pipelineSource, 'designed')).toBe(true);
    expect(isValidDropTargetForTest(pipelineSource, 'new')).toBe(false);
    expect(isValidDropTargetForTest(pipelineSource, 'planned')).toBe(false);
  });

  it('renders zero token totals as a focusable button with the full spoken breakdown', () => {
    render(<IssueCard issue={createIssue()} tokenUsage={createTokenUsage()} />);

    expect(screen.getByText('0 tokens')).toBeTruthy();
    expect(
      screen.getByRole('button', {
        name: '0 total tokens: 0 input, 0 output, 0 cache read, 0 cache write',
      })
    ).toBeTruthy();
  });

  it('renders exact totals below one thousand and compact totals at one thousand and above', () => {
    const { rerender } = render(
      <IssueCard
        issue={createIssue()}
        tokenUsage={createTokenUsage({ inputTokens: 321, outputTokens: 666 })}
      />
    );

    expect(screen.getByText('987 tokens')).toBeTruthy();

    rerender(
      <IssueCard
        issue={createIssue()}
        tokenUsage={createTokenUsage({
          inputTokens: 5_000,
          outputTokens: 3_000,
          cacheReadTokens: 2_000,
          cacheWriteTokens: 2_345,
        })}
        onShip={vi.fn()}
      />
    );

    expect(screen.getByText('12.3k tokens')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ship' })).toBeTruthy();
  });

  it('opens the tooltip on pointer hover and closes it on pointer leave', () => {
    render(
      <IssueCard
        issue={createIssue()}
        tokenUsage={createTokenUsage({
          inputTokens: 5_000,
          outputTokens: 3_000,
          cacheReadTokens: 2_000,
          cacheWriteTokens: 2_345,
        })}
      />
    );

    const tokenButton = screen.getByRole('button', {
      name: '12,345 total tokens: 5,000 input, 3,000 output, 2,000 cache read, 2,345 cache write',
    });

    expect(screen.queryByText('Input')).toBeNull();

    fireEvent.pointerEnter(tokenButton);

    const rows = screen.getAllByText(/^(Input|Output|Cache read|Cache write)$/);
    expect(rows).toHaveLength(4);
    expect(rows[0]?.textContent).toBe('Input');
    expect(rows[1]?.textContent).toBe('Output');
    expect(rows[2]?.textContent).toBe('Cache read');
    expect(rows[3]?.textContent).toBe('Cache write');
    expect(screen.getByText('5k')).toBeTruthy();
    expect(screen.getByText('3k')).toBeTruthy();
    expect(screen.getByText('2k')).toBeTruthy();
    expect(screen.getByText('2.3k')).toBeTruthy();

    fireEvent.pointerLeave(tokenButton);

    expect(screen.queryByText('Input')).toBeNull();
  });

  it('opens the tooltip on focus and closes it on Escape and blur', () => {
    render(
      <IssueCard
        issue={createIssue()}
        tokenUsage={createTokenUsage({
          inputTokens: 987,
          outputTokens: 1_200,
          cacheReadTokens: 0,
          cacheWriteTokens: 1_400_000,
        })}
      />
    );

    const tokenButton = screen.getByRole('button', {
      name: '1,402,187 total tokens: 987 input, 1,200 output, 0 cache read, 1,400,000 cache write',
    });

    fireEvent.focus(tokenButton);

    expect(screen.getByText('Input')).toBeTruthy();
    expect(screen.getByText('987')).toBeTruthy();
    expect(screen.getByText('1.2k')).toBeTruthy();
    expect(screen.getByText('0')).toBeTruthy();
    expect(screen.getByText('1.4M')).toBeTruthy();

    fireEvent.keyDown(tokenButton, { key: 'Escape' });
    expect(screen.queryByText('Input')).toBeNull();

    fireEvent.focus(tokenButton);
    expect(screen.getByText('Input')).toBeTruthy();

    fireEvent.blur(tokenButton);
    expect(screen.queryByText('Input')).toBeNull();
  });
});
