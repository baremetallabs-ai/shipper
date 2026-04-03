// @vitest-environment jsdom

import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  BackgroundCommandsBridge,
  IssuePipelineBridge,
  IssueListResult,
} from '../../src/renderer/types.js';
import { useRepos } from '../../src/renderer/hooks/use-repos.js';
import { createMockShipperApi } from './test-utils.js';

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

function createBackgroundBridge(): BackgroundCommandsBridge {
  return {
    clearAutoShipStateForRepo: vi.fn(),
  };
}

describe('useRepos', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads config and prerequisites on mount, then checks init state and loads issues', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    vi.mocked(shipper.api.getConfig).mockResolvedValue({
      repos: ['owner/repo'],
      activeRepo: 'owner/repo',
      autoMergeRepos: ['owner/repo'],
    });
    vi.mocked(shipper.api.checkInit).mockResolvedValue({ initialized: true });
    const pipelineBridge = createPipelineBridge();
    const backgroundBridge = createBackgroundBridge();

    const { result } = renderHook(() =>
      useRepos({
        pipelineBridgeRef: { current: pipelineBridge },
        backgroundBridgeRef: { current: backgroundBridge },
      })
    );
    await waitFor(() => {
      expect(result.current.repos).toEqual(['owner/repo']);
      expect(result.current.activeRepo).toBe('owner/repo');
      expect(result.current.autoMergeRepos.has('owner/repo')).toBe(true);
      expect(result.current.repoInitialized).toBe(true);
      expect(pipelineBridge.loadIssues).toHaveBeenCalledWith('owner/repo');
      expect(shipper.api.checkInit).toHaveBeenCalledWith('owner/repo');
    });
  });

  it('respects prerequisite failures and skips repo initialization work', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    vi.mocked(shipper.api.checkPrerequisites).mockResolvedValue({
      ghInstalled: { ok: true, message: '' },
      ghAuth: { ok: false, message: 'Run gh auth login' },
    });
    vi.mocked(shipper.api.getConfig).mockResolvedValue({
      repos: ['owner/repo'],
      activeRepo: 'owner/repo',
      autoMergeRepos: [],
    });
    const pipelineBridge = createPipelineBridge();

    const { result } = renderHook(() =>
      useRepos({
        pipelineBridgeRef: { current: pipelineBridge },
        backgroundBridgeRef: { current: createBackgroundBridge() },
      })
    );
    await waitFor(() => {
      expect(result.current.prerequisiteMessage).toBe('Run gh auth login');
      expect(result.current.canFetch).toBe(false);
      expect(shipper.api.checkInit).not.toHaveBeenCalled();
      expect(pipelineBridge.loadIssues).not.toHaveBeenCalled();
    });
  });

  it('adds repos through persisted config and issue bridge calls', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    vi.mocked(shipper.api.getConfig).mockResolvedValue({
      repos: ['owner/repo'],
      activeRepo: 'owner/repo',
      autoMergeRepos: [],
    });
    const pipelineBridge = createPipelineBridge();

    const { result } = renderHook(() =>
      useRepos({
        pipelineBridgeRef: { current: pipelineBridge },
        backgroundBridgeRef: { current: createBackgroundBridge() },
      })
    );
    await waitFor(() => {
      expect(result.current.repos).toEqual(['owner/repo']);
    });
    vi.clearAllMocks();

    await result.current.handleAddRepo('owner/next');
    await waitFor(() => {
      expect(shipper.api.setConfig).toHaveBeenCalledWith({
        repos: ['owner/repo', 'owner/next'],
        activeRepo: 'owner/next',
        autoMergeRepos: [],
      });
      expect(pipelineBridge.clearIssueState).toHaveBeenCalledTimes(1);
      expect(pipelineBridge.loadIssues).toHaveBeenCalledWith('owner/next');
    });
  });

  it('switches repos through persisted config and issue bridge calls', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    vi.mocked(shipper.api.getConfig).mockResolvedValue({
      repos: ['owner/repo', 'owner/next'],
      activeRepo: 'owner/next',
      autoMergeRepos: [],
    });
    const pipelineBridge = createPipelineBridge();

    const { result } = renderHook(() =>
      useRepos({
        pipelineBridgeRef: { current: pipelineBridge },
        backgroundBridgeRef: { current: createBackgroundBridge() },
      })
    );
    await waitFor(() => {
      expect(result.current.activeRepo).toBe('owner/next');
    });

    await result.current.handleSwitchRepo('owner/repo');
    await waitFor(() => {
      expect(shipper.api.setConfig).toHaveBeenCalledWith({
        repos: ['owner/repo', 'owner/next'],
        activeRepo: 'owner/repo',
        autoMergeRepos: [],
      });
      expect(pipelineBridge.clearIssueState).toHaveBeenCalledTimes(1);
      expect(pipelineBridge.loadIssues).toHaveBeenCalledWith('owner/repo');
    });
  });

  it('reorders repos through persisted config', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    vi.mocked(shipper.api.getConfig).mockResolvedValue({
      repos: ['owner/repo', 'owner/next'],
      activeRepo: 'owner/repo',
      autoMergeRepos: ['owner/repo'],
    });

    const { result } = renderHook(() =>
      useRepos({
        pipelineBridgeRef: { current: createPipelineBridge() },
        backgroundBridgeRef: { current: createBackgroundBridge() },
      })
    );
    await waitFor(() => {
      expect(result.current.repos).toEqual(['owner/repo', 'owner/next']);
    });

    await result.current.handleReorderRepos(['owner/next', 'owner/repo']);
    await waitFor(() => {
      expect(shipper.api.setConfig).toHaveBeenCalledWith({
        repos: ['owner/next', 'owner/repo'],
        activeRepo: 'owner/repo',
        autoMergeRepos: ['owner/repo'],
      });
    });
  });

  it('persists auto-merge changes and clears bridge state when closing a repo', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    vi.mocked(shipper.api.getConfig).mockResolvedValue({
      repos: ['owner/repo', 'owner/next'],
      activeRepo: 'owner/repo',
      autoMergeRepos: ['owner/repo'],
    });
    const pipelineBridge = createPipelineBridge();
    const backgroundBridge = createBackgroundBridge();

    const { result } = renderHook(() =>
      useRepos({
        pipelineBridgeRef: { current: pipelineBridge },
        backgroundBridgeRef: { current: backgroundBridge },
      })
    );
    await waitFor(() => {
      expect(result.current.repos).toEqual(['owner/repo', 'owner/next']);
    });

    vi.clearAllMocks();
    await result.current.handleToggleAutoMerge('owner/repo');
    await waitFor(() => {
      expect(shipper.api.setConfig).toHaveBeenCalledWith({
        repos: ['owner/repo', 'owner/next'],
        activeRepo: 'owner/repo',
        autoMergeRepos: [],
      });
    });

    vi.clearAllMocks();
    await result.current.handleCloseRepo('owner/next');
    await waitFor(() => {
      expect(backgroundBridge.clearAutoShipStateForRepo).toHaveBeenCalledWith('owner/next');
      expect(pipelineBridge.clearStageCacheForRepo).toHaveBeenCalledWith('owner/next');
      expect(pipelineBridge.clearIssueState).not.toHaveBeenCalled();
    });
  });
});
