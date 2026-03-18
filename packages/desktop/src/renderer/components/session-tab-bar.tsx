import { X } from 'lucide-react';
import type { JSX } from 'react';

import { cn } from '../lib/utils.js';

export type TerminalSessionStatus = 'running' | 'waiting' | 'exited';

export interface TerminalSessionTab {
  id: string;
  label: string;
  status: TerminalSessionStatus;
}

interface SessionTabBarProps {
  sessions: TerminalSessionTab[];
  activeSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
}

const STATUS_DOT_CLASS: Record<TerminalSessionStatus, string> = {
  running: 'bg-success',
  waiting: 'bg-warning',
  exited: 'bg-muted-foreground',
};

export function SessionTabBar({
  sessions,
  activeSessionId,
  onSelectSession,
  onCloseSession,
}: SessionTabBarProps): JSX.Element {
  return (
    <div className="flex items-center gap-2 overflow-x-auto border-b border-border bg-muted px-3 py-2">
      {sessions.map((session) => {
        const isActive = session.id === activeSessionId;
        const waitingAttention = session.status === 'waiting' && !isActive;

        return (
          <div
            key={session.id}
            className={cn(
              'flex min-w-0 items-center overflow-hidden rounded-sm border transition-colors',
              isActive
                ? 'border-primary bg-primary text-primary-foreground'
                : waitingAttention
                  ? 'border-warning/50 bg-warning/10 text-foreground'
                  : 'border-border bg-card text-card-foreground'
            )}
          >
            <button
              type="button"
              className="flex min-w-0 items-center gap-2 px-3 py-2 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => {
                onSelectSession(session.id);
              }}
            >
              <span
                className={cn('size-2 shrink-0 rounded-full', STATUS_DOT_CLASS[session.status])}
                aria-hidden="true"
              />
              <span className="block max-w-52 truncate">{session.label}</span>
            </button>
            <button
              type="button"
              className={cn(
                'border-l px-2 py-2 transition-colors',
                isActive
                  ? 'border-primary-foreground/20 hover:bg-primary-foreground/10'
                  : waitingAttention
                    ? 'border-warning/20 hover:bg-warning/10'
                    : 'border-border hover:bg-accent hover:text-accent-foreground'
              )}
              aria-label={`Close ${session.label}`}
              onClick={(event) => {
                event.stopPropagation();
                onCloseSession(session.id);
              }}
            >
              <X className="size-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
