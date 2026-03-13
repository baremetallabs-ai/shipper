import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { JSX } from 'react';

import type { ListIssueItem } from '@dnsquared/shipper-core';

import { RepoPickerDialog } from './components/repo-picker-dialog.js';
import { RepoTabBar } from './components/repo-tab-bar.js';
import { Alert, AlertDescription, AlertTitle } from './components/ui/alert.js';
import { Badge } from './components/ui/badge.js';
import { Button } from './components/ui/button.js';

interface CheckResult {
  ok: boolean;
  message: string;
}

interface Prerequisites {
  ghInstalled: CheckResult;
  ghAuth: CheckResult;
}

interface AppConfig {
  repos: string[];
  activeRepo: string;
}

const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function isValidRepo(repo: string): boolean {
  return repoPattern.test(repo);
}

function toRepoKey(repo: string): string {
  return repo.trim().toLowerCase();
}

function formatIssueDate(createdAt: string): string {
  const parsed = new Date(createdAt);
  return Number.isNaN(parsed.getTime()) ? createdAt : dateFormatter.format(parsed);
}

function getPrerequisiteMessage(prerequisites: Prerequisites | null): string | null {
  if (!prerequisites) {
    return null;
  }

  if (!prerequisites.ghInstalled.ok) {
    return prerequisites.ghInstalled.message;
  }

  if (!prerequisites.ghAuth.ok) {
    return prerequisites.ghAuth.message;
  }

  return null;
}

function getStateVariant(state: string): 'default' | 'outline' | 'success' {
  return state.toLowerCase() === 'open' ? 'success' : 'outline';
}

