// @vitest-environment jsdom

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { TerminalSession } from '../../src/renderer/types.js';
import { SessionCloseDialog } from '../../src/renderer/components/session-close-dialog.js';

function createSession(overrides: Partial<TerminalSession> = {}): TerminalSession {
  return {
    id: 'pty-1',
    label: 'groom - #12',
    status: 'running',
    ...overrides,
  };
}

describe('SessionCloseDialog', () => {
  it('renders the live-session copy and confirms closure', () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <SessionCloseDialog
        session={createSession()}
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
      />
    );

    expect(screen.getByText('Close live terminal session?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Kill session' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('renders exited-session copy and uses the close-tab label', () => {
    render(
      <SessionCloseDialog
        session={createSession({ status: 'exited', label: 'groom - #99' })}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
      />
    );

    expect(screen.getByText('Close terminal tab?')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close tab' })).toBeTruthy();
  });
});
