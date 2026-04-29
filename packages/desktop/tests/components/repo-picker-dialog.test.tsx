// @vitest-environment jsdom

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RepoPickerDialog } from '../../src/renderer/components/repo-picker-dialog.js';
import type { RepoPickerRepository, RepoPickerSearchResult } from '../../src/renderer/types.js';

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

const emptySearchResult: RepoPickerSearchResult = {
  repositories: [],
  pageInfo: { hasNextPage: false, endCursor: null },
};

function installShipperApi({
  repos,
  searchRepos = vi.fn().mockResolvedValue(emptySearchResult),
}: {
  repos: RepoPickerRepository[];
  searchRepos?: ReturnType<typeof vi.fn>;
}): { listRepos: ReturnType<typeof vi.fn>; searchRepos: ReturnType<typeof vi.fn> } {
  const listRepos = vi.fn().mockResolvedValue(repos);

  Object.defineProperty(globalThis.window, 'shipperAPI', {
    configurable: true,
    value: {
      listRepos,
      searchRepos,
    },
  });

  return { listRepos, searchRepos };
}

function installRejectedShipperApi(error: unknown): void {
  Object.defineProperty(globalThis.window, 'shipperAPI', {
    configurable: true,
    value: {
      listRepos: vi.fn().mockRejectedValue(error),
      searchRepos: vi.fn().mockResolvedValue(emptySearchResult),
    },
  });
}

