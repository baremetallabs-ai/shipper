import { useEffect, useRef, useState } from 'react';
import type { ComponentRef, Dispatch, RefObject, SetStateAction } from 'react';

import { toErrorMessage } from '@dnsquared/shipper-core';

import { getShipperApi } from '../lib/shipper-api.js';
import type { PendingTerminalClose, TerminalCloseReason, TerminalSession } from '../types.js';

function getNextActiveSessionId(
  sessions: TerminalSession[],
  activeSessionId: string | null,
  removedSessionId: string
): string | null {
  if (activeSessionId !== removedSessionId) {
    return activeSessionId;
  }

  const removedIndex = sessions.findIndex((session) => session.id === removedSessionId);
  const remainingSessions = sessions.filter((session) => session.id !== removedSessionId);
  if (removedIndex < 0) {
    return remainingSessions[0]?.id ?? null;
  }

  return remainingSessions[removedIndex - 1]?.id ?? remainingSessions[removedIndex]?.id ?? null;
}

function findActiveIssueSession(
  sessions: TerminalSession[],
  repo: string,
  issueNumber: number
): TerminalSession | undefined {
  return sessions.find(
    (session) =>
      session.repo === repo && session.issueNumber === issueNumber && session.status !== 'exited'
  );
}

function findActiveSetupSession(
  sessions: TerminalSession[],
  repo: string
): TerminalSession | undefined {
  return sessions.find(
    (session) =>
      session.repo === repo && session.issueNumber === undefined && session.status !== 'exited'
  );
}

interface UseTerminalSessionsOptions {
  activeRepo: string;
  setFetchError: Dispatch<SetStateAction<string | null>>;
}

export interface UseTerminalSessionsResult {
  sessions: TerminalSession[];
  activeSessionId: string | null;
  pendingClose: PendingTerminalClose | null;
  drawerOpen: boolean;
  hasSession: boolean;
  contentPaneRef: RefObject<ComponentRef<'div'> | null>;
  toggleButtonRef: RefObject<ComponentRef<'button'> | null>;
  drawerPanelRef: RefObject<ComponentRef<'div'> | null>;
  openRunningSession: (
    sessionId: string,
    label: string,
    metadata?: { repo: string; issueNumber?: number }
  ) => void;
  focusExistingGroomSession: (issueNumber: number) => boolean;
  focusExistingSetupSession: (repo: string) => boolean;
  handlePendingCloseOpenChange: (open: boolean) => void;
  handleToggleDrawer: () => void;
  handleSelectSession: (sessionId: string) => void;
  handleCloseSession: (sessionId: string) => void;
  handleSessionInput: (sessionId: string) => void;
  handleConfirmCloseSession: () => Promise<void>;
}

