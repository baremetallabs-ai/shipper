import type { JSX } from 'react';
import type { TerminalSessionTab } from './session-tab-bar.js';

import { SessionTabBar } from './session-tab-bar.js';
import { TerminalInstance } from './terminal-instance.js';

interface TerminalPanelProps {
  sessions: TerminalSessionTab[];
  activeSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
}

export function TerminalPanel({
  sessions,
  activeSessionId,
  onSelectSession,
  onCloseSession,
}: TerminalPanelProps): JSX.Element {
  return (
    <div className="flex h-full flex-col border-l border-white/10">
      <SessionTabBar
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelectSession={onSelectSession}
        onCloseSession={onCloseSession}
      />
      <div className="min-h-0 flex-1 bg-[#0b1020]">
        {sessions.map((session) => (
          <TerminalInstance
            key={session.id}
            sessionId={session.id}
            status={session.status}
            visible={session.id === activeSessionId}
          />
        ))}
      </div>
    </div>
  );
}
