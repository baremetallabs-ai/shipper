// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BLOCKED_LABEL, PLANNED_LABEL } from '../../../core/src/lib/labels.js';
import type { IssuePipelineBridge, IssueListResult } from '../../src/renderer/types.js';
import { useBackgroundCommands } from '../../src/renderer/hooks/use-background-commands.js';
import { createMockShipperApi, flushHookEffects } from './test-utils.js';
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
      meta: { issueNumber: 22, merge: true },
    });

    await act(async () => {
      await result.current.handleRetryToast('ship-2');
    });

    expect(shipper.api.spawnBackgroundShip).toHaveBeenCalledWith(22, 'owner/repo', true);
    expect(result.current.toasts).toHaveLength(0);
    expect(result.current.backgroundCommands).toHaveLength(0);
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
      expect(shipper.api.spawnBackgroundShip).toHaveBeenCalledWith(31, 'owner/repo', true);
      expect(result.current.toasts).toContainEqual(
        expect.objectContaining({
          title: 'Auto-ship: starting #31',
        })
      );
    });
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
});
