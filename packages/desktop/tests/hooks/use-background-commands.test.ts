// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BLOCKED_LABEL,
  LOCKED_LABEL,
  PLANNED_LABEL,
  PR_REVIEWED_LABEL,
  READY_LABEL,
} from '@dnsquared/shipper-core';
import type { IssuePipelineBridge, IssueListResult } from '../../src/renderer/types.js';
import { useBackgroundCommands } from '../../src/renderer/hooks/use-background-commands.js';
import {
  createMockShipperApi,
  flushHookEffects,
  setupHookTestTimers,
  teardownHookTestTimers,
} from './test-utils.js';
import { MAX_AUTO_SHIP_CONSECUTIVE_FAILURES } from '../../src/renderer/lib/constants.js';

function createIssue(number: number, labels: string[] = [PLANNED_LABEL]) {
  return {
    number,
    title: `Issue ${number}`,
    labels,
    state: 'OPEN' as const,
    author: 'octocat',
    createdAt: '2026-04-03T00:00:00Z',
    url: `https://github.com/owner/repo/issues/${number}`,
  };
}

function createPipelineBridge(): IssuePipelineBridge {
  return {
    loadIssues: vi.fn(() => Promise.resolve({ ok: true, issues: [] } satisfies IssueListResult)),
    clearIssueState: vi.fn(),
    clearStageCacheForRepo: vi.fn(),
    setFetchError: vi.fn(),
    getIssueByNumber: vi.fn(),
    getPausedIssues: vi.fn(() => new Set<number>()),
    trackPausedIssue: vi.fn(),
    clearPausedIssue: vi.fn(),
    trackUnblockIssue: vi.fn(),
    clearUnblockIssue: vi.fn(),
  };
}

