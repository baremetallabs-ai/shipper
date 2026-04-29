// @vitest-environment jsdom

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RepoPickerDialog } from '../../src/renderer/components/repo-picker-dialog.js';
import type { RepoPickerRepository } from '../../src/renderer/types.js';

class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

Object.defineProperty(globalThis.window, 'ResizeObserver', {
  configurable: true,
  value: MockResizeObserver,
});

Object.defineProperty(globalThis, 'ResizeObserver', {
  configurable: true,
  value: MockResizeObserver,
});

function installShipperApi(repos: RepoPickerRepository[]): void {
  Object.defineProperty(globalThis.window, 'shipperAPI', {
    configurable: true,
    value: {
      listRepos: vi.fn().mockResolvedValue(repos),
    },
  });
}

function installRejectedShipperApi(error: unknown): void {
  Object.defineProperty(globalThis.window, 'shipperAPI', {
    configurable: true,
    value: {
      listRepos: vi.fn().mockRejectedValue(error),
    },
  });
}

function renderDialog({
  repos,
  configuredRepos = [],
  onSelectRepo = vi.fn(),
}: {
  repos: RepoPickerRepository[];
  configuredRepos?: string[];
  onSelectRepo?: (repo: string) => void;
}): ReturnType<typeof render> & { onSelectRepo: (repo: string) => void } {
  installShipperApi(repos);

  const result = render(
    <RepoPickerDialog
      open
      onOpenChange={vi.fn()}
      repos={configuredRepos}
      onSelectRepo={onSelectRepo}
    />
  );

  return { ...result, onSelectRepo };
}

function renderRejectedDialog({
  configuredRepos = [],
  onSelectRepo = vi.fn(),
}: {
  configuredRepos?: string[];
  onSelectRepo?: (repo: string) => void;
} = {}): ReturnType<typeof render> & { onSelectRepo: (repo: string) => void } {
  installRejectedShipperApi(new Error('GitHub failed'));

  const result = render(
    <RepoPickerDialog
      open
      onOpenChange={vi.fn()}
      repos={configuredRepos}
      onSelectRepo={onSelectRepo}
    />
  );

  return { ...result, onSelectRepo };
}

