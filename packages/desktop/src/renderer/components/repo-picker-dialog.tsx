import { LoaderCircle, PlusCircle, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';

import { toErrorMessage } from '@dnsquared/shipper-core';
import { Alert, AlertDescription, AlertTitle } from './ui/alert.js';
import { Button } from './ui/button.js';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from './ui/command.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.js';
import type {
  RepoPickerRepository,
  RepoPickerSearchRepository,
  RepoPickerSearchResult,
} from '../types.js';

interface RepoPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repos: string[];
  onSelectRepo: (repo: string) => void | Promise<void>;
}

const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const emptySearchPageInfo: RepoPickerSearchResult['pageInfo'] = {
  hasNextPage: false,
  endCursor: null,
};

function toRepoKey(repo: string): string {
  return repo.trim().toLowerCase();
}

function isValidRepo(repo: string): boolean {
  return repoPattern.test(repo);
}

interface OrganizationSection {
  organizationLogin: string;
  repos: OrganizationRepo[];
}

type OrganizationRepo = Extract<RepoPickerRepository, { group: 'organization' }>;

function isOrganizationRepo(repo: RepoPickerRepository): repo is OrganizationRepo {
  return repo.group === 'organization';
}

function mergeSearchRepositories(
  first: RepoPickerSearchRepository[],
  second: RepoPickerSearchRepository[]
): RepoPickerSearchRepository[] {
  const merged: RepoPickerSearchRepository[] = [];
  const seenRepos = new Set<string>();

  for (const repository of [...first, ...second]) {
    const repoKey = toRepoKey(repository.nameWithOwner);
    if (seenRepos.has(repoKey)) {
      continue;
    }

    seenRepos.add(repoKey);
    merged.push(repository);
  }

  return merged;
}

