import type { JSX } from 'react';
import type { TerminalSession } from '../types.js';

import { SessionTabBar } from './session-tab-bar.js';
import { TerminalInstance } from './terminal-instance.js';

interface TerminalPanelProps {
  sessions: TerminalSession[];
  activeSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
  onSessionInput: (sessionId: string) => void;
}

export function TerminalPanel({
  sessions,
  activeSessionId,
  onSelectSession,
  onCloseSession,
  onSessionInput,
}: TerminalPanelProps): JSX.Element {
  return (
    <div className="flex h-full flex-col border-l border-border">
      <SessionTabBar
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelectSession={onSelectSession}
        onCloseSession={onCloseSession}
      />
      <div className="min-h-0 flex-1 bg-terminal-bg">
        {sessions.map((session) => (
          <TerminalInstance
            key={session.id}
            sessionId={session.id}
            status={session.status}
            visible={session.id === activeSessionId}
            onInput={() => {
              onSessionInput(session.id);
            }}
          />
        ))}
      </div>
    </div>
  );
}
