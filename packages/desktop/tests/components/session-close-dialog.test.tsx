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
  it('renders discard-progress copy and confirms closure', () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <SessionCloseDialog
        pendingClose={{ session: createSession(), reason: 'discard-progress' }}
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
      />
    );

    expect(screen.getByText('Discard terminal progress?')).toBeTruthy();
    expect(screen.getByText(/No result\.json exists yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Discard progress' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('renders force-kill copy and uses the force-kill label', () => {
    render(
      <SessionCloseDialog
        pendingClose={{
          session: createSession({ status: 'finalizing', label: 'groom - #99' }),
          reason: 'force-kill-finalizing',
        }}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
      />
    );

    expect(screen.getByText('Force-kill finalizing session?')).toBeTruthy();
    expect(screen.getByText('Post-session processing may not complete.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Force kill' })).toBeTruthy();
  });
});
