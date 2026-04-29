import { act } from '@testing-library/react';
import { vi } from 'vitest';

import type {
  BackgroundOutputPayload,
  BackgroundStatusPayload,
  Prerequisites,
  ShipperApi,
  TimelineLabelEvent,
} from '../../src/renderer/types.js';

interface PtyOutputPayload {
  sessionId: string;
  sequence: number;
  data: string;
}

interface PtyExitPayload {
  sessionId: string;
  exitCode: number | null;
}

type EventCallbackMap = {
  backgroundStatus: ((event: BackgroundStatusPayload) => void) | null;
  backgroundOutput: ((event: BackgroundOutputPayload) => void) | null;
  ptyOutput: ((event: PtyOutputPayload) => void) | null;
  ptyExit: ((event: PtyExitPayload) => void) | null;
};

const defaultPrerequisites: Prerequisites = {
  ghInstalled: { ok: true, message: '' },
  ghAuth: { ok: true, message: '' },
};

function createUnsubscribe<T extends keyof EventCallbackMap>(
  callbacks: EventCallbackMap,
  key: T,
  callback: NonNullable<EventCallbackMap[T]>
): () => void {
  return () => {
    if (callbacks[key] === callback) {
      callbacks[key] = null;
    }
  };
}

export interface MockShipperApiController {
  api: ShipperApi;
  callbacks: EventCallbackMap;
  install: () => void;
  emitBackgroundStatus: (event: BackgroundStatusPayload) => void;
  emitBackgroundOutput: (event: BackgroundOutputPayload) => void;
  emitPtyOutput: (event: PtyOutputPayload) => void;
  emitPtyExit: (event: PtyExitPayload) => void;
}

export function createMockShipperApi(): MockShipperApiController {
  const callbacks: EventCallbackMap = {
    backgroundStatus: null,
    backgroundOutput: null,
    ptyOutput: null,
    ptyExit: null,
  };

  const api: ShipperApi = {
    checkPrerequisites: vi.fn(() => Promise.resolve(defaultPrerequisites)),
    getConfig: vi.fn(() =>
      Promise.resolve({
        repos: [],
        activeRepo: '',
        autoMergeRepos: [],
      })
    ),
    listAdoptableIssues: vi.fn(() => Promise.resolve({ ok: true, issues: [] })),
    listRepos: vi.fn(() => Promise.resolve([])),
    searchRepos: vi.fn(() =>
      Promise.resolve({ repositories: [], pageInfo: { hasNextPage: false, endCursor: null } })
    ),
    listIssues: vi.fn(() => Promise.resolve({ ok: true, issues: [] })),
    fetchIssueTimelines: vi.fn(() => Promise.resolve(new Map<number, TimelineLabelEvent[]>())),
    listPausedIssues: vi.fn(() => Promise.resolve([])),
    setConfig: vi.fn(() => Promise.resolve()),
    adoptIssue: vi.fn(() => Promise.resolve({ ok: true })),
    checkInit: vi.fn(() => Promise.resolve({ initialized: true })),
    scanReset: vi.fn(() =>
      Promise.resolve({
        ok: true,
        scan: {
          targetStage: 'planned',
          targetLabel: 'planned',
          labelsToRemove: [],
          addTarget: false,
          prs: [],
          branchesToDelete: [],
          localBranches: [],
          localWorktrees: [],
          commentCount: 0,
        },
      })
    ),
    executeReset: vi.fn(() => Promise.resolve({ ok: true })),
    checkLockStale: vi.fn(() => Promise.resolve({ stale: false })),
    unlockIssue: vi.fn(() => Promise.resolve({ ok: true })),
    pauseIssue: vi.fn(() => Promise.resolve()),
    resumeIssue: vi.fn(() => Promise.resolve()),
    closeNotPlanned: vi.fn(() => Promise.resolve({ ok: true })),
    setPriority: vi.fn(() => Promise.resolve({ ok: true })),
    spawnShipperGroom: vi.fn(() => Promise.resolve({ sessionId: 'pty-session-1' })),
    spawnShipperSetup: vi.fn(() => Promise.resolve({ sessionId: 'pty-setup-1' })),
    spawnBackgroundNew: vi.fn(() => Promise.resolve({ sessionId: 'bg-new-1' })),
    spawnBackgroundShip: vi.fn(() => Promise.resolve({ sessionId: 'bg-ship-1' })),
    spawnBackgroundInit: vi.fn(() => Promise.resolve({ sessionId: 'bg-init-1' })),
    spawnBackgroundUnblock: vi.fn(() => Promise.resolve({ sessionId: 'bg-unblock-1' })),
    killBackground: vi.fn(() => Promise.resolve()),
    requestPauseActive: vi.fn(() => Promise.resolve()),
    requestAutoShipHalt: vi.fn(() => Promise.resolve(0)),
    removeQueuedSession: vi.fn(() => Promise.resolve('paused')),
    getBackgroundOutput: vi.fn(() => Promise.resolve('')),
    ptyWrite: vi.fn(() => Promise.resolve()),
    ptyResize: vi.fn(() => Promise.resolve()),
    ptyKill: vi.fn(() => Promise.resolve()),
    onPtyOutput: vi.fn((callback: (event: PtyOutputPayload) => void) => {
      callbacks.ptyOutput = callback;
      return createUnsubscribe(callbacks, 'ptyOutput', callback);
    }),
    onPtyExit: vi.fn((callback: (event: PtyExitPayload) => void) => {
      callbacks.ptyExit = callback;
      return createUnsubscribe(callbacks, 'ptyExit', callback);
    }),
    onBackgroundStatus: vi.fn((callback: (event: BackgroundStatusPayload) => void) => {
      callbacks.backgroundStatus = callback;
      return createUnsubscribe(callbacks, 'backgroundStatus', callback);
    }),
    onBackgroundOutput: vi.fn((callback: (event: BackgroundOutputPayload) => void) => {
      callbacks.backgroundOutput = callback;
      return createUnsubscribe(callbacks, 'backgroundOutput', callback);
    }),
  };

  return {
    api,
    callbacks,
    install() {
      Object.defineProperty(globalThis.window, 'shipperAPI', {
        configurable: true,
        writable: true,
        value: api,
      });
    },
    emitBackgroundStatus(event) {
      act(() => {
        callbacks.backgroundStatus?.(event);
      });
    },
    emitBackgroundOutput(event) {
      act(() => {
        callbacks.backgroundOutput?.(event);
      });
    },
    emitPtyOutput(event) {
      act(() => {
        callbacks.ptyOutput?.(event);
      });
    },
    emitPtyExit(event) {
      act(() => {
        callbacks.ptyExit?.(event);
      });
    },
  };
}

export function setupHookTestTimers(now = '2026-04-03T12:00:00.000Z'): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(now));
}

export function teardownHookTestTimers(): void {
  vi.useRealTimers();
}

export async function advanceHookTimers(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  });
}

export async function flushHookEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}
