// @vitest-environment jsdom

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SessionTabBar } from '../../src/renderer/components/session-tab-bar.js';
import type { TerminalSession } from '../../src/renderer/types.js';

const sessions: TerminalSession[] = [
  { id: 'pty-1', label: 'groom - #11', status: 'finalizing' },
  { id: 'pty-2', label: 'setup - owner/repo', status: 'running' },
];

describe('SessionTabBar', () => {
  it('exposes session status and close action in accessible labels', () => {
    const onSelectSession = vi.fn();
    const onCloseSession = vi.fn();

    render(
      <SessionTabBar
        sessions={sessions}
        activeSessionId="pty-1"
        onSelectSession={onSelectSession}
        onCloseSession={onCloseSession}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'groom - #11 (finalizing)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Force-kill groom - #11 (finalizing)' }));

    expect(screen.getByText('finalizing')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'setup - owner/repo (running)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close setup - owner/repo (running)' })).toBeTruthy();
    expect(onSelectSession).toHaveBeenCalledWith('pty-1');
    expect(onCloseSession).toHaveBeenCalledWith('pty-1');
  });
});