describe('useBackgroundCommands', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('tracks background status/output events and loads log viewer content', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    vi.mocked(shipper.api.getBackgroundOutput).mockResolvedValue('complete log output');
    const pipelineBridge = createPipelineBridge();
    vi.mocked(pipelineBridge.loadIssues).mockResolvedValue({
      ok: true,
      issues: [createIssue(42)],
    });
    const { result } = renderHook(() =>
      useBackgroundCommands({
        activeRepo: 'owner/repo',
        autoMergeRepos: new Set(),
        checkInitState: vi.fn(() => Promise.resolve(undefined)),
        pipelineBridgeRef: { current: pipelineBridge },
      })
    );
    await flushHookEffects();

    shipper.emitBackgroundStatus({
      sessionId: 'ship-1',
      command: 'ship',
      repo: 'owner/repo',
      status: 'complete',
      meta: { issueNumber: 11, merge: false },
    });
    shipper.emitBackgroundOutput({ sessionId: 'ship-1', data: 'progress\n' });
    await flushHookEffects();

    await waitFor(() => {
      expect(result.current.actionQueueOpen).toBe(true);
      expect(result.current.backgroundCommands[0]).toEqual(
        expect.objectContaining({
          id: 'ship-1',
          status: 'complete',
          output: 'progress\n',
        })
      );
    });

    void result.current.handleShowBackgroundLogs('ship-1');

    await waitFor(() => {
      expect(shipper.api.getBackgroundOutput).toHaveBeenCalledWith('ship-1');
      expect(result.current.logViewer.open).toBe(true);
      expect(result.current.logViewer.content).toBe('complete log output');
    });
  });

  it('anchors stateChangedAt to displayed background state transitions', async () => {
    setupHookTestTimers('2026-04-03T12:00:00.000Z');
    try {
      const shipper = createMockShipperApi();
      shipper.install();
      const { result } = renderHook(() =>
        useBackgroundCommands({
          activeRepo: 'owner/repo',
          autoMergeRepos: new Set(),
          checkInitState: vi.fn(() => Promise.resolve(undefined)),
          pipelineBridgeRef: { current: createPipelineBridge() },
        })
      );
      await flushHookEffects();

      const queuedAt = Date.parse('2026-04-03T12:00:00.000Z');
      shipper.emitBackgroundStatus({
        sessionId: 'ship-state-time',
        command: 'ship',
        repo: 'owner/repo',
        status: 'queued',
        meta: { issueNumber: 11, merge: false },
      });
      await flushHookEffects();
      expect(result.current.backgroundCommands[0]?.stateChangedAt).toBe(queuedAt);

      const runningAt = Date.parse('2026-04-03T12:00:30.000Z');
      vi.setSystemTime(new Date(runningAt));
      shipper.emitBackgroundStatus({
        sessionId: 'ship-state-time',
        command: 'ship',
        repo: 'owner/repo',
        status: 'running',
        meta: { issueNumber: 11, merge: false },
      });
      await flushHookEffects();
      expect(result.current.backgroundCommands[0]?.stateChangedAt).toBe(runningAt);

      vi.setSystemTime(new Date('2026-04-03T12:01:00.000Z'));
      shipper.emitBackgroundStatus({
        sessionId: 'ship-state-time',
        command: 'ship',
        repo: 'owner/repo',
        status: 'running',
        meta: { issueNumber: 11, merge: false, pausePending: true },
      });
      await flushHookEffects();
      expect(result.current.backgroundCommands[0]?.stateChangedAt).toBe(runningAt);

      const cancelledAt = Date.parse('2026-04-03T12:02:00.000Z');
      vi.setSystemTime(new Date(cancelledAt));
      shipper.emitBackgroundStatus({
        sessionId: 'ship-state-time',
        command: 'ship',
        repo: 'owner/repo',
        status: 'failed',
        exitCode: 130,
        meta: { issueNumber: 11, merge: false, cancelled: true },
      });
      await flushHookEffects();
      expect(result.current.backgroundCommands[0]).toEqual(
        expect.objectContaining({
          status: 'failed',
          cancelled: true,
          stateChangedAt: cancelledAt,
        })
      );
    } finally {
      teardownHookTestTimers();
    }
  });

  it('retries failed commands from toast payloads and removes the old command entry', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    const { result } = renderHook(() =>
      useBackgroundCommands({
        activeRepo: 'owner/repo',
        autoMergeRepos: new Set(),
        checkInitState: vi.fn(() => Promise.resolve(undefined)),
        pipelineBridgeRef: { current: createPipelineBridge() },
      })
    );
    await flushHookEffects();

    shipper.emitBackgroundStatus({
      sessionId: 'ship-2',
      command: 'ship',
      repo: 'owner/repo',
      status: 'failed',
      exitCode: 1,
      meta: { issueNumber: 22, merge: true, origin: 'auto' },
    });

    await act(async () => {
      await result.current.handleRetryToast('ship-2');
    });

    expect(shipper.api.spawnBackgroundShip).toHaveBeenCalledWith(22, 'owner/repo', true, 'auto');
    expect(result.current.toasts).toHaveLength(0);
    expect(result.current.backgroundCommands).toHaveLength(0);
  });

  it('refreshes the active repo after a failed ship without adding unlock-specific UI', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    const pipelineBridge = createPipelineBridge();
    vi.mocked(pipelineBridge.loadIssues).mockResolvedValue({
      ok: true,
      issues: [createIssue(23)],
    });
    const { result } = renderHook(() =>
      useBackgroundCommands({
        activeRepo: 'owner/repo',
        autoMergeRepos: new Set(),
        checkInitState: vi.fn(() => Promise.resolve(undefined)),
        pipelineBridgeRef: { current: pipelineBridge },
      })
    );
    await flushHookEffects();

    shipper.emitBackgroundStatus({
      sessionId: 'ship-failed-refresh',
      command: 'ship',
      repo: 'owner/repo',
      status: 'failed',
      exitCode: 1,
      meta: { issueNumber: 23, merge: false },
    });
    await flushHookEffects();

    await waitFor(() => {
      expect(pipelineBridge.loadIssues).toHaveBeenCalledWith('owner/repo');
      expect(result.current.toasts).toEqual([
        expect.objectContaining({
          sessionId: 'ship-failed-refresh',
          variant: 'error',
          title: 'Ship #23 failed',
        }),
      ]);
    });

    expect(result.current.toasts.some((toast) => /unlock|lock release/i.test(toast.title))).toBe(
      false
    );
    expect(
      result.current.toasts.some((toast) => /unlock|lock release/i.test(toast.description))
    ).toBe(false);
  });

  it('queues the next auto-ship candidate after a completed ship when auto-ship is enabled', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    vi.mocked(shipper.api.listIssues).mockResolvedValue({
      ok: true,
      issues: [createIssue(31)],
    });
    const { result } = renderHook(() =>
      useBackgroundCommands({
        activeRepo: 'owner/repo',
        autoMergeRepos: new Set(['owner/repo']),
        checkInitState: vi.fn(() => Promise.resolve(undefined)),
        pipelineBridgeRef: { current: createPipelineBridge() },
      })
    );
    await flushHookEffects();

    act(() => {
      result.current.enableAutoShipForRepo('owner/repo');
    });
    shipper.emitBackgroundStatus({
      sessionId: 'ship-3',
      command: 'ship',
      repo: 'owner/repo',
      status: 'complete',
      meta: { issueNumber: 30, merge: true },
    });
    await flushHookEffects();

    await waitFor(() => {
      expect(shipper.api.spawnBackgroundShip).toHaveBeenCalledWith(31, 'owner/repo', true, 'auto');
      expect(result.current.toasts).toContainEqual(
        expect.objectContaining({
          title: 'Auto-ship: starting #31',
        })
      );
    });
  });

  it('shows an info toast for retriable auto-ship failures and reselects the same issue', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    vi.mocked(shipper.api.listIssues).mockResolvedValue({
      ok: true,
      issues: [createIssue(31)],
    });
    const { result } = renderHook(() =>
      useBackgroundCommands({
        activeRepo: 'owner/repo',
        autoMergeRepos: new Set(),
        checkInitState: vi.fn(() => Promise.resolve(undefined)),
        pipelineBridgeRef: { current: createPipelineBridge() },
      })
    );
    await flushHookEffects();

    act(() => {
      result.current.enableAutoShipForRepo('owner/repo');
    });

    shipper.emitBackgroundStatus({
      sessionId: 'ship-retriable-auto',
      command: 'ship',
      repo: 'owner/repo',
      status: 'failed',
      exitCode: 76,
      meta: { issueNumber: 31, merge: false, origin: 'auto', retriable: true },
    });
    await flushHookEffects();

    await waitFor(() => {
      expect(result.current.backgroundCommands).toContainEqual(
        expect.objectContaining({
          id: 'ship-retriable-auto',
          status: 'failed',
          retriable: true,
          detail: 'Will retry later in this session',
        })
      );
      expect(result.current.toasts).toContainEqual(
        expect.objectContaining({
          sessionId: 'ship-retriable-auto',
          variant: 'info',
          title: 'Auto-ship: #31 will retry later',
          description:
            'A transient merge conflict occurred. The issue remains eligible in this session.',
        })
      );
      expect(shipper.api.spawnBackgroundShip).toHaveBeenCalledWith(31, 'owner/repo', false, 'auto');
    });
  });

  it('falls back to the existing failure UX when auto-ship is disabled before a retriable failure completes', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    const { result } = renderHook(() =>
      useBackgroundCommands({
        activeRepo: 'owner/repo',
        autoMergeRepos: new Set(),
        checkInitState: vi.fn(() => Promise.resolve(undefined)),
        pipelineBridgeRef: { current: createPipelineBridge() },
      })
    );
    await flushHookEffects();

    act(() => {
      result.current.enableAutoShipForRepo('owner/repo');
      result.current.clearAutoShipStateForRepo('owner/repo');
    });

    shipper.emitBackgroundStatus({
      sessionId: 'ship-retriable-auto-disabled',
      command: 'ship',
      repo: 'owner/repo',
      status: 'failed',
      exitCode: 76,
      meta: { issueNumber: 31, merge: false, origin: 'auto', retriable: true },
    });
    await flushHookEffects();

    expect(result.current.backgroundCommands).toContainEqual(
      expect.objectContaining({
        id: 'ship-retriable-auto-disabled',
        retriable: true,
        detail: 'Command failed',
      })
    );
    expect(result.current.toasts).toContainEqual(
      expect.objectContaining({
        sessionId: 'ship-retriable-auto-disabled',
        variant: 'error',
        title: 'Ship #31 failed',
      })
    );
  });

  it('auto-unblocks blocked work and pauses auto-ship after repeated failures', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    vi.mocked(shipper.api.listIssues).mockResolvedValue({
      ok: true,
      issues: [createIssue(41, [PLANNED_LABEL, BLOCKED_LABEL])],
    });
    const pipelineBridge = createPipelineBridge();
    const { result } = renderHook(() =>
      useBackgroundCommands({
        activeRepo: 'owner/repo',
        autoMergeRepos: new Set(),
        checkInitState: vi.fn(() => Promise.resolve(undefined)),
        pipelineBridgeRef: { current: pipelineBridge },
      })
    );
    await flushHookEffects();

    act(() => {
      result.current.enableAutoShipForRepo('owner/repo');
    });
    shipper.emitBackgroundStatus({
      sessionId: 'ship-4',
      command: 'ship',
      repo: 'owner/repo',
      status: 'complete',
      meta: { issueNumber: 40, merge: false },
    });
    await flushHookEffects();

    await waitFor(() => {
      expect(shipper.api.spawnBackgroundUnblock).toHaveBeenCalledWith(41, 'owner/repo');
      expect(pipelineBridge.trackUnblockIssue).toHaveBeenCalledWith(41);
    });

    vi.mocked(shipper.api.listIssues).mockResolvedValue({ ok: true, issues: [] });
    for (let index = 0; index < MAX_AUTO_SHIP_CONSECUTIVE_FAILURES; index += 1) {
      shipper.emitBackgroundStatus({
        sessionId: `ship-fail-${index}`,
        command: 'ship',
        repo: 'owner/repo',
        status: 'failed',
        exitCode: 1,
        meta: { issueNumber: 50 + index, merge: false },
      });
      await flushHookEffects();
    }

    await waitFor(() => {
      expect(result.current.autoShipRepos.has('owner/repo')).toBe(false);
      expect(result.current.toasts).toContainEqual(
        expect.objectContaining({ title: 'Auto-ship paused' })
      );
    });
  });

  it('treats retriable failures as neutral between non-retriable failures for pause counting', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    vi.mocked(shipper.api.listIssues).mockResolvedValue({ ok: true, issues: [] });
    const { result } = renderHook(() =>
      useBackgroundCommands({
        activeRepo: 'owner/repo',
        autoMergeRepos: new Set(),
        checkInitState: vi.fn(() => Promise.resolve(undefined)),
        pipelineBridgeRef: { current: createPipelineBridge() },
      })
    );
    await flushHookEffects();

    act(() => {
      result.current.enableAutoShipForRepo('owner/repo');
    });

    shipper.emitBackgroundStatus({
      sessionId: 'ship-fail-1',
      command: 'ship',
      repo: 'owner/repo',
      status: 'failed',
      exitCode: 1,
      meta: { issueNumber: 51, merge: false, origin: 'auto' },
    });
    shipper.emitBackgroundStatus({
      sessionId: 'ship-fail-2',
      command: 'ship',
      repo: 'owner/repo',
      status: 'failed',
      exitCode: 1,
      meta: { issueNumber: 52, merge: false, origin: 'auto' },
    });
    shipper.emitBackgroundStatus({
      sessionId: 'ship-fail-retriable',
      command: 'ship',
      repo: 'owner/repo',
      status: 'failed',
      exitCode: 76,
      meta: { issueNumber: 53, merge: false, origin: 'auto', retriable: true },
    });
    await flushHookEffects();

    expect(result.current.autoShipRepos.has('owner/repo')).toBe(true);

    shipper.emitBackgroundStatus({
      sessionId: 'ship-fail-3',
      command: 'ship',
      repo: 'owner/repo',
      status: 'failed',
      exitCode: 1,
      meta: { issueNumber: 54, merge: false, origin: 'auto' },
    });
    await flushHookEffects();

    await waitFor(() => {
      expect(result.current.autoShipRepos.has('owner/repo')).toBe(false);
      expect(result.current.toasts).toContainEqual(
        expect.objectContaining({ title: 'Auto-ship paused' })
      );
    });
  });

  it('resets the consecutive-failure pause counter after a successful auto-ship', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    vi.mocked(shipper.api.listIssues).mockResolvedValue({ ok: true, issues: [] });
    const { result } = renderHook(() =>
      useBackgroundCommands({
        activeRepo: 'owner/repo',
        autoMergeRepos: new Set(),
        checkInitState: vi.fn(() => Promise.resolve(undefined)),
        pipelineBridgeRef: { current: createPipelineBridge() },
      })
    );
    await flushHookEffects();

    act(() => {
      result.current.enableAutoShipForRepo('owner/repo');
    });

    shipper.emitBackgroundStatus({
      sessionId: 'ship-reset-fail-1',
      command: 'ship',
      repo: 'owner/repo',
      status: 'failed',
      exitCode: 1,
      meta: { issueNumber: 61, merge: false, origin: 'auto' },
    });
    shipper.emitBackgroundStatus({
      sessionId: 'ship-reset-fail-2',
      command: 'ship',
      repo: 'owner/repo',
      status: 'failed',
      exitCode: 1,
      meta: { issueNumber: 62, merge: false, origin: 'auto' },
    });
    shipper.emitBackgroundStatus({
      sessionId: 'ship-reset-success',
      command: 'ship',
      repo: 'owner/repo',
      status: 'complete',
      meta: { issueNumber: 63, merge: false, origin: 'auto' },
    });
    shipper.emitBackgroundStatus({
      sessionId: 'ship-reset-fail-3',
      command: 'ship',
      repo: 'owner/repo',
      status: 'failed',
      exitCode: 1,
      meta: { issueNumber: 64, merge: false, origin: 'auto' },
    });
    await flushHookEffects();

    expect(result.current.autoShipRepos.has('owner/repo')).toBe(true);
    expect(result.current.toasts).not.toContainEqual(
      expect.objectContaining({ title: 'Auto-ship paused' })
    );
  });

  it('starts auto-unblock from the highest-priority blocked workflow stage', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    vi.mocked(shipper.api.listIssues).mockResolvedValue({
      ok: true,
      issues: [
        createIssue(42, [PLANNED_LABEL, BLOCKED_LABEL]),
        createIssue(43, [READY_LABEL, BLOCKED_LABEL]),
      ],
    });
    const pipelineBridge = createPipelineBridge();
    const { result } = renderHook(() =>
      useBackgroundCommands({
        activeRepo: 'owner/repo',
        autoMergeRepos: new Set(),
        checkInitState: vi.fn(() => Promise.resolve(undefined)),
        pipelineBridgeRef: { current: pipelineBridge },
      })
    );
    await flushHookEffects();

    act(() => {
      result.current.enableAutoShipForRepo('owner/repo');
    });
    shipper.emitBackgroundStatus({
      sessionId: 'ship-priority-unblock',
      command: 'ship',
      repo: 'owner/repo',
      status: 'complete',
      meta: { issueNumber: 41, merge: false },
    });
    await flushHookEffects();

    await waitFor(() => {
      expect(shipper.api.spawnBackgroundUnblock).toHaveBeenCalledWith(43, 'owner/repo');
      expect(pipelineBridge.trackUnblockIssue).toHaveBeenCalledWith(43);
      expect(result.current.toasts).toContainEqual(
        expect.objectContaining({
          title: 'Auto-ship: attempting unblock of #43',
        })
      );
    });
  });

  it('self-heals a stale locked initial auto-unblock candidate without extra UI', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    vi.mocked(shipper.api.listIssues).mockResolvedValue({
      ok: true,
      issues: [
        createIssue(44, [PLANNED_LABEL, BLOCKED_LABEL]),
        createIssue(45, [READY_LABEL, BLOCKED_LABEL, LOCKED_LABEL]),
      ],
    });
    vi.mocked(shipper.api.checkLockStale).mockResolvedValueOnce({ stale: true });
    const pipelineBridge = createPipelineBridge();
    const { result } = renderHook(() =>
      useBackgroundCommands({
        activeRepo: 'owner/repo',
        autoMergeRepos: new Set(),
        checkInitState: vi.fn(() => Promise.resolve(undefined)),
        pipelineBridgeRef: { current: pipelineBridge },
      })
    );
    await flushHookEffects();

    act(() => {
      result.current.enableAutoShipForRepo('owner/repo');
    });
    shipper.emitBackgroundStatus({
      sessionId: 'ship-stale-unblock',
      command: 'ship',
      repo: 'owner/repo',
      status: 'complete',
      meta: { issueNumber: 43, merge: false },
    });
    await flushHookEffects();

    await waitFor(() => {
      expect(shipper.api.checkLockStale).toHaveBeenCalledWith('owner/repo', 45);
      expect(shipper.api.unlockIssue).toHaveBeenCalledWith('owner/repo', 45);
      expect(shipper.api.spawnBackgroundUnblock).toHaveBeenCalledWith(45, 'owner/repo');
      expect(pipelineBridge.trackUnblockIssue).toHaveBeenCalledWith(45);
    });

    const unblockToasts = result.current.toasts.filter((toast) =>
      toast.title.startsWith('Auto-ship: attempting unblock of #')
    );
    expect(unblockToasts).toEqual([
      expect.objectContaining({
        title: 'Auto-ship: attempting unblock of #45',
      }),
    ]);
  });

  it('skips active locked initial auto-unblock candidates and picks the next eligible issue', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    vi.mocked(shipper.api.listIssues).mockResolvedValue({
      ok: true,
      issues: [
        createIssue(46, [PLANNED_LABEL, BLOCKED_LABEL]),
        createIssue(47, [READY_LABEL, BLOCKED_LABEL, LOCKED_LABEL]),
      ],
    });
    vi.mocked(shipper.api.checkLockStale).mockResolvedValueOnce({ stale: false });
    const pipelineBridge = createPipelineBridge();
    const { result } = renderHook(() =>
      useBackgroundCommands({
        activeRepo: 'owner/repo',
        autoMergeRepos: new Set(),
        checkInitState: vi.fn(() => Promise.resolve(undefined)),
        pipelineBridgeRef: { current: pipelineBridge },
      })
    );
    await flushHookEffects();

    act(() => {
      result.current.enableAutoShipForRepo('owner/repo');
    });
    shipper.emitBackgroundStatus({
      sessionId: 'ship-active-unblock',
      command: 'ship',
      repo: 'owner/repo',
      status: 'complete',
      meta: { issueNumber: 45, merge: false },
    });
    await flushHookEffects();

    await waitFor(() => {
      expect(shipper.api.checkLockStale).toHaveBeenCalledWith('owner/repo', 47);
      expect(shipper.api.unlockIssue).not.toHaveBeenCalledWith('owner/repo', 47);
      expect(shipper.api.spawnBackgroundUnblock).toHaveBeenCalledWith(46, 'owner/repo');
      expect(pipelineBridge.trackUnblockIssue).toHaveBeenCalledWith(46);
      expect(result.current.toasts).toContainEqual(
        expect.objectContaining({
          title: 'Auto-ship: attempting unblock of #46',
        })
      );
    });
  });

  it('marks auto-unblock retry ship launches as auto-origin', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    vi.mocked(shipper.api.listIssues)
      .mockResolvedValueOnce({
        ok: true,
        issues: [createIssue(42, [PLANNED_LABEL, BLOCKED_LABEL])],
      })
      .mockResolvedValueOnce({
        ok: true,
        issues: [createIssue(42)],
      });
    const pipelineBridge = createPipelineBridge();
    const { result } = renderHook(() =>
      useBackgroundCommands({
        activeRepo: 'owner/repo',
        autoMergeRepos: new Set(['owner/repo']),
        checkInitState: vi.fn(() => Promise.resolve(undefined)),
        pipelineBridgeRef: { current: pipelineBridge },
      })
    );
    await flushHookEffects();

    act(() => {
      result.current.enableAutoShipForRepo('owner/repo');
    });

    shipper.emitBackgroundStatus({
      sessionId: 'ship-before-unblock',
      command: 'ship',
      repo: 'owner/repo',
      status: 'complete',
      meta: { issueNumber: 41, merge: true },
    });
    await flushHookEffects();

    await waitFor(() => {
      expect(shipper.api.spawnBackgroundUnblock).toHaveBeenCalledWith(42, 'owner/repo');
    });

    shipper.emitBackgroundStatus({
      sessionId: 'unblock-1',
      command: 'unblock',
      repo: 'owner/repo',
      status: 'failed',
      exitCode: 1,
      meta: { issueNumber: 42 },
    });
    await flushHookEffects();

    await waitFor(() => {
      expect(shipper.api.spawnBackgroundShip).toHaveBeenCalledWith(42, 'owner/repo', true, 'auto');
    });
  });

  it('persists idle pause immediately and clears pause on resume', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    const pipelineBridge = createPipelineBridge();
    const { result } = renderHook(() =>
      useBackgroundCommands({
        activeRepo: 'owner/repo',
        autoMergeRepos: new Set(),
        checkInitState: vi.fn(() => Promise.resolve(undefined)),
        pipelineBridgeRef: { current: pipelineBridge },
      })
    );
    await flushHookEffects();

    await act(async () => {
      await result.current.handlePauseIssue(createIssue(70));
    });

    expect(shipper.api.pauseIssue).toHaveBeenCalledWith('owner/repo', 70);
    expect(pipelineBridge.trackPausedIssue).toHaveBeenCalledWith(70);

    await act(async () => {
      await result.current.handleResumeIssue(70);
    });

    expect(shipper.api.resumeIssue).toHaveBeenCalledWith('owner/repo', 70);
    expect(pipelineBridge.clearPausedIssue).toHaveBeenCalledWith(70);
  });

  it('removes queued ship sessions and persists pause immediately', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    const { result } = renderHook(() =>
      useBackgroundCommands({
        activeRepo: 'owner/repo',
        autoMergeRepos: new Set(),
        checkInitState: vi.fn(() => Promise.resolve(undefined)),
        pipelineBridgeRef: { current: createPipelineBridge() },
      })
    );
    await flushHookEffects();

    shipper.emitBackgroundStatus({
      sessionId: 'ship-queued',
      command: 'ship',
      repo: 'owner/repo',
      status: 'queued',
      meta: { issueNumber: 71, merge: false },
    });
    await flushHookEffects();

    await act(async () => {
      await result.current.handlePauseIssue(createIssue(71));
    });

    expect(shipper.api.removeQueuedSession).toHaveBeenCalledWith('ship-queued');
    expect(shipper.api.pauseIssue).toHaveBeenCalledWith('owner/repo', 71);
  });

  it('treats a queued pause request that already advanced to running as pause-pending', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    vi.mocked(shipper.api.removeQueuedSession).mockResolvedValue('pause-requested');
    const pipelineBridge = createPipelineBridge();
    const { result } = renderHook(() =>
      useBackgroundCommands({
        activeRepo: 'owner/repo',
        autoMergeRepos: new Set(),
        checkInitState: vi.fn(() => Promise.resolve(undefined)),
        pipelineBridgeRef: { current: pipelineBridge },
      })
    );
    await flushHookEffects();

    shipper.emitBackgroundStatus({
      sessionId: 'ship-queued',
      command: 'ship',
      repo: 'owner/repo',
      status: 'queued',
      meta: { issueNumber: 71, merge: false },
    });
    await flushHookEffects();

    await act(async () => {
      await result.current.handlePauseIssue(createIssue(71));
    });

    expect(result.current.pausePendingIssues.has(71)).toBe(true);
    expect(shipper.api.pauseIssue).not.toHaveBeenCalledWith('owner/repo', 71);
    expect(pipelineBridge.trackPausedIssue).not.toHaveBeenCalledWith(71);
  });

  it('requests pause for active ships, tracks pausePending, persists on paused exit, and continues auto-ship', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    const pipelineBridge = createPipelineBridge();
    vi.mocked(pipelineBridge.getPausedIssues).mockReturnValue(new Set([72]));
    vi.mocked(shipper.api.listIssues).mockResolvedValue({
      ok: true,
      issues: [createIssue(72), createIssue(73)],
    });
    const { result } = renderHook(() =>
      useBackgroundCommands({
        activeRepo: 'owner/repo',
        autoMergeRepos: new Set(['owner/repo']),
        checkInitState: vi.fn(() => Promise.resolve(undefined)),
        pipelineBridgeRef: { current: pipelineBridge },
      })
    );
    await flushHookEffects();

    act(() => {
      result.current.enableAutoShipForRepo('owner/repo');
    });
    shipper.emitBackgroundStatus({
      sessionId: 'ship-active',
      command: 'ship',
      repo: 'owner/repo',
      status: 'running',
      meta: { issueNumber: 72, merge: false },
    });
    await flushHookEffects();

    await act(async () => {
      await result.current.handlePauseIssue(createIssue(72));
    });

    expect(shipper.api.requestPauseActive).toHaveBeenCalledWith('ship-active');
    expect(result.current.pausePendingIssues.has(72)).toBe(true);

    shipper.emitBackgroundStatus({
      sessionId: 'ship-active',
      command: 'ship',
      repo: 'owner/repo',
      status: 'running',
      meta: { issueNumber: 72, merge: false, pausePending: true },
    });
    await flushHookEffects();
    expect(result.current.pausePendingIssues.has(72)).toBe(true);

    shipper.emitBackgroundStatus({
      sessionId: 'ship-active',
      command: 'ship',
      repo: 'owner/repo',
      status: 'paused',
      meta: { issueNumber: 72, merge: false },
    });
    await flushHookEffects();

    await waitFor(() => {
      expect(shipper.api.pauseIssue).toHaveBeenCalledWith('owner/repo', 72);
      expect(pipelineBridge.trackPausedIssue).toHaveBeenCalledWith(72);
      expect(result.current.pausePendingIssues.has(72)).toBe(false);
      expect(shipper.api.spawnBackgroundShip).toHaveBeenCalledWith(73, 'owner/repo', true, 'auto');
    });
  });

  it('discards a pending pause when the active ship fails', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    const { result } = renderHook(() =>
      useBackgroundCommands({
        activeRepo: 'owner/repo',
        autoMergeRepos: new Set(),
        checkInitState: vi.fn(() => Promise.resolve(undefined)),
        pipelineBridgeRef: { current: createPipelineBridge() },
      })
    );
    await flushHookEffects();

    shipper.emitBackgroundStatus({
      sessionId: 'ship-failing',
      command: 'ship',
      repo: 'owner/repo',
      status: 'running',
      meta: { issueNumber: 74, merge: false },
    });
    await flushHookEffects();

    await act(async () => {
      await result.current.handlePauseIssue(createIssue(74));
    });
    shipper.emitBackgroundStatus({
      sessionId: 'ship-failing',
      command: 'ship',
      repo: 'owner/repo',
      status: 'failed',
      exitCode: 1,
      meta: { issueNumber: 74, merge: false },
    });
    await flushHookEffects();

    expect(result.current.pausePendingIssues.has(74)).toBe(false);
    expect(shipper.api.pauseIssue).not.toHaveBeenCalledWith('owner/repo', 74);
  });

  it('clears pause-pending state when a paused ship completes instead of pausing', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    const { result } = renderHook(() =>
      useBackgroundCommands({
        activeRepo: 'owner/repo',
        autoMergeRepos: new Set(),
        checkInitState: vi.fn(() => Promise.resolve(undefined)),
        pipelineBridgeRef: { current: createPipelineBridge() },
      })
    );
    await flushHookEffects();

    shipper.emitBackgroundStatus({
      sessionId: 'ship-completing',
      command: 'ship',
      repo: 'owner/repo',
      status: 'running',
      meta: { issueNumber: 76, merge: false, pausePending: true },
    });
    await flushHookEffects();
    expect(result.current.pausePendingIssues.has(76)).toBe(true);

    shipper.emitBackgroundStatus({
      sessionId: 'ship-completing',
      command: 'ship',
      repo: 'owner/repo',
      status: 'complete',
      meta: { issueNumber: 76, merge: false },
    });
    await flushHookEffects();

    expect(result.current.pausePendingIssues.has(76)).toBe(false);
  });

  it('keeps pause-pending state scoped to the active repository', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    const { result } = renderHook(() =>
      useBackgroundCommands({
        activeRepo: 'owner/repo',
        autoMergeRepos: new Set(),
        checkInitState: vi.fn(() => Promise.resolve(undefined)),
        pipelineBridgeRef: { current: createPipelineBridge() },
      })
    );
    await flushHookEffects();

    shipper.emitBackgroundStatus({
      sessionId: 'ship-other-repo',
      command: 'ship',
      repo: 'other/repo',
      status: 'running',
      meta: { issueNumber: 123, merge: false, pausePending: true },
    });
    await flushHookEffects();

    expect(result.current.pausePendingIssues.has(123)).toBe(false);
  });

  it('uses paused issues from the event repo when auto-ship selects the next issue', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    vi.mocked(shipper.api.listIssues).mockResolvedValue({
      ok: true,
      issues: [createIssue(81), createIssue(82)],
    });
    vi.mocked(shipper.api.listPausedIssues).mockImplementation((repo: string) =>
      Promise.resolve(repo === 'other/repo' ? [81] : [])
    );
    const pipelineBridge = createPipelineBridge();
    vi.mocked(pipelineBridge.getPausedIssues).mockReturnValue(new Set([82]));
    const { result } = renderHook(() =>
      useBackgroundCommands({
        activeRepo: 'owner/repo',
        autoMergeRepos: new Set(['other/repo']),
        checkInitState: vi.fn(() => Promise.resolve(undefined)),
        pipelineBridgeRef: { current: pipelineBridge },
      })
    );
    await flushHookEffects();

    act(() => {
      result.current.enableAutoShipForRepo('other/repo');
    });

    shipper.emitBackgroundStatus({
      sessionId: 'ship-other-complete',
      command: 'ship',
      repo: 'other/repo',
      status: 'complete',
      meta: { issueNumber: 80, merge: true },
    });
    await flushHookEffects();

    await waitFor(() => {
      expect(shipper.api.listPausedIssues).toHaveBeenCalledWith('other/repo');
      expect(shipper.api.spawnBackgroundShip).toHaveBeenCalledWith(82, 'other/repo', true, 'auto');
    });
  });

  it('refreshes quietly for auto-ship halts without success toast or paused persistence', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    const pipelineBridge = createPipelineBridge();
    const { result } = renderHook(() =>
      useBackgroundCommands({
        activeRepo: 'owner/repo',
        autoMergeRepos: new Set(),
        checkInitState: vi.fn(() => Promise.resolve(undefined)),
        pipelineBridgeRef: { current: pipelineBridge },
      })
    );
    await flushHookEffects();

    shipper.emitBackgroundStatus({
      sessionId: 'ship-auto-halt',
      command: 'ship',
      repo: 'owner/repo',
      status: 'complete',
      exitCode: 75,
      meta: { issueNumber: 83, merge: false, autoShipHalted: true, origin: 'auto' },
    });
    await flushHookEffects();

    await waitFor(() => {
      expect(pipelineBridge.loadIssues).toHaveBeenCalledWith('owner/repo');
    });
    expect(shipper.api.pauseIssue).not.toHaveBeenCalledWith('owner/repo', 83);
    expect(pipelineBridge.trackPausedIssue).not.toHaveBeenCalledWith(83);
    expect(
      result.current.toasts.some(
        (toast) => toast.sessionId === 'ship-auto-halt' && toast.variant === 'success'
      )
    ).toBe(false);
  });

  it('keeps manual retriable ship failures on the existing error UX', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    const { result } = renderHook(() =>
      useBackgroundCommands({
        activeRepo: 'owner/repo',
        autoMergeRepos: new Set(),
        checkInitState: vi.fn(() => Promise.resolve(undefined)),
        pipelineBridgeRef: { current: createPipelineBridge() },
      })
    );
    await flushHookEffects();

    shipper.emitBackgroundStatus({
      sessionId: 'ship-retriable-manual',
      command: 'ship',
      repo: 'owner/repo',
      status: 'failed',
      exitCode: 76,
      meta: { issueNumber: 84, merge: false, origin: 'manual', retriable: true },
    });
    await flushHookEffects();

    expect(result.current.backgroundCommands).toContainEqual(
      expect.objectContaining({
        id: 'ship-retriable-manual',
        retriable: true,
        detail: 'Command failed',
      })
    );
    expect(result.current.toasts).toContainEqual(
      expect.objectContaining({
        sessionId: 'ship-retriable-manual',
        variant: 'error',
        title: 'Ship #84 failed',
      })
    );
  });

  it('omits the issue number in retry-later toast titles when a retriable auto-ship failure lacks one', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    const { result } = renderHook(() =>
      useBackgroundCommands({
        activeRepo: 'owner/repo',
        autoMergeRepos: new Set(),
        checkInitState: vi.fn(() => Promise.resolve(undefined)),
        pipelineBridgeRef: { current: createPipelineBridge() },
      })
    );
    await flushHookEffects();

    act(() => {
      result.current.enableAutoShipForRepo('owner/repo');
    });

    shipper.emitBackgroundStatus({
      sessionId: 'ship-retriable-no-issue',
      command: 'ship',
      repo: 'owner/repo',
      status: 'failed',
      exitCode: 76,
      meta: { merge: false, origin: 'auto', retriable: true },
    });
    await flushHookEffects();

    expect(result.current.toasts).toContainEqual(
      expect.objectContaining({
        sessionId: 'ship-retriable-no-issue',
        variant: 'info',
        title: 'Auto-ship will retry later',
      })
    );
  });

  it('surfaces resume failures without clearing paused state optimistically', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    vi.mocked(shipper.api.resumeIssue).mockRejectedValue(new Error('resume failed'));
    const pipelineBridge = createPipelineBridge();
    const { result } = renderHook(() =>
      useBackgroundCommands({
        activeRepo: 'owner/repo',
        autoMergeRepos: new Set(),
        checkInitState: vi.fn(() => Promise.resolve(undefined)),
        pipelineBridgeRef: { current: pipelineBridge },
      })
    );
    await flushHookEffects();

    await act(async () => {
      await result.current.handleResumeIssue(77);
    });

    expect(pipelineBridge.clearPausedIssue).not.toHaveBeenCalledWith(77);
    expect(result.current.toasts).toContainEqual(
      expect.objectContaining({
        title: 'Could not resume #77',
        description: 'resume failed',
      })
    );
  });

  it('catches paused-state persistence failures from background events', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    vi.mocked(shipper.api.pauseIssue).mockRejectedValue(new Error('disk full'));
    const pipelineBridge = createPipelineBridge();
    const { result } = renderHook(() =>
      useBackgroundCommands({
        activeRepo: 'owner/repo',
        autoMergeRepos: new Set(),
        checkInitState: vi.fn(() => Promise.resolve(undefined)),
        pipelineBridgeRef: { current: pipelineBridge },
      })
    );
    await flushHookEffects();

    shipper.emitBackgroundStatus({
      sessionId: 'ship-paused',
      command: 'ship',
      repo: 'owner/repo',
      status: 'paused',
      meta: { issueNumber: 78, merge: false },
    });
    await flushHookEffects();

    await waitFor(() => {
      expect(result.current.toasts).toContainEqual(
        expect.objectContaining({
          title: 'Failed to pause #78',
          description: 'disk full',
        })
      );
    });
    expect(pipelineBridge.trackPausedIssue).not.toHaveBeenCalledWith(78);
  });

  it('shows the final-stage pause no-op message instead of persisting pause', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    const pipelineBridge = createPipelineBridge();
    vi.mocked(pipelineBridge.getIssueByNumber).mockReturnValue(
      createIssue(75, [PR_REVIEWED_LABEL])
    );
    const { result } = renderHook(() =>
      useBackgroundCommands({
        activeRepo: 'owner/repo',
        autoMergeRepos: new Set(),
        checkInitState: vi.fn(() => Promise.resolve(undefined)),
        pipelineBridgeRef: { current: pipelineBridge },
      })
    );
    await flushHookEffects();

    shipper.emitBackgroundStatus({
      sessionId: 'ship-final',
      command: 'ship',
      repo: 'owner/repo',
      status: 'running',
      meta: { issueNumber: 75, merge: false },
    });
    await flushHookEffects();

    await act(async () => {
      await result.current.handlePauseIssue(createIssue(75, [PR_REVIEWED_LABEL]));
    });

    expect(shipper.api.requestPauseActive).not.toHaveBeenCalled();
    expect(shipper.api.pauseIssue).not.toHaveBeenCalled();
    expect(result.current.toasts).toContainEqual(
      expect.objectContaining({
        title: '#75 is at the final stage',
      })
    );
  });
});
