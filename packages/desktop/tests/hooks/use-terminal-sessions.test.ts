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

    expect(result.current.sessions.map((session) => session.id)).toEqual(['pty-1']);
    expect(result.current.activeSessionId).toBe('pty-1');
  });

  it('re-focuses an existing running setup session for the active repo', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    const { result } = renderHook(() =>
      useTerminalSessions({ activeRepo: 'owner/repo', setFetchError: vi.fn() })
    );

    act(() => {
      result.current.openRunningSession('pty-setup-1', 'setup — owner/repo', {
        repo: 'owner/repo',
      });
      result.current.openRunningSession('pty-groom-1', 'groom — #11', {
        repo: 'owner/repo',
        issueNumber: 11,
      });
      result.current.handleSelectSession('pty-groom-1');
    });
    await flushHookEffects();

    let focusedExisting = false;
    act(() => {
      focusedExisting = result.current.focusExistingSetupSession('owner/repo');
    });

    expect(focusedExisting).toBe(true);
    expect(result.current.activeSessionId).toBe('pty-setup-1');
  });

  it('does not re-focus an exited setup session for the active repo', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    const { result } = renderHook(() =>
      useTerminalSessions({ activeRepo: 'owner/repo', setFetchError: vi.fn() })
    );

    act(() => {
      result.current.openRunningSession('pty-setup-1', 'setup — owner/repo', {
        repo: 'owner/repo',
      });
    });
    await flushHookEffects();

    shipper.emitPtyExit({ sessionId: 'pty-setup-1', exitCode: 1 });

    let focusedExited = true;
    act(() => {
      focusedExited = result.current.focusExistingSetupSession('owner/repo');
    });

    expect(focusedExited).toBe(false);
  });

  it('does not re-focus a setup session for a different repo', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    const { result } = renderHook(() =>
      useTerminalSessions({ activeRepo: 'owner/repo', setFetchError: vi.fn() })
    );

    act(() => {
      result.current.openRunningSession('pty-setup-2', 'setup — owner/other', {
        repo: 'owner/other',
      });
    });
    await flushHookEffects();

    let focusedOtherRepo = true;
    act(() => {
      focusedOtherRepo = result.current.focusExistingSetupSession('owner/repo');
    });

    expect(focusedOtherRepo).toBe(false);
  });

  it('does not treat groom sessions as setup sessions for the same repo', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    const { result } = renderHook(() =>
      useTerminalSessions({ activeRepo: 'owner/repo', setFetchError: vi.fn() })
    );

    act(() => {
      result.current.openRunningSession('pty-groom-1', 'groom — #11', {
        repo: 'owner/repo',
        issueNumber: 11,
      });
    });
    await flushHookEffects();

    let focusedGroomOnly = true;
    act(() => {
      focusedGroomOnly = result.current.focusExistingSetupSession('owner/repo');
    });

    expect(focusedGroomOnly).toBe(false);
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

  it('opens discard confirmation for no-result sessions and removes after confirm', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    const { result } = renderHook(() =>
      useTerminalSessions({ activeRepo: 'owner/repo', setFetchError: vi.fn() })
    );
    vi.mocked(shipper.api.ptyCloseState).mockResolvedValueOnce({
      state: 'requires-discard-confirmation',
    });

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

    expect(result.current.pendingClose?.reason).toBe('discard-progress');
    expect(result.current.sessions[0]?.status).toBe('running');

    act(() => {
      result.current.handlePendingCloseOpenChange(false);
    });
    expect(result.current.sessions.map((session) => session.id)).toEqual(['pty-1']);

    vi.mocked(shipper.api.ptyCloseState).mockResolvedValueOnce({
      state: 'requires-discard-confirmation',
    });
    act(() => {
      result.current.handleCloseSession('pty-1');
    });
    await flushHookEffects();

    await act(async () => {
      await result.current.handleConfirmCloseSession();
    });

    expect(shipper.api.ptyForceKill).toHaveBeenCalledWith('pty-1');
    expect(result.current.sessions).toHaveLength(0);
  });

  it('finalizes result-present and setup sessions without removing the tab', async () => {
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
      result.current.openRunningSession('pty-setup', 'setup — owner/repo', {
        repo: 'owner/repo',
      });
    });
    await flushHookEffects();

    act(() => {
      result.current.handleCloseSession('pty-1');
    });
    await flushHookEffects();

    expect(shipper.api.ptyFinalize).toHaveBeenCalledWith('pty-1');
    expect(result.current.sessions.find((session) => session.id === 'pty-1')?.status).toBe(
      'finalizing'
    );

    act(() => {
      result.current.handleCloseSession('pty-setup');
    });
    await flushHookEffects();

    expect(shipper.api.ptyFinalize).toHaveBeenCalledWith('pty-setup');
    expect(result.current.sessions.find((session) => session.id === 'pty-setup')?.status).toBe(
      'finalizing'
    );
  });

  it('offers force-kill for finalizing sessions and waits for PTY exit', async () => {
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
      result.current.handleCloseSession('pty-1');
    });
    await flushHookEffects();
    act(() => {
      result.current.handleCloseSession('pty-1');
    });

    expect(result.current.pendingClose?.reason).toBe('force-kill-finalizing');

    await act(async () => {
      await result.current.handleConfirmCloseSession();
    });

    expect(shipper.api.ptyForceKill).toHaveBeenCalledWith('pty-1');
    expect(result.current.sessions.map((session) => session.id)).toEqual(['pty-1']);

    shipper.emitPtyExit({ sessionId: 'pty-1', exitCode: null });
    expect(result.current.sessions[0]?.status).toBe('exited');
  });

  it('keeps non-zero exits inspectable and dismisses exited tabs without confirmation', async () => {
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

    shipper.emitPtyExit({ sessionId: 'pty-1', exitCode: 1 });
    expect(result.current.sessions[0]?.status).toBe('exited');

    act(() => {
      result.current.handleCloseSession('pty-1');
    });

    expect(result.current.pendingClose).toBeNull();
    expect(result.current.sessions).toHaveLength(0);
  });

  it('does not transition finalizing sessions back to waiting', async () => {
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
      result.current.handleCloseSession('pty-1');
    });
    await flushHookEffects();
    await advanceHookTimers(6_000);

    expect(result.current.sessions[0]?.status).toBe('finalizing');
  });

  it('reports close-state, finalize, and force-kill failures', async () => {
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

    vi.mocked(shipper.api.ptyCloseState).mockRejectedValueOnce(new Error('state denied'));
    act(() => {
      result.current.handleCloseSession('pty-1');
    });
    await flushHookEffects();

    vi.mocked(shipper.api.ptyFinalize).mockRejectedValueOnce(new Error('finalize denied'));
    act(() => {
      result.current.handleCloseSession('pty-1');
    });
    await flushHookEffects();

    vi.mocked(shipper.api.ptyCloseState).mockResolvedValueOnce({
      state: 'requires-discard-confirmation',
    });
    act(() => {
      result.current.handleCloseSession('pty-1');
    });
    await flushHookEffects();
    vi.mocked(shipper.api.ptyForceKill).mockRejectedValueOnce(new Error('kill denied'));
    await act(async () => {
      await result.current.handleConfirmCloseSession();
    });

    expect(setFetchError).toHaveBeenCalledWith('Failed to close terminal session: state denied');
    expect(setFetchError).toHaveBeenCalledWith('Failed to close terminal session: finalize denied');
    expect(setFetchError).toHaveBeenCalledWith('Failed to close terminal session: kill denied');
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
    vi.mocked(shipper.api.ptyCloseState).mockResolvedValueOnce({
      state: 'requires-discard-confirmation',
    });

    act(() => {
      result.current.handleToggleDrawer();
      result.current.handleCloseSession('pty-1');
    });

    expect(result.current.drawerOpen).toBe(false);
    await flushHookEffects();
    expect(result.current.pendingClose?.session.id).toBe('pty-1');

    act(() => {
      result.current.handlePendingCloseOpenChange(false);
    });

    expect(result.current.pendingClose).toBeNull();
  });
});
