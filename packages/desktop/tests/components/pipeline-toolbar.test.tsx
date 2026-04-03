// @vitest-environment jsdom

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PipelineToolbar } from '../../src/renderer/components/pipeline-toolbar.js';

describe('PipelineToolbar', () => {
  it('renders the timestamp and fires toolbar actions', () => {
    const onNewIssue = vi.fn();
    const onAdopt = vi.fn();
    const onRefresh = vi.fn();

    render(
      <PipelineToolbar
        lastUpdated={new Date('2026-04-03T12:00:00.000Z')}
        canFetch
        isLoading={false}
        onNewIssue={onNewIssue}
        onAdopt={onAdopt}
        onRefresh={onRefresh}
      />
    );

    expect(screen.getByText(/Last updated/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'New Issue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Adopt' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(onNewIssue).toHaveBeenCalledTimes(1);
    expect(onAdopt).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('disables actions when fetching is not allowed and shows the loading label', () => {
    render(
      <PipelineToolbar
        lastUpdated={null}
        canFetch={false}
        isLoading
        onNewIssue={vi.fn()}
        onAdopt={vi.fn()}
        onRefresh={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'New Issue' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Adopt' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Refreshing...' })).toHaveProperty('disabled', true);
  });
});
