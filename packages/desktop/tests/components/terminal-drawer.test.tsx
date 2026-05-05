// @vitest-environment jsdom

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { TerminalSession } from '../../src/renderer/types.js';
import { TerminalDrawer } from '../../src/renderer/components/terminal-drawer.js';

vi.mock('../../src/renderer/components/terminal-panel.js', () => ({
  TerminalPanel: ({
    sessions,
    activeSessionId,
    onSelectSession,
    onCloseSession,
    onSessionInput,
  }: {
    sessions: TerminalSession[];
    activeSessionId: string | null;
    onSelectSession: (id: string) => void;
    onCloseSession: (id: string) => void;
    onSessionInput: (id: string) => void;
  }) => (
    <div>
      <p>active:{activeSessionId}</p>
      {sessions.map((session) => (
        <button
          key={session.id}
          type="button"
          onClick={() => {
            onSelectSession(session.id);
            onCloseSession(session.id);
            onSessionInput(session.id);
          }}
        >
          {session.label}
        </button>
      ))}
    </div>
  ),
}));

const sessions: TerminalSession[] = [{ id: 'pty-1', label: 'groom - #12', status: 'running' }];

describe('TerminalDrawer', () => {
  it('renders the open-state drawer and fires toggle and panel callbacks', () => {
    const onToggle = vi.fn();
    const onSelectSession = vi.fn();
    const onCloseSession = vi.fn();
    const onSessionInput = vi.fn();

    const { container } = render(
      <TerminalDrawer
        sessions={sessions}
        activeSessionId="pty-1"
        open
        toggleButtonRef={{ current: null }}
        drawerPanelRef={{ current: null }}
        onToggle={onToggle}
        onSelectSession={onSelectSession}
        onCloseSession={onCloseSession}
        onSessionInput={onSessionInput}
      />
    );

    const toggleButton = screen.getByRole('button', { name: 'Close terminal drawer' });

    expect(container.innerHTML).toContain('aria-expanded="true"');
    expect(container.innerHTML).toContain('aria-controls="terminal-drawer-panel"');

    fireEvent.click(toggleButton);
    fireEvent.click(screen.getByRole('button', { name: 'groom - #12' }));

    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onSelectSession).toHaveBeenCalledWith('pty-1');
    expect(onCloseSession).toHaveBeenCalledWith('pty-1');
    expect(onSessionInput).toHaveBeenCalledWith('pty-1');
  });

  it('renders the closed-state aria attributes', () => {
    const { container } = render(
      <TerminalDrawer
        sessions={sessions}
        activeSessionId="pty-1"
        open={false}
        toggleButtonRef={{ current: null }}
        drawerPanelRef={{ current: null }}
        onToggle={vi.fn()}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
        onSessionInput={vi.fn()}
      />
    );

    const toggleButton = screen.getByRole('button', { name: 'Open terminal drawer' });

    expect(toggleButton).toBeTruthy();
    expect(container.innerHTML).toContain('aria-expanded="false"');
    expect(container.innerHTML).toContain('aria-hidden="true"');
    expect(container.innerHTML).toContain('inert=""');
  });
});
