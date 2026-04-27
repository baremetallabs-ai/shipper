// @vitest-environment jsdom

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PipelineToolbar } from '../../src/renderer/components/pipeline-toolbar.js';

describe('PipelineToolbar', () => {
  it('renders the timestamp and fires toolbar actions', () => {
    const onNewIssue = vi.fn();
    const onAdopt = vi.fn();
    const onSetup = vi.fn();
    const onRefresh = vi.fn();

    render(
      <PipelineToolbar
        lastUpdated={new Date('2026-04-03T12:00:00.000Z')}
        canFetch
        isLoading={false}
        setupEnabled
        isSetupPending={false}
        onNewIssue={onNewIssue}
        onAdopt={onAdopt}
        onSetup={onSetup}
        onRefresh={onRefresh}
      />
    );

    expect(screen.getByText(/Last updated/)).toBeTruthy();
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(4);
    expect(buttons[0]?.textContent).toBe('New Issue');
    expect(buttons[1]?.textContent).toBe('Adopt');
    expect(buttons[2]?.textContent).toBe('Setup');
    expect(buttons[3]?.textContent).toBe('Refresh');

    fireEvent.click(screen.getByRole('button', { name: 'New Issue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Adopt' }));
    fireEvent.click(screen.getByRole('button', { name: 'Setup' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(onNewIssue).toHaveBeenCalledTimes(1);
    expect(onAdopt).toHaveBeenCalledTimes(1);
    expect(onSetup).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('keeps Setup independent from fetch/loading and disables it through setup state', () => {
    const { rerender } = render(
      <PipelineToolbar
        lastUpdated={null}
        canFetch={false}
        isLoading
        setupEnabled
        isSetupPending={false}
        onNewIssue={vi.fn()}
        onAdopt={vi.fn()}
        onSetup={vi.fn()}
        onRefresh={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'New Issue' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Adopt' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Setup' })).toHaveProperty('disabled', false);
    expect(screen.getByRole('button', { name: 'Refreshing...' })).toHaveProperty('disabled', true);

    rerender(
      <PipelineToolbar
        lastUpdated={null}
        canFetch
        isLoading={false}
        setupEnabled={false}
        isSetupPending={false}
        onNewIssue={vi.fn()}
        onAdopt={vi.fn()}
        onSetup={vi.fn()}
        onRefresh={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'New Issue' })).toHaveProperty('disabled', false);
    expect(screen.getByRole('button', { name: 'Adopt' })).toHaveProperty('disabled', false);
    expect(screen.getByRole('button', { name: 'Setup' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Refresh' })).toHaveProperty('disabled', false);
  });

  it('renders disabled Setup button feedback while a setup launch is pending', () => {
    render(
      <PipelineToolbar
        lastUpdated={null}
        canFetch
        isLoading={false}
        setupEnabled
        isSetupPending
        onNewIssue={vi.fn()}
        onAdopt={vi.fn()}
        onSetup={vi.fn()}
        onRefresh={vi.fn()}
      />
    );

    const setupButton = screen.getByRole('button', { name: 'Setup' });

    expect(setupButton).toHaveProperty('disabled', true);
    expect(setupButton.textContent).toContain('Setup');
    expect(setupButton.innerHTML).toContain('animate-spin');
  });
});