export function useTerminalSessions({
  activeRepo,
  setFetchError,
}: UseTerminalSessionsOptions): UseTerminalSessionsResult {
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [pendingCloseState, setPendingCloseState] = useState<{
    sessionId: string;
    reason: TerminalCloseReason;
  } | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const contentPaneRef = useRef<ComponentRef<'div'> | null>(null);
  const toggleButtonRef = useRef<ComponentRef<'button'> | null>(null);
  const drawerPanelRef = useRef<ComponentRef<'div'> | null>(null);
  const sessionsRef = useRef<TerminalSession[]>([]);
  const activeSessionIdRef = useRef<string | null>(null);
  const lastOutputAtBySessionRef = useRef<Map<string, number>>(new Map());

  const hasSession = sessions.length > 0;
  const pendingCloseSession =
    pendingCloseState === null
      ? null
      : (sessions.find((session) => session.id === pendingCloseState.sessionId) ?? null);
  const pendingClose =
    pendingCloseState === null || pendingCloseSession === null
      ? null
      : ({
          session: pendingCloseSession,
          reason: pendingCloseState.reason,
        } satisfies PendingTerminalClose);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    const unsubscribe = getShipperApi().onPtyOutput((event) => {
      const outputAt = Date.now();
      lastOutputAtBySessionRef.current.set(event.sessionId, outputAt);

      const session = sessionsRef.current.find(
        (currentSession) =>
          currentSession.id === event.sessionId && currentSession.status !== 'exited'
      );
      if (!session || session.status !== 'waiting') {
        return;
      }

      setSessions((currentSessions) => {
        const sessionIndex = currentSessions.findIndex(
          (currentSession) =>
            currentSession.id === event.sessionId && currentSession.status === 'waiting'
        );
        if (sessionIndex < 0) {
          return currentSessions;
        }

        const currentSession = currentSessions[sessionIndex];
        if (!currentSession) {
          return currentSessions;
        }

        const nextSessions = [...currentSessions];
        nextSessions[sessionIndex] = { ...currentSession, status: 'running' };
        return nextSessions;
      });
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = getShipperApi().onPtyExit((event) => {
      if (event.exitCode === 0) {
        removeSession(event.sessionId);
        return;
      }

      setSessions((currentSessions) => {
        const sessionIndex = currentSessions.findIndex(
          (session) => session.id === event.sessionId && session.status !== 'exited'
        );
        if (sessionIndex < 0) {
          return currentSessions;
        }

        const session = currentSessions[sessionIndex];
        if (!session) {
          return currentSessions;
        }

        const nextSessions = [...currentSessions];
        nextSessions[sessionIndex] = { ...session, status: 'exited' };
        return nextSessions;
      });
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = getShipperApi().onPtyStatus((event) => {
      setSessions((currentSessions) => {
        const sessionIndex = currentSessions.findIndex(
          (session) => session.id === event.sessionId && session.status !== 'exited'
        );
        if (sessionIndex < 0) {
          return currentSessions;
        }

        const session = currentSessions[sessionIndex];
        if (!session || session.status === event.status) {
          return currentSessions;
        }

        const nextSessions = [...currentSessions];
        nextSessions[sessionIndex] = { ...session, status: event.status };
        return nextSessions;
      });
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    if (pendingCloseState !== null && pendingCloseSession === null) {
      setPendingCloseState(null);
    }
  }, [pendingCloseSession, pendingCloseState]);

  useEffect(() => {
    if (sessions.length === 0) {
      return;
    }

    const intervalId = globalThis.setInterval(() => {
      const now = Date.now();

      setSessions((currentSessions) => {
        let nextSessions: TerminalSession[] | null = null;

        for (const [index, session] of currentSessions.entries()) {
          const lastOutputAt = lastOutputAtBySessionRef.current.get(session.id);
          if (
            session.status !== 'running' ||
            lastOutputAt === undefined ||
            now - lastOutputAt <= 5_000
          ) {
            continue;
          }

          if (nextSessions === null) {
            nextSessions = [...currentSessions];
          }

          nextSessions[index] = { ...session, status: 'waiting' };
        }

        return nextSessions ?? currentSessions;
      });
    }, 1_000);

    return () => {
      globalThis.clearInterval(intervalId);
    };
  }, [sessions.length]);

  function focusVisibleShell(preferToggle: boolean): void {
    globalThis.setTimeout(() => {
      const toggleButton = toggleButtonRef.current as { focus: () => void } | null;
      const contentPane = contentPaneRef.current as { focus: () => void } | null;

      if (preferToggle && toggleButton) {
        toggleButton.focus();
        return;
      }

      contentPane?.focus();
    }, 0);
  }

  function removeSession(sessionId: string): void {
    const currentSessions = sessionsRef.current;
    if (!currentSessions.some((session) => session.id === sessionId)) {
      return;
    }

    const remainingSessions = currentSessions.filter((session) => session.id !== sessionId);
    const nextActiveSessionId = getNextActiveSessionId(
      currentSessions,
      activeSessionIdRef.current,
      sessionId
    );

    sessionsRef.current = remainingSessions;
    activeSessionIdRef.current = nextActiveSessionId;
    lastOutputAtBySessionRef.current.delete(sessionId);
    setSessions(remainingSessions);
    setActiveSessionId(nextActiveSessionId);
    setPendingCloseState((current) => (current?.sessionId === sessionId ? null : current));

    if (remainingSessions.length === 0) {
      setDrawerOpen(false);
      focusVisibleShell(false);
    }
  }

  function openRunningSession(
    sessionId: string,
    label: string,
    metadata?: { repo: string; issueNumber?: number }
  ): void {
    const session: TerminalSession = {
      id: sessionId,
      label,
      status: 'running',
      ...metadata,
    };

    lastOutputAtBySessionRef.current.set(session.id, Date.now());
    setSessions((currentSessions) => [...currentSessions, session]);
    setActiveSessionId(session.id);
    setDrawerOpen(true);
  }

  function focusExistingGroomSession(issueNumber: number): boolean {
    const existing = findActiveIssueSession(sessionsRef.current, activeRepo, issueNumber);
    if (existing) {
      setActiveSessionId(existing.id);
      setDrawerOpen(true);
      return true;
    }
    return false;
  }

  function focusExistingSetupSession(repo: string): boolean {
    const existing = findActiveSetupSession(sessionsRef.current, repo);
    if (existing) {
      setActiveSessionId(existing.id);
      setDrawerOpen(true);
      return true;
    }

    return false;
  }

  function handlePendingCloseOpenChange(open: boolean): void {
    if (!open) {
      setPendingCloseState(null);
    }
  }

  function handleToggleDrawer(): void {
    setDrawerOpen((current) => !current);
  }

  function handleSelectSession(sessionId: string): void {
    setActiveSessionId(sessionId);
  }

  function setSessionStatus(sessionId: string, status: TerminalSession['status']): void {
    setSessions((currentSessions) => {
      const sessionIndex = currentSessions.findIndex((session) => session.id === sessionId);
      if (sessionIndex < 0) {
        return currentSessions;
      }

      const session = currentSessions[sessionIndex];
      if (!session || session.status === status) {
        return currentSessions;
      }

      const nextSessions = [...currentSessions];
      nextSessions[sessionIndex] = { ...session, status };
      sessionsRef.current = nextSessions;
      return nextSessions;
    });
  }

  function handleCloseSession(sessionId: string): void {
    const session = sessionsRef.current.find((currentSession) => currentSession.id === sessionId);
    if (!session) {
      return;
    }

    if (session.status === 'exited') {
      removeSession(sessionId);
      return;
    }

    if (session.status === 'finalizing') {
      setPendingCloseState({ sessionId, reason: 'force-kill-finalizing' });
      return;
    }

    void (async () => {
      try {
        const closeState = await getShipperApi().ptyCloseState(sessionId);
        switch (closeState.state) {
          case 'finalizable':
            await getShipperApi().ptyFinalize(sessionId);
            setSessionStatus(sessionId, 'finalizing');
            break;
          case 'requires-discard-confirmation':
            setPendingCloseState({ sessionId, reason: 'discard-progress' });
            break;
          case 'finalizing':
            setPendingCloseState({ sessionId, reason: 'force-kill-finalizing' });
            break;
          case 'exited':
            removeSession(sessionId);
            break;
          default: {
            const exhaustiveCheck: never = closeState;
            throw new Error(`Unsupported close state: ${JSON.stringify(exhaustiveCheck)}`);
          }
        }
      } catch (error) {
        const message = toErrorMessage(error);
        setFetchError(`Failed to close terminal session: ${message}`);
      }
    })();
  }

  function handleSessionInput(sessionId: string): void {
    lastOutputAtBySessionRef.current.set(sessionId, Date.now());

    const session = sessionsRef.current.find(
      (currentSession) => currentSession.id === sessionId && currentSession.status !== 'exited'
    );
    if (!session || session.status !== 'waiting') {
      return;
    }

    setSessions((currentSessions) => {
      const sessionIndex = currentSessions.findIndex(
        (currentSession) => currentSession.id === sessionId && currentSession.status === 'waiting'
      );
      if (sessionIndex < 0) {
        return currentSessions;
      }

      const currentSession = currentSessions[sessionIndex];
      if (!currentSession) {
        return currentSessions;
      }

      const nextSessions = [...currentSessions];
      nextSessions[sessionIndex] = { ...currentSession, status: 'running' };
      return nextSessions;
    });
  }

  async function handleConfirmCloseSession(): Promise<void> {
    const pending = pendingCloseState;
    const session = pending
      ? (sessionsRef.current.find((currentSession) => currentSession.id === pending.sessionId) ??
        null)
      : null;
    if (!session || !pending) {
      setPendingCloseState(null);
      return;
    }

    try {
      await getShipperApi().ptyForceKill(session.id);
      setPendingCloseState(null);
      if (pending.reason === 'discard-progress') {
        removeSession(session.id);
      }
    } catch (error) {
      const message = toErrorMessage(error);
      setFetchError(`Failed to close terminal session: ${message}`);
    }
  }

  return {
    sessions,
    activeSessionId,
    pendingClose,
    drawerOpen,
    hasSession,
    contentPaneRef,
    toggleButtonRef,
    drawerPanelRef,
    openRunningSession,
    focusExistingGroomSession,
    focusExistingSetupSession,
    handlePendingCloseOpenChange,
    handleToggleDrawer,
    handleSelectSession,
    handleCloseSession,
    handleSessionInput,
    handleConfirmCloseSession,
  };
}
