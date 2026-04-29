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

function getDialogText(): string {
  // The desktop test tsconfig is Node-based, but this file runs under jsdom.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return screen.getByRole('dialog').textContent ?? '';
}

function expectTextBefore(first: string, second: string): void {
  const text = getDialogText();
  const firstIndex = text.indexOf(first);
  const secondIndex = text.indexOf(second);

  expect(firstIndex).toBeGreaterThanOrEqual(0);
  expect(secondIndex).toBeGreaterThanOrEqual(0);
  expect(firstIndex).toBeLessThan(secondIndex);
}

describe('RepoPickerDialog', () => {
  it('renders owner and other repositories in grouped returned order', async () => {
    renderDialog({
      repos: [
        { nameWithOwner: 'octocat/personal-new', group: 'owner' },
        { nameWithOwner: 'acme/org-new', group: 'other' },
        { nameWithOwner: 'octocat/personal-old', group: 'owner' },
        { nameWithOwner: 'someone-else/foo', group: 'other' },
      ],
    });

    expect(await screen.findByText('Your repositories')).toBeTruthy();
    expect(screen.getByText('Other repositories')).toBeTruthy();
    expectTextBefore('Your repositories', 'Other repositories');
    expectTextBefore('Your repositories', 'octocat/personal-new');
    expectTextBefore('octocat/personal-new', 'octocat/personal-old');
    expectTextBefore('octocat/personal-old', 'Other repositories');
    expectTextBefore('Other repositories', 'acme/org-new');
    expectTextBefore('acme/org-new', 'someone-else/foo');
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

  it('filters configured repositories from both groups case-insensitively', async () => {
    renderDialog({
      configuredRepos: ['OCTOCAT/PERSONAL', 'ACME/ORG-REPO'],
      repos: [
        { nameWithOwner: 'octocat/personal', group: 'owner' },
        { nameWithOwner: 'octocat/visible', group: 'owner' },
        { nameWithOwner: 'acme/org-repo', group: 'other' },
        { nameWithOwner: 'someone-else/foo', group: 'other' },
      ],
    });

    expect(await screen.findByText('octocat/visible')).toBeTruthy();
    expect(screen.getByText('someone-else/foo')).toBeTruthy();
    expect(screen.queryByText('octocat/personal')).toBeNull();
    expect(screen.queryByText('acme/org-repo')).toBeNull();
  });

  it('keeps manual entry available for valid repositories absent from listed results', async () => {
    const onSelectRepo = vi.fn();
    renderDialog({
      repos: [{ nameWithOwner: 'octocat/personal', group: 'owner' }],
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
      repos: [{ nameWithOwner: 'acme/org-repo', group: 'other' }],
    });

    await screen.findByText('acme/org-repo');
    fireEvent.change(screen.getByPlaceholderText('Search repositories or type owner/repo'), {
      target: { value: 'OCTOCAT/PERSONAL' },
    });

    expect(await screen.findByText('Manual entry')).toBeTruthy();
    expect(screen.getByText('OCTOCAT/PERSONAL is already added')).toBeTruthy();
    expect(screen.queryByText('Add "OCTOCAT/PERSONAL"')).toBeNull();
  });
});
