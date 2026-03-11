import { useEffect, useEffectEvent, useState } from 'react';
import type { JSX, KeyboardEvent } from 'react';

import type { ListIssueItem } from '@dnsquared/shipper-core';

import { Alert, AlertDescription, AlertTitle } from './components/ui/alert.js';
import { Badge } from './components/ui/badge.js';
import { Button } from './components/ui/button.js';
import { Input } from './components/ui/input.js';

interface CheckResult {
  ok: boolean;
  message: string;
}

interface Prerequisites {
  ghInstalled: CheckResult;
  ghAuth: CheckResult;
}

const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function isValidRepo(repo: string): boolean {
  return repoPattern.test(repo);
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
  const [repoDraft, setRepoDraft] = useState('');
  const [savedRepo, setSavedRepo] = useState('');
  const [prerequisites, setPrerequisites] = useState<Prerequisites | null>(null);
  const [issues, setIssues] = useState<ListIssueItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const prerequisiteMessage = getPrerequisiteMessage(prerequisites);
  const canFetch = prerequisites !== null && prerequisiteMessage === null;
  const savedRepoIsValid = isValidRepo(savedRepo);

  const loadIssues = useEffectEvent(async (repo: string) => {
    setIsLoading(true);
    setFetchError(null);

    try {
      const result = await window.shipperAPI.listIssues(repo);
      if (!result.ok) {
        setFetchError(result.error);
        return;
      }

      setIssues(result.issues);
      setLastUpdated(new Date());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFetchError(message);
    } finally {
      setIsLoading(false);
    }
  });

  const persistRepo = useEffectEvent(async (rawRepo: string) => {
    const nextRepo = rawRepo.trim();

    if (nextRepo.length > 0 && !isValidRepo(nextRepo)) {
      setValidationError('Enter a repository in owner/repo format.');
      return;
    }

    setValidationError(null);

    try {
      await window.shipperAPI.setConfig({ repo: nextRepo });
      const repoChanged = nextRepo !== savedRepo;
      setSavedRepo(nextRepo);
      setRepoDraft(nextRepo);
      setFetchError(null);

      if (!nextRepo) {
        setIssues([]);
        setLastUpdated(null);
        return;
      }

      if (repoChanged) {
        setIssues([]);
        setLastUpdated(null);
      }

      if (canFetch) {
        await loadIssues(nextRepo);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFetchError(`Failed to save repository: ${message}`);
    }
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
        setRepoDraft(config.repo);
        setSavedRepo(config.repo);

        if (
          prerequisiteResult.ghInstalled.ok &&
          prerequisiteResult.ghAuth.ok &&
          isValidRepo(config.repo)
        ) {
          await loadIssues(config.repo);
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
    };
  }, []);

  useEffect(() => {
    if (!canFetch || !savedRepoIsValid) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void loadIssues(savedRepo);
    }, 60_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [canFetch, savedRepo, savedRepoIsValid]);

  async function handleRefresh(): Promise<void> {
    if (!canFetch || !savedRepoIsValid || isLoading) {
      return;
    }

    await loadIssues(savedRepo);
  }

  async function handleSubmit(): Promise<void> {
    await persistRepo(repoDraft);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      void handleSubmit();
    }
  }

  return (
    <div className="min-h-screen bg-transparent">
      <header className="sticky top-0 z-10 border-b border-border/60 bg-background/90 backdrop-blur-xl">
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
                disabled={!canFetch || !savedRepoIsValid || isLoading}
              >
                {isLoading ? 'Refreshing...' : 'Refresh'}
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-3 md:flex-row md:items-center">
            <div className="flex-1">
              <Input
                value={repoDraft}
                onChange={(event) => {
                  setRepoDraft(event.target.value);
                  if (validationError) {
                    setValidationError(null);
                  }
                }}
                onBlur={() => {
                  void handleSubmit();
                }}
                onKeyDown={handleKeyDown}
                placeholder="owner/repo"
                aria-label="GitHub repository"
              />
            </div>
            <Button
              onClick={() => {
                void handleSubmit();
              }}
            >
              Save Repo
            </Button>
          </div>
          {validationError ? <p className="text-sm text-destructive">{validationError}</p> : null}
        </div>
      </header>

      <main className="mx-auto flex max-w-7xl flex-col gap-4 px-6 py-6">
        {prerequisiteMessage ? (
          <Alert className="border-destructive/40 bg-destructive/5">
            <AlertTitle>GitHub CLI required</AlertTitle>
            <AlertDescription>{prerequisiteMessage}</AlertDescription>
          </Alert>
        ) : null}

        {fetchError ? (
          <Alert className="border-destructive/40 bg-destructive/5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <AlertTitle>Issue fetch failed</AlertTitle>
                <AlertDescription>{fetchError}</AlertDescription>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setFetchError(null);
                }}
              >
                Dismiss
              </Button>
            </div>
          </Alert>
        ) : null}

        <section className="overflow-hidden rounded-3xl border border-border/70 bg-card/80 shadow-[0_20px_60px_-30px_rgba(15,23,42,0.35)] backdrop-blur-sm">
          <div className="border-b border-border/70 px-6 py-4">
            <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="text-lg font-semibold">Shipper-labeled issues</h2>
                <p className="text-sm text-muted-foreground">
                  Showing read-only issue metadata from the saved repository.
                </p>
              </div>
              {savedRepo ? (
                <Badge variant="outline" className="w-fit">
                  {savedRepo}
                </Badge>
              ) : null}
            </div>
          </div>

          {!savedRepo ? (
            <div className="px-6 py-10 text-sm text-muted-foreground">
              Save a repository above to load its shipper-labeled issues.
            </div>
          ) : !savedRepoIsValid ? (
            <div className="px-6 py-10 text-sm text-muted-foreground">
              Enter a valid repository in owner/repo format to begin.
            </div>
          ) : issues.length === 0 && !isLoading ? (
            <div className="px-6 py-10 text-sm text-muted-foreground">
              No shipper-labeled issues found for this repository.
            </div>
          ) : (
            <div className="divide-y divide-border/60">
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
      </main>
    </div>
  );
}