export default function App(): JSX.Element {
  const [repos, setRepos] = useState<string[]>([]);
  const [activeRepo, setActiveRepo] = useState('');
  const [prerequisites, setPrerequisites] = useState<Prerequisites | null>(null);
  const [issues, setIssues] = useState<ListIssueItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const requestVersionRef = useRef(0);

  const prerequisiteMessage = getPrerequisiteMessage(prerequisites);
  const canFetch = prerequisites !== null && prerequisiteMessage === null;
  const hasActiveRepo = activeRepo.length > 0 && isValidRepo(activeRepo);

  function clearIssueState(): void {
    requestVersionRef.current += 1;
    setIssues([]);
    setLastUpdated(null);
    setFetchError(null);
    setIsLoading(false);
  }

  const loadIssues = useEffectEvent(async (repo: string) => {
    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    setIsLoading(true);
    setFetchError(null);

    try {
      const result = await window.shipperAPI.listIssues(repo);
      if (requestVersion !== requestVersionRef.current) {
        return;
      }

      if (!result.ok) {
        setFetchError(result.error);
        return;
      }

      setIssues(result.issues);
      setLastUpdated(new Date());
    } catch (error) {
      if (requestVersion !== requestVersionRef.current) {
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      setFetchError(message);
    } finally {
      if (requestVersion === requestVersionRef.current) {
        setIsLoading(false);
      }
    }
  });

  const persistConfig = useEffectEvent(async (config: AppConfig) => {
    await window.shipperAPI.setConfig(config);
  });

  useEffect(() => {
    let cancelled = false;

    async function initialize(): Promise<void> {
      try {
        const [prerequisiteResult, config] = await Promise.all([
          window.shipperAPI.checkPrerequisites(),
          window.shipperAPI.getConfig(),
        ]);

        if (cancelled) {
          return;
        }

        setPrerequisites(prerequisiteResult);
        setRepos(config.repos);
        setActiveRepo(config.activeRepo);

        if (
          prerequisiteResult.ghInstalled.ok &&
          prerequisiteResult.ghAuth.ok &&
          config.activeRepo.length > 0
        ) {
          await loadIssues(config.activeRepo);
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : String(error);
          setFetchError(`Failed to initialize desktop app: ${message}`);
        }
      }
    }

    void initialize();

    return () => {
      cancelled = true;
      requestVersionRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!canFetch || !hasActiveRepo) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void loadIssues(activeRepo);
    }, 60_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [activeRepo, canFetch, hasActiveRepo]);

  async function handleRefresh(): Promise<void> {
    if (!canFetch || !hasActiveRepo || isLoading) {
      return;
    }

    await loadIssues(activeRepo);
  }

  async function handleAddRepo(repo: string): Promise<void> {
    const nextRepo = repo.trim();
    if (
      !isValidRepo(nextRepo) ||
      repos.some((currentRepo) => toRepoKey(currentRepo) === toRepoKey(nextRepo))
    ) {
      return;
    }

    const nextRepos = [...repos, nextRepo];

    try {
      await persistConfig({ repos: nextRepos, activeRepo: nextRepo });
      setRepos(nextRepos);
      setActiveRepo(nextRepo);
      clearIssueState();

      if (canFetch) {
        await loadIssues(nextRepo);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFetchError(`Failed to save repositories: ${message}`);
    }
  }

  async function handleSwitchRepo(repo: string): Promise<void> {
    if (repo === activeRepo) {
      return;
    }

    try {
      await persistConfig({ repos, activeRepo: repo });
      setActiveRepo(repo);
      clearIssueState();

      if (canFetch) {
        await loadIssues(repo);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFetchError(`Failed to save repositories: ${message}`);
    }
  }

  async function handleCloseRepo(repo: string): Promise<void> {
    const index = repos.findIndex((currentRepo) => currentRepo === repo);
    if (index < 0) {
      return;
    }

    const nextRepos = repos.filter((currentRepo) => currentRepo !== repo);
    const nextActiveRepo =
      repo === activeRepo ? (nextRepos[index] ?? nextRepos.at(-1) ?? '') : activeRepo;

    try {
      await persistConfig({ repos: nextRepos, activeRepo: nextActiveRepo });
      setRepos(nextRepos);
      setActiveRepo(nextActiveRepo);

      if (repo === activeRepo) {
        clearIssueState();

        if (canFetch && nextActiveRepo) {
          await loadIssues(nextActiveRepo);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFetchError(`Failed to save repositories: ${message}`);
    }
  }

  return (
    <div className="min-h-screen bg-transparent">
      <RepoPickerDialog
        open={isPickerOpen}
        onOpenChange={setIsPickerOpen}
        repos={repos}
        onSelectRepo={handleAddRepo}
      />

      <header className="sticky top-0 z-10 border-b border-border bg-background">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-6 py-5">
          <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">
                Shipper Desktop
              </p>
              <h1 className="text-2xl font-semibold tracking-tight">Issue inbox</h1>
            </div>
            <div className="flex items-center gap-3">
              {lastUpdated ? (
                <p className="text-sm text-muted-foreground">
                  Last updated {dateFormatter.format(lastUpdated)}
                </p>
              ) : null}
              <Button
                variant="outline"
                onClick={() => {
                  void handleRefresh();
                }}
                disabled={!canFetch || !hasActiveRepo || isLoading}
              >
                {isLoading ? 'Refreshing...' : 'Refresh'}
              </Button>
            </div>
          </div>

          {repos.length > 0 ? (
            <RepoTabBar
              repos={repos}
              activeRepo={activeRepo}
              onSelectRepo={(repo) => {
                void handleSwitchRepo(repo);
              }}
              onCloseRepo={(repo) => {
                void handleCloseRepo(repo);
              }}
              onAddRepo={() => {
                setIsPickerOpen(true);
              }}
            />
          ) : null}
        </div>
      </header>

      <main className="mx-auto flex max-w-7xl flex-col gap-4 px-6 py-6">
        {prerequisiteMessage ? (
          <Alert variant="destructive">
            <AlertTitle>GitHub CLI required</AlertTitle>
            <AlertDescription>{prerequisiteMessage}</AlertDescription>
          </Alert>
        ) : null}

        {fetchError ? (
          <Alert variant="destructive" className="pr-24">
            <AlertTitle>Issue fetch failed</AlertTitle>
            <AlertDescription>{fetchError}</AlertDescription>
            <Button
              variant="ghost"
              size="sm"
              className="absolute top-2 right-2"
              onClick={() => {
                setFetchError(null);
              }}
            >
              Dismiss
            </Button>
          </Alert>
        ) : null}

        {repos.length === 0 ? (
          <section className="flex min-h-[24rem] flex-col items-center justify-center rounded-sm border border-dashed border-border bg-card px-6 py-10 text-center">
            <div className="max-w-md space-y-3">
              <h2 className="text-xl font-semibold tracking-tight">
                Add a repository to get started
              </h2>
              <p className="text-sm text-muted-foreground">
                Choose a GitHub repository to load its shipper-labeled issues into the desktop
                inbox.
              </p>
              <Button
                onClick={() => {
                  setIsPickerOpen(true);
                }}
              >
                Add repository
              </Button>
            </div>
          </section>
        ) : (
          <section className="overflow-hidden rounded-sm border border-border bg-card">
            <div className="border-b border-border px-6 py-4">
              <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                <div>
                  <h2 className="text-lg font-semibold">Shipper-labeled issues</h2>
                  <p className="text-sm text-muted-foreground">
                    Showing read-only issue metadata from the active repository.
                  </p>
                </div>
                {activeRepo ? (
                  <Badge variant="outline" className="w-fit">
                    {activeRepo}
                  </Badge>
                ) : null}
              </div>
            </div>

            {!hasActiveRepo ? (
              <div className="px-6 py-10 text-sm text-muted-foreground">
                Select a repository tab to begin.
              </div>
            ) : issues.length === 0 && !isLoading ? (
              <div className="px-6 py-10 text-sm text-muted-foreground">
                No shipper-labeled issues found for this repository.
              </div>
            ) : (
              <div className="divide-y divide-border">
                {issues.map((issue) => (
                  <article
                    key={issue.number}
                    className="grid gap-4 px-6 py-5 md:grid-cols-[1fr_auto]"
                  >
                    <div className="space-y-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={getStateVariant(issue.state)}>{issue.state}</Badge>
                        <span className="text-sm font-medium text-muted-foreground">
                          #{issue.number}
                        </span>
                        <span className="text-sm text-muted-foreground">
                          opened by {issue.author}
                        </span>
                      </div>
                      <div>
                        <h3 className="text-base font-semibold leading-tight text-foreground">
                          {issue.title}
                        </h3>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {issue.labels.map((label) => (
                          <Badge key={label} variant="outline">
                            {label}
                          </Badge>
                        ))}
                      </div>
                    </div>
                    <div className="text-sm text-muted-foreground md:text-right">
                      Created {formatIssueDate(issue.createdAt)}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