function renderDialog({
  repos,
  configuredRepos = [],
  onSelectRepo = vi.fn(),
  searchRepos,
}: {
  repos: RepoPickerRepository[];
  configuredRepos?: string[];
  onSelectRepo?: (repo: string) => void;
  searchRepos?: ReturnType<typeof vi.fn>;
}): ReturnType<typeof render> & {
  listRepos: ReturnType<typeof vi.fn>;
  searchRepos: ReturnType<typeof vi.fn>;
  onSelectRepo: (repo: string) => void;
} {
  const shipperApi = installShipperApi({ repos, searchRepos });

  const result = render(
    <RepoPickerDialog
      open
      onOpenChange={vi.fn()}
      repos={configuredRepos}
      onSelectRepo={onSelectRepo}
    />
  );

  return { ...result, ...shipperApi, onSelectRepo };
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

function input() {
  return screen.getByPlaceholderText('Search repositories or type owner/repo');
}

async function advanceDebounce(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 260);
    });
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
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

  it('filters configured repositories from every no-query group case-insensitively', async () => {
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

  it('runs a debounced server search and omits organization headings in search mode', async () => {
    const searchRepos = vi.fn().mockResolvedValue({
      repositories: [
        { nameWithOwner: 'octocat/acme', group: 'owner' },
        { nameWithOwner: 'acme/api', group: 'other' },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    });
    renderDialog({
      repos: [
        {
          nameWithOwner: 'acme/service',
          group: 'organization',
          organizationLogin: 'acme',
        },
      ],
      searchRepos,
    });

    await screen.findByText('acme/service');
    fireEvent.change(input(), { target: { value: 'acme' } });

    expect(searchRepos).not.toHaveBeenCalled();
    await advanceDebounce();

    await waitFor(() => {
      expect(searchRepos).toHaveBeenCalledWith({ query: 'acme', cursor: null });
    });
    expect(await screen.findByText('octocat/acme')).toBeTruthy();
    expect(screen.getByText('acme/api')).toBeTruthy();
    expect(screen.queryByText('acme/service')).toBeNull();
    expect(screen.queryByText('acme')).toBeNull();
  });

  it('groups search results under only owner and other sections', async () => {
    const searchRepos = vi.fn().mockResolvedValue({
      repositories: [
        { nameWithOwner: 'octocat/personal-match', group: 'owner' },
        { nameWithOwner: 'acme/org-match', group: 'other' },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    });
    renderDialog({ repos: [], searchRepos });

    fireEvent.change(input(), { target: { value: 'match' } });
    await advanceDebounce();

    expect(await screen.findByText('Your repositories')).toBeTruthy();
    expect(screen.getByText('Other repositories')).toBeTruthy();
    expect(screen.getByText('octocat/personal-match')).toBeTruthy();
    expect(screen.getByText('acme/org-match')).toBeTruthy();
    expect(screen.queryByText('acme')).toBeNull();
  });

  it('ignores stale slower search responses after a newer query succeeds', async () => {
    const firstSearch = deferred<RepoPickerSearchResult>();
    const secondSearch = deferred<RepoPickerSearchResult>();
    const searchRepos = vi
      .fn()
      .mockReturnValueOnce(firstSearch.promise)
      .mockReturnValueOnce(secondSearch.promise);
    renderDialog({ repos: [], searchRepos });

    fireEvent.change(input(), { target: { value: 'old' } });
    await advanceDebounce();
    fireEvent.change(input(), { target: { value: 'new' } });
    await advanceDebounce();

    act(() => {
      secondSearch.resolve({
        repositories: [{ nameWithOwner: 'octocat/new-result', group: 'owner' }],
        pageInfo: { hasNextPage: false, endCursor: null },
      });
    });
    expect(await screen.findByText('octocat/new-result')).toBeTruthy();

    act(() => {
      firstSearch.resolve({
        repositories: [{ nameWithOwner: 'octocat/old-result', group: 'owner' }],
        pageInfo: { hasNextPage: false, endCursor: null },
      });
    });
    expect(screen.queryByText('octocat/old-result')).toBeNull();
    expect(screen.getByText('octocat/new-result')).toBeTruthy();
  });

  it('keeps prior search results visible while a later search is loading', async () => {
    const pendingSearch = deferred<RepoPickerSearchResult>();
    const searchRepos = vi
      .fn()
      .mockResolvedValueOnce({
        repositories: [{ nameWithOwner: 'octocat/previous', group: 'owner' }],
        pageInfo: { hasNextPage: false, endCursor: null },
      })
      .mockReturnValueOnce(pendingSearch.promise);
    renderDialog({ repos: [], searchRepos });

    fireEvent.change(input(), { target: { value: 'previous' } });
    await advanceDebounce();
    expect(await screen.findByText('octocat/previous')).toBeTruthy();

    fireEvent.change(input(), { target: { value: 'pending' } });
    await advanceDebounce();

    expect(screen.getByText('octocat/previous')).toBeTruthy();
    // The desktop test tsconfig is Node-based, but this file runs under jsdom.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    expect(screen.getByRole('dialog').querySelector('.animate-spin')).not.toBeNull();
  });

  it('keeps prior search results visible on search failure and retries current query', async () => {
    const searchRepos = vi
      .fn()
      .mockResolvedValueOnce({
        repositories: [{ nameWithOwner: 'octocat/previous', group: 'owner' }],
        pageInfo: { hasNextPage: false, endCursor: null },
      })
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValueOnce({
        repositories: [{ nameWithOwner: 'octocat/retry', group: 'owner' }],
        pageInfo: { hasNextPage: false, endCursor: null },
      });
    renderDialog({ repos: [], searchRepos });

    fireEvent.change(input(), { target: { value: 'previous' } });
    await advanceDebounce();
    expect(await screen.findByText('octocat/previous')).toBeTruthy();

    fireEvent.change(input(), { target: { value: 'retry' } });
    await advanceDebounce();

    expect(await screen.findByText(/Could not search repositories: rate limited/)).toBeTruthy();
    expect(screen.getByText('octocat/previous')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => {
      expect(searchRepos).toHaveBeenLastCalledWith({ query: 'retry', cursor: null });
    });
    expect(await screen.findByText('octocat/retry')).toBeTruthy();
  });

  it('loads more, appends de-duplicated results, and retries failed pages with the same cursor', async () => {
    const searchRepos = vi
      .fn()
      .mockResolvedValueOnce({
        repositories: [{ nameWithOwner: 'octocat/first', group: 'owner' }],
        pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
      })
      .mockRejectedValueOnce(new Error('next page failed'))
      .mockResolvedValueOnce({
        repositories: [
          { nameWithOwner: 'octocat/first', group: 'owner' },
          { nameWithOwner: 'octocat/second', group: 'owner' },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      });
    renderDialog({ repos: [], searchRepos });

    fireEvent.change(input(), { target: { value: 'octo' } });
    await advanceDebounce();
    expect(await screen.findByText('octocat/first')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    expect(await screen.findByText(/Additional repositories could not be loaded/)).toBeTruthy();
    expect(screen.getByText('octocat/first')).toBeTruthy();
    expect(searchRepos).toHaveBeenLastCalledWith({ query: 'octo', cursor: 'cursor-1' });

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => {
      expect(screen.getByText('octocat/second')).toBeTruthy();
    });
    expect(screen.getAllByText('octocat/first')).toHaveLength(1);
    expect(searchRepos).toHaveBeenLastCalledWith({ query: 'octo', cursor: 'cursor-1' });
  });

  it('clearing the input returns to the no-query layout without refetching the initial list', async () => {
    const { listRepos } = renderDialog({
      repos: [
        {
          nameWithOwner: 'acme/service',
          group: 'organization',
          organizationLogin: 'acme',
        },
      ],
      searchRepos: vi.fn().mockResolvedValue({
        repositories: [{ nameWithOwner: 'octocat/search', group: 'owner' }],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    });

    expect(await screen.findByText('acme/service')).toBeTruthy();
    fireEvent.change(input(), { target: { value: 'search' } });
    await advanceDebounce();
    expect(await screen.findByText('octocat/search')).toBeTruthy();

    fireEvent.change(input(), { target: { value: '' } });

    expect(await screen.findByText('acme')).toBeTruthy();
    expect(screen.getByText('acme/service')).toBeTruthy();
    expect(listRepos).toHaveBeenCalledTimes(1);
  });

  it('keeps manual entry available during a search error for absent repositories', async () => {
    const onSelectRepo = vi.fn();
    renderDialog({
      repos: [],
      searchRepos: vi.fn().mockRejectedValue(new Error('GitHub failed')),
      onSelectRepo,
    });

    fireEvent.change(input(), { target: { value: 'someone-else/foo' } });
    await advanceDebounce();

    expect(await screen.findByText(/Could not search repositories/)).toBeTruthy();
    expect(screen.getByText('Manual entry')).toBeTruthy();
    fireEvent.click(screen.getByText('Add "someone-else/foo"'));

    expect(onSelectRepo).toHaveBeenCalledWith('someone-else/foo');
  });

  it('keeps duplicate manual-entry feedback in search mode', async () => {
    renderDialog({
      configuredRepos: ['octocat/personal'],
      repos: [],
    });

    fireEvent.change(input(), { target: { value: 'OCTOCAT/PERSONAL' } });
    await advanceDebounce();

    expect(await screen.findByText('Manual entry')).toBeTruthy();
    expect(screen.getByText('OCTOCAT/PERSONAL is already added')).toBeTruthy();
    expect(screen.queryByText('Add "OCTOCAT/PERSONAL"')).toBeNull();
  });

  it('filters configured repositories from search results case-insensitively', async () => {
    renderDialog({
      configuredRepos: ['OCTOCAT/HIDDEN'],
      repos: [],
      searchRepos: vi.fn().mockResolvedValue({
        repositories: [
          { nameWithOwner: 'octocat/hidden', group: 'owner' },
          { nameWithOwner: 'octocat/visible', group: 'owner' },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    });

    fireEvent.change(input(), { target: { value: 'octocat' } });
    await advanceDebounce();

    expect(await screen.findByText('octocat/visible')).toBeTruthy();
    expect(screen.queryByText('octocat/hidden')).toBeNull();
  });

  it('renders a single initial error banner without result, manual, or empty groups', async () => {
    renderRejectedDialog();

    expect(await screen.findByText('Could not load repositories')).toBeTruthy();
    expect(screen.getByText('GitHub failed')).toBeTruthy();
    expect(screen.queryByText('Your repositories')).toBeNull();
    expect(screen.queryByText('acme')).toBeNull();
    expect(screen.queryByText('Other repositories')).toBeNull();
    expect(screen.queryByText('Manual entry')).toBeNull();
    expect(screen.queryByText('No repositories match the current search.')).toBeNull();
  });
});
