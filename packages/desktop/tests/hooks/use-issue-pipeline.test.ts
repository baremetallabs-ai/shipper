// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BLOCKED_LABEL,
  FAILED_LABEL,
  LOCKED_LABEL,
  NEW_LABEL,
  PLANNED_LABEL,
} from '@dnsquared/shipper-core';
import { useIssuePipeline } from '../../src/renderer/hooks/use-issue-pipeline.js';
import {
  advanceHookTimers,
  createMockShipperApi,
  setupHookTestTimers,
  teardownHookTestTimers,
} from './test-utils.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

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

describe('useIssuePipeline', () => {
  beforeEach(() => {
    setupHookTestTimers();
  });

  afterEach(() => {
    teardownHookTestTimers();
    vi.restoreAllMocks();
  });

  it('loads issues successfully, stores errors, and ignores stale requests', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    const firstRequest = createDeferred<{ ok: true; issues: ReturnType<typeof createIssue>[] }>();
    vi.mocked(shipper.api.listIssues)
      .mockImplementationOnce(() => firstRequest.promise)
      .mockResolvedValueOnce({ ok: true, issues: [createIssue(2)] })
      .mockResolvedValueOnce({ ok: false, error: 'boom' });
    const pushToast = vi.fn();
    const { result } = renderHook(() =>
      useIssuePipeline({
        activeRepo: 'owner/repo',
        canFetch: true,
        hasActiveRepo: true,
        hasRunningShipCommand: false,
        pushToast,
      })
    );

    let first: Promise<unknown> | undefined;
    await act(async () => {
      first = result.current.loadIssues('owner/repo');
      await Promise.resolve();
    });
    await act(async () => {
      await result.current.loadIssues('owner/repo');
    });
    firstRequest.resolve({ ok: true, issues: [createIssue(1)] });
    await act(async () => {
      await first;
    });

    expect(result.current.issues.map((issue) => issue.number)).toEqual([2]);

    await act(async () => {
      await result.current.loadIssues('owner/repo');
    });

    expect(result.current.fetchError).toBe('boom');
    expect(pushToast).not.toHaveBeenCalled();
  });

  it('tracks busy sets, dialog state, and refresh polling intervals', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    const pushToast = vi.fn();
    const { result, rerender } = renderHook(
      ({ hasRunningShipCommand }: { hasRunningShipCommand: boolean }) =>
        useIssuePipeline({
          activeRepo: 'owner/repo',
          canFetch: true,
          hasActiveRepo: true,
          hasRunningShipCommand,
          pushToast,
        }),
      { initialProps: { hasRunningShipCommand: false } }
    );

    act(() => {
      result.current.trackResetIssue(1);
      result.current.trackUnblockIssue(2);
      result.current.handleOpenNewIssue();
      result.current.handleOpenAdopt();
    });

    expect(result.current.resettingIssues.has(1)).toBe(true);
    expect(result.current.unblockingIssues.has(2)).toBe(true);
    expect(result.current.isNewIssueOpen).toBe(true);
    expect(result.current.isAdoptOpen).toBe(true);

    await advanceHookTimers(60_000);
    expect(shipper.api.listIssues).toHaveBeenCalledTimes(1);

    rerender({ hasRunningShipCommand: true });
    await advanceHookTimers(60_000);
    expect(shipper.api.listIssues).toHaveBeenCalledTimes(7);
  });

  it('handles unlock flows, including stale locks and confirmation-required locks', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    vi.mocked(shipper.api.listIssues).mockResolvedValue({ ok: true, issues: [createIssue(4)] });
    const pushToast = vi.fn();
    const { result } = renderHook(() =>
      useIssuePipeline({
        activeRepo: 'owner/repo',
        canFetch: true,
        hasActiveRepo: true,
        hasRunningShipCommand: false,
        pushToast,
      })
    );

    vi.mocked(shipper.api.checkLockStale).mockResolvedValueOnce({ stale: false });
    await act(async () => {
      await result.current.handleUnlockClick(createIssue(4, [PLANNED_LABEL, LOCKED_LABEL]));
    });

    expect(result.current.unlockConfirmIssue?.number).toBe(4);

    vi.mocked(shipper.api.checkLockStale).mockResolvedValueOnce({ stale: true });
    vi.mocked(shipper.api.unlockIssue).mockResolvedValueOnce({ ok: true });
    await act(async () => {
      await result.current.handleUnlockClick(createIssue(5, [PLANNED_LABEL, LOCKED_LABEL]));
    });

    expect(shipper.api.unlockIssue).toHaveBeenCalledWith('owner/repo', 5);
    expect(pushToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Issue unlocked', description: '#5 lock removed.' })
    );
  });

  it('handles unblock and priority updates, including unblock spawn failures', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    vi.mocked(shipper.api.listIssues).mockResolvedValue({ ok: true, issues: [createIssue(9)] });
    const pushToast = vi.fn();
    const { result } = renderHook(() =>
      useIssuePipeline({
        activeRepo: 'owner/repo',
        canFetch: true,
        hasActiveRepo: true,
        hasRunningShipCommand: false,
        pushToast,
      })
    );

    vi.mocked(shipper.api.spawnBackgroundUnblock).mockRejectedValueOnce(new Error('cannot spawn'));
    await act(async () => {
      await result.current.handleUnblockClick(createIssue(9, [PLANNED_LABEL, BLOCKED_LABEL]));
    });

    expect(result.current.unblockingIssues.has(9)).toBe(false);
    expect(pushToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Failed to start unblock',
        description: 'cannot spawn',
      })
    );

    vi.mocked(shipper.api.setPriority).mockResolvedValueOnce({ ok: true });
    await act(async () => {
      await result.current.handleSetPriority(createIssue(9), 'high');
    });

    expect(shipper.api.setPriority).toHaveBeenCalledWith('owner/repo', 9, 'high');
    expect(pushToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Priority updated',
        description: '#9 set to high.',
      })
    );
  });

  it('buckets failed and new attention issues before stage columns', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    vi.mocked(shipper.api.listIssues).mockResolvedValue({
      ok: true,
      issues: [
        createIssue(1, [FAILED_LABEL]),
        createIssue(2, [NEW_LABEL]),
        createIssue(3, [FAILED_LABEL, BLOCKED_LABEL]),
        createIssue(4, [FAILED_LABEL, PLANNED_LABEL]),
        createIssue(5, [PLANNED_LABEL]),
      ],
    });
    const { result } = renderHook(() =>
      useIssuePipeline({
        activeRepo: 'owner/repo',
        canFetch: true,
        hasActiveRepo: true,
        hasRunningShipCommand: false,
        pushToast: vi.fn(),
      })
    );

    await act(async () => {
      await result.current.loadIssues('owner/repo');
    });

    expect(result.current.attentionIssues.failed.map((issue) => issue.number)).toEqual([1, 3, 4]);
    expect(result.current.attentionIssues.new.map((issue) => issue.number)).toEqual([2]);
    expect(result.current.columnMap.get(PLANNED_LABEL)?.map((issue) => issue.number)).toEqual([5]);
  });
});
