import { useEffect, useRef, useState } from 'react';
import type { ComponentRef, Dispatch, RefObject, SetStateAction } from 'react';

import { toErrorMessage } from '../../../../core/src/lib/errors.js';

import { getShipperApi } from '../lib/shipper-api.js';
import type { TerminalSession } from '../types.js';

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

interface UseTerminalSessionsOptions {
  activeRepo: string;
  setFetchError: Dispatch<SetStateAction<string | null>>;
}

export interface UseTerminalSessionsResult {
  sessions: TerminalSession[];
  activeSessionId: string | null;
  pendingCloseSession: TerminalSession | null;
  drawerOpen: boolean;
  hasSession: boolean;
  contentPaneRef: RefObject<ComponentRef<'div'> | null>;
  toggleButtonRef: RefObject<ComponentRef<'button'> | null>;
  drawerPanelRef: RefObject<ComponentRef<'div'> | null>;
  openRunningSession: (
    sessionId: string,
    label: string,
    metadata?: { repo: string; issueNumber: number }
  ) => void;
  focusExistingGroomSession: (issueNumber: number) => boolean;
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
  const [pendingCloseSessionId, setPendingCloseSessionId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const contentPaneRef = useRef<ComponentRef<'div'> | null>(null);
  const toggleButtonRef = useRef<ComponentRef<'button'> | null>(null);
  const drawerPanelRef = useRef<ComponentRef<'div'> | null>(null);
  const sessionsRef = useRef<TerminalSession[]>([]);
  const activeSessionIdRef = useRef<string | null>(null);
  const lastOutputAtBySessionRef = useRef<Map<string, number>>(new Map());

  const hasSession = sessions.length > 0;
  const pendingCloseSession =
    pendingCloseSessionId === null
      ? null
      : (sessions.find((session) => session.id === pendingCloseSessionId) ?? null);

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
    if (pendingCloseSessionId !== null && pendingCloseSession === null) {
      setPendingCloseSessionId(null);
    }
  }, [pendingCloseSession, pendingCloseSessionId]);

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
    setPendingCloseSessionId((current) => (current === sessionId ? null : current));

    if (remainingSessions.length === 0) {
      setDrawerOpen(false);
      focusVisibleShell(false);
    }
  }

  function openRunningSession(
    sessionId: string,
    label: string,
    metadata?: { repo: string; issueNumber: number }
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

  function handlePendingCloseOpenChange(open: boolean): void {
    if (!open) {
      setPendingCloseSessionId(null);
    }
  }

  function handleToggleDrawer(): void {
    setDrawerOpen((current) => !current);
  }

  function handleSelectSession(sessionId: string): void {
    setActiveSessionId(sessionId);
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

    setPendingCloseSessionId(sessionId);
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
    const session = pendingCloseSessionId
      ? (sessionsRef.current.find(
          (currentSession) => currentSession.id === pendingCloseSessionId
        ) ?? null)
      : null;
    if (!session) {
      setPendingCloseSessionId(null);
      return;
    }

    if (session.status === 'exited') {
      setPendingCloseSessionId(null);
      removeSession(session.id);
      return;
    }

    try {
      await getShipperApi().ptyKill(session.id);
      setPendingCloseSessionId(null);
      removeSession(session.id);
    } catch (error) {
      const message = toErrorMessage(error);
      setFetchError(`Failed to close terminal session: ${message}`);
    }
  }

  return {
    sessions,
    activeSessionId,
    pendingCloseSession,
    drawerOpen,
    hasSession,
    contentPaneRef,
    toggleButtonRef,
    drawerPanelRef,
    openRunningSession,
    focusExistingGroomSession,
    handlePendingCloseOpenChange,
    handleToggleDrawer,
    handleSelectSession,
    handleCloseSession,
    handleSessionInput,
    handleConfirmCloseSession,
  };
}
