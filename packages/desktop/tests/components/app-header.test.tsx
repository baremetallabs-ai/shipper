// @vitest-environment jsdom

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AppHeader } from '../../src/renderer/components/app-header.js';

describe('AppHeader', () => {
  it('renders the title copy and repo tab bar actions', () => {
    const onSelectRepo = vi.fn();
    const onCloseRepo = vi.fn();
    const onAddRepo = vi.fn();

    render(
      <AppHeader
        repos={['owner/repo', 'other/repo']}
        activeRepo="owner/repo"
        activeCommandRepos={new Set(['owner/repo'])}
        onSelectRepo={onSelectRepo}
        onCloseRepo={onCloseRepo}
        onAddRepo={onAddRepo}
        onReorderRepos={vi.fn()}
      />
    );

    expect(screen.getByText('Shipper Desktop')).toBeTruthy();
    expect(screen.getByText('Pipeline')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'other/repo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add repo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove owner/repo' }));

    expect(onSelectRepo).toHaveBeenCalledWith('other/repo');
    expect(onAddRepo).toHaveBeenCalledTimes(1);
    expect(onCloseRepo).toHaveBeenCalledWith('owner/repo');
  });

  it('omits the repo tab bar when there are no repos', () => {
    render(
      <AppHeader
        repos={[]}
        activeRepo=""
        activeCommandRepos={new Set()}
        onSelectRepo={vi.fn()}
        onCloseRepo={vi.fn()}
        onAddRepo={vi.fn()}
        onReorderRepos={vi.fn()}
      />
    );

    expect(screen.queryByRole('button', { name: 'Add repo' })).toBeNull();
  });
});
