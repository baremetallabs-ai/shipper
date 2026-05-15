// @vitest-environment jsdom

import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
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
    repo: 'owner/repo',
    issueNumber: 12,
    issueUrl: 'https://github.com/owner/repo/issues/12',
    issueTitle: 'Improve activity cards',
    canCancel: true,
    canShowLogs: true,
    ...overrides,
  };
}

function renderDrawer(commands: ActionQueueItem[], open = true) {
  const handlers = {
    onToggle: vi.fn(),
    onCancel: vi.fn(),
    onShowLogs: vi.fn(),
    onClearFinished: vi.fn(),
    onDismiss: vi.fn(),
  };

  const rendered = render(<ActionQueueDrawer open={open} commands={commands} {...handlers} />);

  return { ...rendered, ...handlers };
}

function getArticleByText(text: string) {
  const article = screen.getByText(text).closest('article');
  if (!article) {
    throw new Error(`Expected "${text}" to be inside an article.`);
  }

  return article;
}

describe('ActionQueueDrawer', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('uses Activity copy for heading, empty state, and toggle accessible names', () => {
    renderDrawer([]);
    expect(screen.getByText('Activity')).toBeTruthy();
    expect(screen.getByText('No activity yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close activity' })).toBeTruthy();

    renderDrawer([], false);
    expect(screen.getByRole('button', { name: 'Open activity' })).toBeTruthy();

    renderDrawer([createCommand()], false);
    expect(screen.getByRole('button', { name: 'Open activity (1 active)' })).toBeTruthy();
  });

  it('keeps a multi-repo activity set as one sorted flat list', () => {
    renderDrawer([
      createCommand({ id: 'complete', status: 'complete', canCancel: false, repo: 'other/repo' }),
      createCommand({ id: 'running', status: 'running', repo: 'owner/repo', issueNumber: 13 }),
      createCommand({ id: 'failed', status: 'failed', canCancel: false, repo: 'third/repo' }),
    ]);

    const articles = [...globalThis.document.querySelectorAll('article')];
    expect(articles).toHaveLength(3);
    expect(articles.map((article) => article.textContent)).toEqual([
      expect.stringContaining('owner/repo'),
      expect.stringContaining('third/repo'),
      expect.stringContaining('other/repo'),
    ]);
    expect(screen.queryByText(/needs you/i)).toBeNull();
    expect(screen.queryByText(/recent/i)).toBeNull();
  });

  it('renders a ship card as command badge, issue link, title, repo time, and visible actions', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(baseNow));
    const { onCancel, onShowLogs } = renderDrawer([
      createCommand({
        status: 'running',
        issueNumber: 12,
        issueUrl: 'https://github.com/owner/repo/issues/12',
        issueTitle: 'Polish Activity drawer',
      }),
    ]);

    const article = getArticleByText('Polish Activity drawer');
    expect(within(article).getByText('SHIP')).toBeTruthy();
    expect(within(article).getByRole('link', { name: '#12' }).getAttribute('href')).toBe(
      'https://github.com/owner/repo/issues/12'
    );
    expect(within(article).getByText('Running')).toBeTruthy();
    expect(article.textContent).toContain('owner/repo');
    expect(article.textContent).toContain('Just now');
    expect(article.textContent).not.toContain('Ship #12');
    expect(article.textContent).not.toContain('· merge');
    expect(screen.queryByText('Working')).toBeNull();
    expect(screen.queryByText(/pull request/i)).toBeNull();

    fireEvent.click(within(article).getByRole('button', { name: 'Logs' }));
    fireEvent.click(within(article).getByRole('button', { name: 'Stop #12' }));
    expect(onShowLogs).toHaveBeenCalledWith('command-1');
    expect(onCancel).toHaveBeenCalledWith('command-1');
  });

  it('renders issue links for every status and falls back to repo issue URLs', () => {
    renderDrawer([
      createCommand({ id: 'queued', status: 'queued', issueNumber: 21, issueUrl: undefined }),
      createCommand({ id: 'running', status: 'running', issueNumber: 22 }),
      createCommand({ id: 'paused', status: 'paused', canCancel: false, issueNumber: 23 }),
      createCommand({ id: 'failed', status: 'failed', canCancel: false, issueNumber: 24 }),
      createCommand({ id: 'complete', status: 'complete', canCancel: false, issueNumber: 25 }),
    ]);

    expect(screen.getByRole('link', { name: '#21' }).getAttribute('href')).toBe(
      'https://github.com/owner/repo/issues/21'
    );
    expect(screen.getByRole('link', { name: '#22' }).getAttribute('href')).toBe(
      'https://github.com/owner/repo/issues/12'
    );
    expect(screen.getByRole('link', { name: '#23' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '#24' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '#25' })).toBeTruthy();
  });

  it('omits issue reference and title row when an issue is not resolvable', () => {
    renderDrawer([
      createCommand({
        id: 'init',
        command: 'init',
        issueNumber: undefined,
        issueUrl: undefined,
        issueTitle: undefined,
      }),
      createCommand({
        id: 'new',
        command: 'new',
        issueNumber: undefined,
        issueUrl: undefined,
        issueTitle: undefined,
      }),
    ]);

    expect(globalThis.document.querySelector('a[href*="/issues/"]')).toBeNull();
    expect(screen.queryByText('Improve activity cards')).toBeNull();
  });

  it('shows Dismiss for inactive cards while keeping Logs visible by existing rules', () => {
    const { onDismiss } = renderDrawer([
      createCommand({ id: 'failed', status: 'failed', canCancel: false }),
    ]);

    const article = getArticleByText('Improve activity cards');
    expect(within(article).getByRole('button', { name: 'Logs' })).toBeTruthy();
    fireEvent.click(within(article).getByRole('button', { name: 'Dismiss #12' }));
    expect(onDismiss).toHaveBeenCalledWith('failed');
  });

  it('resolves incomplete and completed status-or-stage badges', () => {
    renderDrawer([
      createCommand({ id: 'queued', status: 'queued', issueNumber: 31 }),
      createCommand({ id: 'running', status: 'running', issueNumber: 32 }),
      createCommand({ id: 'paused', status: 'paused', canCancel: false, issueNumber: 33 }),
      createCommand({ id: 'failed', status: 'failed', canCancel: false, issueNumber: 34 }),
      createCommand({
        id: 'cancelled',
        status: 'failed',
        cancelled: true,
        canCancel: false,
        issueNumber: 35,
      }),
      createCommand({ id: 'new', command: 'new', status: 'complete', canCancel: false }),
      createCommand({ id: 'init', command: 'init', status: 'complete', canCancel: false }),
      createCommand({ id: 'ship-merged', status: 'complete', canCancel: false, prMerged: true }),
      createCommand({
        id: 'ship-ready',
        status: 'complete',
        canCancel: false,
        prMerged: false,
        workflowStage: 'Ready',
        issueNumber: 36,
      }),
      createCommand({
        id: 'unblock-blocked',
        command: 'unblock',
        status: 'complete',
        canCancel: false,
        stillBlocked: true,
        issueNumber: 37,
      }),
      createCommand({
        id: 'unblock-planned',
        command: 'unblock',
        status: 'complete',
        canCancel: false,
        workflowStage: 'Planned',
        issueNumber: 38,
      }),
      createCommand({ id: 'unknown-stage', status: 'complete', canCancel: false, issueNumber: 39 }),
    ]);

    for (const label of ['Queued', 'Running', 'Paused', 'Failed', 'Cancelled']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getAllByText('Succeeded').length).toBeGreaterThanOrEqual(4);
    expect(screen.getByText('Ready')).toBeTruthy();
    expect(screen.getByText('Blocked')).toBeTruthy();
    expect(screen.getByText('Planned')).toBeTruthy();
  });

  it('formats state-change relative times across supported ranges', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(baseNow));

    renderDrawer([
      createCommand({ id: 'under-10', stateChangedAt: baseNow - 9_000 }),
      createCommand({ id: 'seconds', stateChangedAt: baseNow - 30_000, issueNumber: 13 }),
      createCommand({ id: 'minutes', stateChangedAt: baseNow - 5 * 60_000, issueNumber: 14 }),
      createCommand({ id: 'hours', stateChangedAt: baseNow - 2 * 60 * 60_000, issueNumber: 15 }),
      createCommand({
        id: 'days',
        stateChangedAt: baseNow - 3 * 24 * 60 * 60_000,
        issueNumber: 16,
      }),
      createCommand({ id: 'future', stateChangedAt: baseNow + 5_000, issueNumber: 17 }),
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

  it('ticks active row labels while open without ticking terminal rows', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(baseNow));

    renderDrawer([
      createCommand({ id: 'running', status: 'running', stateChangedAt: baseNow }),
      createCommand({
        id: 'complete',
        status: 'complete',
        canCancel: false,
        stateChangedAt: baseNow,
        issueNumber: 13,
      }),
    ]);
    expect(screen.getAllByText('Just now')).toHaveLength(2);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(screen.getByRole('button', { name: /^30s ago; state changed/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Just now; state changed/ })).toBeTruthy();
  });

  it('does not tick while closed and refreshes immediately when reopened', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(baseNow));
    const handlers = {
      onToggle: vi.fn(),
      onCancel: vi.fn(),
      onShowLogs: vi.fn(),
      onClearFinished: vi.fn(),
      onDismiss: vi.fn(),
    };
    const { rerender } = render(
      <ActionQueueDrawer open={false} commands={[createCommand()]} {...handlers} />
    );

    expect(screen.getByText('Just now')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByText('Just now')).toBeTruthy();

    act(() => {
      rerender(<ActionQueueDrawer open commands={[createCommand()]} {...handlers} />);
    });

    expect(screen.getByText('30s ago')).toBeTruthy();
  });
});