function expectTextBefore(first: string, second: string): void {
  // The desktop test tsconfig is Node-based, but this file runs under jsdom.
  /* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
  const entries = Array.from(
    screen.getByRole('dialog').querySelectorAll('[cmdk-group-heading], [data-slot="command-item"]')
  ).map((entry) => {
    const text = entry.textContent;
    return typeof text === 'string' ? text.trim() : '';
  });
  /* eslint-enable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
  const firstIndex = entries.indexOf(first);
  const secondIndex = entries.indexOf(second);

  expect(firstIndex).toBeGreaterThanOrEqual(0);
  expect(secondIndex).toBeGreaterThanOrEqual(0);
  expect(firstIndex).toBeLessThan(secondIndex);
}

describe('RepoPickerDialog', () => {
  it('renders owner, organization, and other repositories in grouped order', async () => {
    renderDialog({
      repos: [
        { nameWithOwner: 'octocat/personal-new', group: 'owner' },
        {
          nameWithOwner: 'zebra/tools-new',
          group: 'organization',
          organizationLogin: 'zebra',
        },
        {
          nameWithOwner: 'acme/service',
          group: 'organization',
          organizationLogin: 'acme',
        },
        {
          nameWithOwner: 'zebra/tools-old',
          group: 'organization',
          organizationLogin: 'zebra',
        },
        { nameWithOwner: 'octocat/personal-old', group: 'owner' },
        { nameWithOwner: 'someone-else/foo', group: 'other' },
      ],
    });

    expect(await screen.findByText('Your repositories')).toBeTruthy();
    expect(screen.getByText('acme')).toBeTruthy();
    expect(screen.getByText('zebra')).toBeTruthy();
    expect(screen.getByText('Other repositories')).toBeTruthy();
    expectTextBefore('Your repositories', 'acme');
    expectTextBefore('acme', 'zebra');
    expectTextBefore('zebra', 'Other repositories');
    expectTextBefore('Your repositories', 'octocat/personal-new');
    expectTextBefore('octocat/personal-new', 'octocat/personal-old');
    expectTextBefore('acme', 'acme/service');
    expectTextBefore('zebra', 'zebra/tools-new');
    expectTextBefore('zebra/tools-new', 'zebra/tools-old');
    expectTextBefore('Other repositories', 'someone-else/foo');
  });

  it('omits the owner heading when only other repositories are returned', async () => {
    renderDialog({
      repos: [{ nameWithOwner: 'acme/org-repo', group: 'other' }],
    });

    expect(await screen.findByText('Other repositories')).toBeTruthy();
    expect(screen.queryByText('Your repositories')).toBeNull();
  });

  it('omits the other heading when only owner repositories are returned', async () => {
    renderDialog({
      repos: [{ nameWithOwner: 'octocat/personal', group: 'owner' }],
    });

    expect(await screen.findByText('Your repositories')).toBeTruthy();
    expect(screen.queryByText('Other repositories')).toBeNull();
  });

  it('omits organization headings when no organization repositories are returned', async () => {
    renderDialog({
      repos: [
        { nameWithOwner: 'octocat/personal', group: 'owner' },
        { nameWithOwner: 'someone-else/foo', group: 'other' },
      ],
    });

    expect(await screen.findByText('octocat/personal')).toBeTruthy();
    expect(screen.getByText('someone-else/foo')).toBeTruthy();
    expect(screen.queryByText('acme')).toBeNull();
  });

  it('filters configured repositories from every group case-insensitively', async () => {
    renderDialog({
      configuredRepos: ['OCTOCAT/PERSONAL', 'ACME/ORG-REPO'],
      repos: [
        { nameWithOwner: 'octocat/personal', group: 'owner' },
        { nameWithOwner: 'octocat/visible', group: 'owner' },
        {
          nameWithOwner: 'acme/org-repo',
          group: 'organization',
          organizationLogin: 'acme',
        },
        { nameWithOwner: 'someone-else/foo', group: 'other' },
      ],
    });

    expect(await screen.findByText('octocat/visible')).toBeTruthy();
    expect(screen.getByText('someone-else/foo')).toBeTruthy();
    expect(screen.queryByText('octocat/personal')).toBeNull();
    expect(screen.queryByText('acme/org-repo')).toBeNull();
    expect(screen.queryByText('acme')).toBeNull();
  });

  it('filters search results across organization sections and hides empty headings', async () => {
    renderDialog({
      repos: [
        { nameWithOwner: 'octocat/personal', group: 'owner' },
        {
          nameWithOwner: 'acme/api',
          group: 'organization',
          organizationLogin: 'acme',
        },
        {
          nameWithOwner: 'beta/dashboard',
          group: 'organization',
          organizationLogin: 'beta',
        },
        { nameWithOwner: 'someone-else/foo', group: 'other' },
      ],
    });

    await screen.findByText('beta/dashboard');
    fireEvent.change(screen.getByPlaceholderText('Search repositories or type owner/repo'), {
      target: { value: 'acme' },
    });

    expect(screen.getByText('acme')).toBeTruthy();
    expect(screen.getByText('acme/api')).toBeTruthy();
    expect(screen.queryByText('beta')).toBeNull();
    expect(screen.queryByText('beta/dashboard')).toBeNull();
    expect(screen.queryByText('Your repositories')).toBeNull();
    expect(screen.queryByText('Other repositories')).toBeNull();
  });

  it('keeps manual entry available for valid repositories absent from listed results', async () => {
    const onSelectRepo = vi.fn();
    renderDialog({
      repos: [
        { nameWithOwner: 'octocat/personal', group: 'owner' },
        {
          nameWithOwner: 'acme/service',
          group: 'organization',
          organizationLogin: 'acme',
        },
      ],
      onSelectRepo,
    });

    await screen.findByText('octocat/personal');
    fireEvent.change(screen.getByPlaceholderText('Search repositories or type owner/repo'), {
      target: { value: 'someone-else/foo' },
    });

    expect(await screen.findByText('Manual entry')).toBeTruthy();
    const manualItem = screen.getByText('Add "someone-else/foo"');
    fireEvent.click(manualItem);

    expect(onSelectRepo).toHaveBeenCalledWith('someone-else/foo');
  });

  it('keeps duplicate manual-entry feedback for configured repositories', async () => {
    renderDialog({
      configuredRepos: ['octocat/personal'],
      repos: [
        {
          nameWithOwner: 'acme/org-repo',
          group: 'organization',
          organizationLogin: 'acme',
        },
      ],
    });

    await screen.findByText('acme/org-repo');
    fireEvent.change(screen.getByPlaceholderText('Search repositories or type owner/repo'), {
      target: { value: 'OCTOCAT/PERSONAL' },
    });

    expect(await screen.findByText('Manual entry')).toBeTruthy();
    expect(screen.getByText('OCTOCAT/PERSONAL is already added')).toBeTruthy();
    expect(screen.queryByText('Add "OCTOCAT/PERSONAL"')).toBeNull();
  });

  it('renders a single error banner without repository, manual, or empty groups', async () => {
    renderRejectedDialog();

    expect(await screen.findByText('Could not load repositories')).toBeTruthy();
    expect(screen.getByText('GitHub failed')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('Search repositories or type owner/repo'), {
      target: { value: 'someone-else/foo' },
    });

    expect(screen.queryByText('Your repositories')).toBeNull();
    expect(screen.queryByText('acme')).toBeNull();
    expect(screen.queryByText('Other repositories')).toBeNull();
    expect(screen.queryByText('Manual entry')).toBeNull();
    expect(screen.queryByText('No repositories match the current search.')).toBeNull();
  });
});
