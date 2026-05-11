// @vitest-environment jsdom

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ActionQueueDrawer,
  type ActionQueueItem,
} from '../../src/renderer/components/action-queue-drawer.js';

vi.mock('../../src/renderer/components/ui/tooltip.js', async () => {
  const { createTooltipMock } = await import('../test-utils/tooltip-mock.js');
  return createTooltipMock();
});

const baseNow = Date.parse('2026-04-03T12:00:00.000Z');

function createCommand(overrides: Partial<ActionQueueItem> = {}): ActionQueueItem {
  return {
    id: 'command-1',
    command: 'ship',
    status: 'running',
    stateChangedAt: baseNow,
    title: 'Ship #12',
    repo: 'owner/repo',
    detail: 'Working',
    canCancel: true,
    canShowLogs: true,
    ...overrides,
  };
}

function renderDrawer(commands: ActionQueueItem[], open = true) {
  return render(
    <ActionQueueDrawer
      open={open}
      onToggle={vi.fn()}
      commands={commands}
      onCancel={vi.fn()}
      onShowLogs={vi.fn()}
      onClearFinished={vi.fn()}
      onDismiss={vi.fn()}
    />
  );
}

describe('ActionQueueDrawer', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('formats state-change relative times across supported ranges', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(baseNow));

    renderDrawer([
      createCommand({ id: 'under-10', title: 'Under 10', stateChangedAt: baseNow - 9_000 }),
      createCommand({ id: 'seconds', title: 'Seconds', stateChangedAt: baseNow - 30_000 }),
      createCommand({ id: 'minutes', title: 'Minutes', stateChangedAt: baseNow - 5 * 60_000 }),
      createCommand({ id: 'hours', title: 'Hours', stateChangedAt: baseNow - 2 * 60 * 60_000 }),
      createCommand({ id: 'days', title: 'Days', stateChangedAt: baseNow - 3 * 24 * 60 * 60_000 }),
      createCommand({ id: 'future', title: 'Future', stateChangedAt: baseNow + 5_000 }),
    ]);

    expect(screen.getAllByText('Just now')).toHaveLength(2);
    expect(screen.getByText('30s ago')).toBeTruthy();
    expect(screen.getByText('5m ago')).toBeTruthy();
    expect(screen.getByText('2h ago')).toBeTruthy();
    expect(screen.getByText('3d ago')).toBeTruthy();
  });

  it('reveals the absolute state-change timestamp from the focusable relative label', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(baseNow));
    const stateChangedAt = Date.parse('2026-04-03T11:59:30.000Z');
    const absoluteTime = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'medium',
    }).format(new Date(stateChangedAt));

    renderDrawer([createCommand({ stateChangedAt })]);
    const relativeTimeButton = screen.getByRole('button', {
      name: `30s ago; state changed ${absoluteTime}`,
    });

    fireEvent.focus(relativeTimeButton);

    expect(screen.getByText(absoluteTime)).toBeTruthy();

    fireEvent.blur(relativeTimeButton);
    expect(screen.queryByText(absoluteTime)).toBeNull();
  });

  it('ticks active row labels while open without receiving new command props', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(baseNow));

    renderDrawer([createCommand({ status: 'running', stateChangedAt: baseNow })]);
    expect(screen.getByText('Just now')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(screen.getByText('30s ago')).toBeTruthy();
  });

  it('does not tick while closed and refreshes immediately when reopened', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(baseNow));
    const { rerender } = render(
      <ActionQueueDrawer
        open={false}
        onToggle={vi.fn()}
        commands={[createCommand({ status: 'running', stateChangedAt: baseNow })]}
        onCancel={vi.fn()}
        onShowLogs={vi.fn()}
        onClearFinished={vi.fn()}
        onDismiss={vi.fn()}
      />
    );

    expect(screen.getByText('Just now')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByText('Just now')).toBeTruthy();

    act(() => {
      rerender(
        <ActionQueueDrawer
          open
          onToggle={vi.fn()}
          commands={[createCommand({ status: 'running', stateChangedAt: baseNow })]}
          onCancel={vi.fn()}
          onShowLogs={vi.fn()}
          onClearFinished={vi.fn()}
          onDismiss={vi.fn()}
        />
      );
    });

    expect(screen.getByText('30s ago')).toBeTruthy();
  });

  it('does not keep an interval alive for terminal rows alone', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(baseNow));

    renderDrawer([
      createCommand({
        id: 'complete',
        status: 'complete',
        canCancel: false,
        stateChangedAt: baseNow,
      }),
    ]);
    expect(screen.getByText('Just now')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(screen.getByText('Just now')).toBeTruthy();
  });

  it('renders complete rows as succeeded with success styling', () => {
    renderDrawer([
      createCommand({
        id: 'complete',
        status: 'complete',
        canCancel: false,
        title: 'Terminal command',
        detail: 'Ship succeeded',
      }),
    ]);

    const statusLabel = screen.getByText('Succeeded');
    const statusBadge = statusLabel.closest('[data-slot="badge"]');

    expect(statusLabel).toBeTruthy();
    expect(statusBadge?.getAttribute('data-variant')).toBe('success');
    expect(screen.queryByText('Complete')).toBeNull();
  });

  it('does not tick terminal row labels when active rows refresh', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(baseNow));

    renderDrawer([
      createCommand({
        id: 'running',
        title: 'Running command',
        status: 'running',
        stateChangedAt: baseNow,
      }),
      createCommand({
        id: 'complete',
        title: 'Terminal command',
        status: 'complete',
        canCancel: false,
        stateChangedAt: baseNow,
      }),
    ]);
    expect(screen.getAllByText('Just now')).toHaveLength(2);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(screen.getByRole('button', { name: /^30s ago; state changed/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Just now; state changed/ })).toBeTruthy();
  });

  it('renders relative labels for New, Ship, Init, and Unblock rows', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(baseNow));

    renderDrawer([
      createCommand({ id: 'new', command: 'new', title: 'New issue' }),
      createCommand({ id: 'ship', command: 'ship', title: 'Ship #12' }),
      createCommand({ id: 'init', command: 'init', title: 'Init repo' }),
      createCommand({ id: 'unblock', command: 'unblock', title: 'Unblock #13' }),
    ]);

    expect(screen.getByText('New')).toBeTruthy();
    expect(screen.getByText('Ship')).toBeTruthy();
    expect(screen.getByText('Init')).toBeTruthy();
    expect(screen.getByText('Unblock')).toBeTruthy();
    expect(screen.getAllByText('Just now')).toHaveLength(4);
  });
});