export function RepoPickerDialog({
  open,
  onOpenChange,
  repos,
  onSelectRepo,
}: RepoPickerDialogProps): JSX.Element {
  const [initialRepos, setInitialRepos] = useState<RepoPickerRepository[]>([]);
  const [initialFetchError, setInitialFetchError] = useState<string | null>(null);
  const [isInitialLoading, setIsInitialLoading] = useState(false);
  const [searchRepos, setSearchRepos] = useState<RepoPickerSearchRepository[]>([]);
  const [searchPageInfo, setSearchPageInfo] =
    useState<RepoPickerSearchResult['pageInfo']>(emptySearchPageInfo);
  const [lastSuccessfulSearchQuery, setLastSuccessfulSearchQuery] = useState('');
  const [searchError, setSearchError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [query, setQuery] = useState('');
  const searchRequestIdRef = useRef(0);

  useEffect(() => {
    setInitialRepos([]);
    setInitialFetchError(null);
    setIsInitialLoading(false);
    setSearchRepos([]);
    setSearchPageInfo(emptySearchPageInfo);
    setLastSuccessfulSearchQuery('');
    setSearchError(null);
    setLoadMoreError(null);
    setIsSearching(false);
    setIsLoadingMore(false);
    setQuery('');
    searchRequestIdRef.current += 1;

    let cancelled = false;

    if (!open) {
      return;
    }

    setIsInitialLoading(true);

    void window.shipperAPI
      .listRepos()
      .then((nextRepos) => {
        if (!cancelled) {
          setInitialRepos(nextRepos);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setInitialFetchError(toErrorMessage(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsInitialLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  const normalizedQuery = query.trim();
  const queryKey = toRepoKey(normalizedQuery);
  const mode = normalizedQuery.length === 0 ? 'initial' : 'search';

  const runSearch = useCallback((nextQuery: string) => {
    const requestId = searchRequestIdRef.current + 1;
    searchRequestIdRef.current = requestId;
    setIsSearching(true);
    setSearchError(null);
    setLoadMoreError(null);

    void window.shipperAPI
      .searchRepos({ query: nextQuery, cursor: null })
      .then((result) => {
        if (searchRequestIdRef.current !== requestId) {
          return;
        }

        setSearchRepos(result.repositories);
        setSearchPageInfo(result.pageInfo);
        setLastSuccessfulSearchQuery(nextQuery);
      })
      .catch((error: unknown) => {
        if (searchRequestIdRef.current !== requestId) {
          return;
        }

        setSearchError(toErrorMessage(error));
      })
      .finally(() => {
        if (searchRequestIdRef.current === requestId) {
          setIsSearching(false);
        }
      });
  }, []);

  useEffect(() => {
    if (!open || mode === 'initial') {
      searchRequestIdRef.current += 1;
      setIsSearching(false);
      setIsLoadingMore(false);
      setSearchError(null);
      setLoadMoreError(null);
      return;
    }

    searchRequestIdRef.current += 1;
    setIsSearching(false);
    setIsLoadingMore(false);
    setLoadMoreError(null);

    const timeoutId = window.setTimeout(() => {
      runSearch(normalizedQuery);
    }, 250);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [mode, normalizedQuery, open, runSearch]);

  const handleLoadMore = useCallback(() => {
    if (
      mode !== 'search' ||
      searchPageInfo.endCursor === null ||
      lastSuccessfulSearchQuery.length === 0 ||
      normalizedQuery !== lastSuccessfulSearchQuery ||
      searchError !== null ||
      isLoadingMore
    ) {
      return;
    }

    const requestId = searchRequestIdRef.current;
    const cursor = searchPageInfo.endCursor;
    setIsLoadingMore(true);
    setLoadMoreError(null);

    void window.shipperAPI
      .searchRepos({ query: lastSuccessfulSearchQuery, cursor })
      .then((result) => {
        if (searchRequestIdRef.current !== requestId) {
          return;
        }

        setSearchRepos((currentRepos) =>
          mergeSearchRepositories(currentRepos, result.repositories)
        );
        setSearchPageInfo(result.pageInfo);
      })
      .catch((error: unknown) => {
        if (searchRequestIdRef.current !== requestId) {
          return;
        }

        setLoadMoreError(toErrorMessage(error));
      })
      .finally(() => {
        if (searchRequestIdRef.current === requestId) {
          setIsLoadingMore(false);
        }
      });
  }, [
    isLoadingMore,
    lastSuccessfulSearchQuery,
    mode,
    normalizedQuery,
    searchError,
    searchPageInfo.endCursor,
  ]);

  const configuredRepoKeys = new Set(repos.map((repo) => toRepoKey(repo)));
  const visibleRepos = mode === 'initial' ? initialRepos : searchRepos;
  const filteredRepos = visibleRepos.filter(
    (repo) => !configuredRepoKeys.has(toRepoKey(repo.nameWithOwner))
  );
  const ownerRepos = filteredRepos.filter((repo) => repo.group === 'owner');
  const otherRepos = filteredRepos.filter((repo) => repo.group === 'other');
  const canRenderResults = mode === 'search' || initialFetchError === null;
  const organizationSections =
    mode === 'initial'
      ? Array.from(
          filteredRepos.filter(isOrganizationRepo).reduce((sections, repo) => {
            const existingRepos = sections.get(repo.organizationLogin) ?? [];
            existingRepos.push(repo);
            sections.set(repo.organizationLogin, existingRepos);
            return sections;
          }, new Map<string, OrganizationRepo[]>())
        )
          .map(
            ([organizationLogin, organizationRepos]): OrganizationSection => ({
              organizationLogin,
              repos: organizationRepos,
            })
          )
          .sort((first, second) =>
            first.organizationLogin.localeCompare(second.organizationLogin, undefined, {
              sensitivity: 'base',
            })
          )
      : [];
  const hasOrganizationRepos = organizationSections.length > 0;
  const hasListedRepos = ownerRepos.length > 0 || hasOrganizationRepos || otherRepos.length > 0;
  const showManualAdd =
    normalizedQuery.length > 0 &&
    isValidRepo(normalizedQuery) &&
    !configuredRepoKeys.has(queryKey) &&
    !filteredRepos.some((repo) => toRepoKey(repo.nameWithOwner) === queryKey);
  const showDuplicateManual = normalizedQuery.length > 0 && configuredRepoKeys.has(queryKey);
  const canLoadMoreSearchResults =
    mode === 'search' &&
    searchError === null &&
    normalizedQuery === lastSuccessfulSearchQuery &&
    searchPageInfo.hasNextPage;
  const showEmpty =
    canRenderResults &&
    !isInitialLoading &&
    !isSearching &&
    !isLoadingMore &&
    searchError === null &&
    filteredRepos.length === 0 &&
    !showManualAdd &&
    !showDuplicateManual;

  function handleSelect(repo: string): void {
    void onSelectRepo(repo);
    onOpenChange(false);
  }

  function renderRepoItems(reposToRender: RepoPickerRepository[]): JSX.Element[] {
    return reposToRender.map((repo) => (
      <CommandItem
        key={repo.nameWithOwner}
        value={repo.nameWithOwner}
        onSelect={() => {
          handleSelect(repo.nameWithOwner);
        }}
      >
        <PlusCircle className="size-4 text-muted-foreground" />
        <span>{repo.nameWithOwner}</span>
      </CommandItem>
    ));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0">
        <DialogHeader className="border-b border-border px-6 py-5">
          <DialogTitle>Add repository</DialogTitle>
          <DialogDescription>
            Search your GitHub repositories or type an `owner/repo` value manually.
          </DialogDescription>
        </DialogHeader>

        {mode === 'initial' && initialFetchError !== null ? (
          <div className="px-6 pt-4">
            <Alert variant="destructive">
              <AlertTitle>Could not load repositories</AlertTitle>
              <AlertDescription>{initialFetchError}</AlertDescription>
            </Alert>
          </div>
        ) : null}

        <Command shouldFilter={false}>
          <div className="relative">
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder="Search repositories or type owner/repo"
              className={isSearching ? 'pr-7' : undefined}
            />
            {isSearching ? (
              <LoaderCircle className="absolute top-3 right-4 size-4 animate-spin text-muted-foreground" />
            ) : null}
          </div>
          {mode === 'search' && searchError !== null ? (
            <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2 text-sm">
              <span className="text-destructive">Could not search repositories: {searchError}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  runSearch(normalizedQuery);
                }}
              >
                <RefreshCw className="size-3.5" />
                Retry
              </Button>
            </div>
          ) : null}
          <CommandList className="px-2 py-2">
            {isInitialLoading && mode === 'initial' ? (
              <div className="flex items-center gap-2 px-2 py-6 text-sm text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" />
                Loading repositories...
              </div>
            ) : null}

            {showEmpty ? (
              <CommandEmpty>No repositories match the current search.</CommandEmpty>
            ) : null}

            {canRenderResults && ownerRepos.length > 0 ? (
              <CommandGroup heading="Your repositories">{renderRepoItems(ownerRepos)}</CommandGroup>
            ) : null}

            {canRenderResults
              ? organizationSections.map((section) => (
                  <CommandGroup key={section.organizationLogin} heading={section.organizationLogin}>
                    {renderRepoItems(section.repos)}
                  </CommandGroup>
                ))
              : null}

            {canRenderResults && otherRepos.length > 0 ? (
              <CommandGroup heading="Other repositories">
                {renderRepoItems(otherRepos)}
              </CommandGroup>
            ) : null}

            {canRenderResults && mode === 'search' && isLoadingMore ? (
              <div className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" />
                Loading more repositories...
              </div>
            ) : null}

            {canRenderResults && mode === 'search' && loadMoreError !== null ? (
              <div className="flex items-center justify-between gap-3 px-2 py-3 text-sm">
                <span className="text-destructive">
                  Additional repositories could not be loaded: {loadMoreError}
                </span>
                <Button type="button" variant="outline" size="sm" onClick={handleLoadMore}>
                  <RefreshCw className="size-3.5" />
                  Retry
                </Button>
              </div>
            ) : null}

            {canRenderResults &&
            mode === 'search' &&
            canLoadMoreSearchResults &&
            !isSearching &&
            !isLoadingMore ? (
              <div className="px-2 py-3">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={handleLoadMore}
                >
                  Load more
                </Button>
              </div>
            ) : null}

            {canRenderResults && (showManualAdd || showDuplicateManual) ? (
              <>
                {hasListedRepos ? <CommandSeparator /> : null}
                <CommandGroup heading="Manual entry">
                  {showManualAdd ? (
                    <CommandItem
                      value={`manual:${normalizedQuery}`}
                      onSelect={() => {
                        handleSelect(normalizedQuery);
                      }}
                    >
                      <PlusCircle className="size-4 text-muted-foreground" />
                      <span>Add &quot;{normalizedQuery}&quot;</span>
                    </CommandItem>
                  ) : null}
                  {showDuplicateManual ? (
                    <CommandItem value={`duplicate:${normalizedQuery}`} disabled>
                      <span>{normalizedQuery} is already added</span>
                    </CommandItem>
                  ) : null}
                </CommandGroup>
              </>
            ) : null}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
