// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTerminalSessions } from '../../src/renderer/hooks/use-terminal-sessions.js';
import {
  advanceHookTimers,
  createMockShipperApi,
  flushHookEffects,
  setupHookTestTimers,
  teardownHookTestTimers,
} from './test-utils.js';

describe('useTerminalSessions', () => {
  beforeEach(() => {
    setupHookTestTimers();
  });

  afterEach(() => {
    teardownHookTestTimers();
    vi.restoreAllMocks();
  });

  it('opens sessions, re-focuses existing groom sessions, and removes exited tabs', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    const setFetchError = vi.fn();
    const { result } = renderHook(() =>
      useTerminalSessions({ activeRepo: 'owner/repo', setFetchError })
    );

    act(() => {
      result.current.openRunningSession('pty-1', 'groom - #11', {
        repo: 'owner/repo',
        issueNumber: 11,
      });
      result.current.openRunningSession('pty-2', 'groom - #12', {
        repo: 'owner/repo',
        issueNumber: 12,
      });
      result.current.handleSelectSession('pty-1');
    });
    await flushHookEffects();

    expect(result.current.activeSessionId).toBe('pty-1');
    let focusedExisting = false;
    act(() => {
      focusedExisting = result.current.focusExistingGroomSession(12);
    });
    expect(focusedExisting).toBe(true);
    expect(result.current.activeSessionId).toBe('pty-2');

    shipper.emitPtyExit({ sessionId: 'pty-2', exitCode: 0 });
    act(() => {
      result.current.handleCloseSession('pty-2');
    });

    expect(result.current.sessions.map((session) => session.id)).toEqual(['pty-1']);
    expect(result.current.activeSessionId).toBe('pty-1');
  });

  it('marks idle running sessions as waiting and resumes them on PTY output', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    const { result } = renderHook(() =>
      useTerminalSessions({ activeRepo: 'owner/repo', setFetchError: vi.fn() })
    );

    act(() => {
      result.current.openRunningSession('pty-1', 'groom - #11', {
        repo: 'owner/repo',
        issueNumber: 11,
      });
    });

    await advanceHookTimers(6_000);
    expect(result.current.sessions[0]?.status).toBe('waiting');

    shipper.emitPtyOutput({ sessionId: 'pty-1', sequence: 1, data: 'still running\n' });
    expect(result.current.sessions[0]?.status).toBe('running');
  });

  it('kills live sessions on confirmation and reports PTY kill failures', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    const setFetchError = vi.fn();
    const { result } = renderHook(() =>
      useTerminalSessions({ activeRepo: 'owner/repo', setFetchError })
    );

    act(() => {
      result.current.openRunningSession('pty-1', 'groom - #11', {
        repo: 'owner/repo',
        issueNumber: 11,
      });
    });
    await flushHookEffects();

    act(() => {
      result.current.handleCloseSession('pty-1');
    });
    await flushHookEffects();

    await act(async () => {
      await result.current.handleConfirmCloseSession();
    });

    expect(shipper.api.ptyKill).toHaveBeenCalledWith('pty-1');
    expect(result.current.sessions).toHaveLength(0);

    act(() => {
      result.current.openRunningSession('pty-2', 'groom - #12', {
        repo: 'owner/repo',
        issueNumber: 12,
      });
    });
    await flushHookEffects();
    act(() => {
      result.current.handleCloseSession('pty-2');
    });
    await flushHookEffects();
    vi.mocked(shipper.api.ptyKill).mockRejectedValueOnce(new Error('permission denied'));

    await act(async () => {
      await result.current.handleConfirmCloseSession();
    });

    expect(setFetchError).toHaveBeenCalledWith(
      'Failed to close terminal session: permission denied'
    );
    expect(result.current.sessions.map((session) => session.id)).toEqual(['pty-2']);
  });

  it('toggles the drawer and clears pending-close state when the dialog closes', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    const { result } = renderHook(() =>
      useTerminalSessions({ activeRepo: 'owner/repo', setFetchError: vi.fn() })
    );

    act(() => {
      result.current.openRunningSession('pty-1', 'groom - #11', {
        repo: 'owner/repo',
        issueNumber: 11,
      });
    });
    await flushHookEffects();

    act(() => {
      result.current.handleToggleDrawer();
      result.current.handleCloseSession('pty-1');
    });

    expect(result.current.drawerOpen).toBe(false);
    await flushHookEffects();
    expect(result.current.pendingCloseSession?.id).toBe('pty-1');

    act(() => {
      result.current.handlePendingCloseOpenChange(false);
    });

    expect(result.current.pendingCloseSession).toBeNull();
  });
});
