// @vitest-environment jsdom

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PipelineEmptyState } from '../../src/renderer/components/pipeline-empty-state.js';

describe('PipelineEmptyState', () => {
  it('returns null when the pipeline board should render', () => {
    const { container } = render(
      <PipelineEmptyState
        repoCount={1}
        repoInitialized
        canFetch
        hasActiveRepo
        onAddRepo={vi.fn()}
        onInit={vi.fn()}
      />
    );

    expect(container.firstChild).toBeNull();
  });

  it('renders the add-repository state', () => {
    const onAddRepo = vi.fn();

    render(
      <PipelineEmptyState
        repoCount={0}
        repoInitialized={null}
        canFetch
        hasActiveRepo={false}
        onAddRepo={onAddRepo}
        onInit={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add repository' }));
    expect(onAddRepo).toHaveBeenCalledTimes(1);
  });

  it('renders the loading spinner while init state is pending', () => {
    const { container } = render(
      <PipelineEmptyState
        repoCount={1}
        repoInitialized={null}
        canFetch
        hasActiveRepo
        onAddRepo={vi.fn()}
        onInit={vi.fn()}
      />
    );

    expect(String(container.innerHTML)).toContain('animate-spin');
  });

  it('renders the initialize CTA and preserves the disabled rule', () => {
    const onInit = vi.fn();

    const { rerender } = render(
      <PipelineEmptyState
        repoCount={1}
        repoInitialized={false}
        canFetch
        hasActiveRepo
        onAddRepo={vi.fn()}
        onInit={onInit}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Initialize' }));
    expect(onInit).toHaveBeenCalledTimes(1);

    rerender(
      <PipelineEmptyState
        repoCount={1}
        repoInitialized={false}
        canFetch={false}
        hasActiveRepo
        onAddRepo={vi.fn()}
        onInit={onInit}
      />
    );

    expect(screen.getByRole('button', { name: 'Initialize' })).toHaveProperty('disabled', true);
  });
});
