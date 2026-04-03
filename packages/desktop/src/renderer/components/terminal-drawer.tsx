import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect } from 'react';
import type { JSX, RefObject } from 'react';

import { cn } from '../lib/utils.js';
import type { TerminalSession } from '../types.js';
import { TerminalPanel } from './terminal-panel.js';

interface TerminalDrawerProps {
  sessions: TerminalSession[];
  activeSessionId: string | null;
  open: boolean;
  toggleButtonRef: RefObject<HTMLButtonElement | null>;
  drawerPanelRef: RefObject<HTMLDivElement | null>;
  onToggle: () => void;
  onSelectSession: (id: string) => void;
  onCloseSession: (id: string) => void;
  onSessionInput: (id: string) => void;
}

export function TerminalDrawer({
  sessions,
  activeSessionId,
  open,
  toggleButtonRef,
  drawerPanelRef,
  onToggle,
  onSelectSession,
  onCloseSession,
  onSessionInput,
}: TerminalDrawerProps): JSX.Element {
  const panelId = 'terminal-drawer-panel';

  useEffect(() => {
    const panel = drawerPanelRef.current;
    if (!panel) {
      return;
    }

    if (open) {
      panel.removeAttribute('inert');
      return;
    }

    panel.setAttribute('inert', '');
  }, [drawerPanelRef, open]);

  return (
    <>
      <button
        ref={toggleButtonRef}
        type="button"
        onClick={onToggle}
        className="cursor-pointer flex w-5 flex-shrink-0 items-center justify-center border-l border-border bg-background text-muted-foreground outline-none transition-[color,box-shadow] hover:bg-muted hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        aria-label={open ? 'Close terminal drawer' : 'Open terminal drawer'}
        aria-expanded={open}
        aria-controls={panelId}
      >
        {open ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
      </button>
      <div
        id={panelId}
        ref={drawerPanelRef}
        aria-hidden={!open}
        className={cn(
          'flex-shrink-0 overflow-hidden transition-[width] duration-200',
          open ? 'w-[40%]' : 'pointer-events-none w-0'
        )}
      >
        <div className="h-full min-w-[40vw]">
          <TerminalPanel
            sessions={sessions}
            activeSessionId={activeSessionId}
            onSelectSession={onSelectSession}
            onCloseSession={onCloseSession}
            onSessionInput={onSessionInput}
          />
        </div>
      </div>
    </>
  );
}
