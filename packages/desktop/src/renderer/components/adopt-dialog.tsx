import { LoaderCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';

import type { ListIssueItem } from '@dnsquared/shipper-core';

import { Alert, AlertDescription, AlertTitle } from './ui/alert.js';
import { Button } from './ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.js';

interface AdoptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repo: string;
  onAdopted: () => void;
}

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function removeIssue(currentIssues: ListIssueItem[], issueNumber: number): ListIssueItem[] {
  return currentIssues.filter((issue) => issue.number !== issueNumber);
}

export function AdoptDialog({
  open,
  onOpenChange,
  repo,
  onAdopted,
}: AdoptDialogProps): JSX.Element {
  const [issues, setIssues] = useState<ListIssueItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adoptingSet, setAdoptingSet] = useState<Set<number>>(new Set());
  const [bulkAdoptProgress, setBulkAdoptProgress] = useState<{
    processed: number;
    total: number;
  } | null>(null);
  const isBulkAdopting = bulkAdoptProgress !== null;
  const isMountedRef = useRef(true);
  const activeRunIdRef = useRef(0);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  function isRunActive(runId: number): boolean {
    return isMountedRef.current && activeRunIdRef.current === runId;
  }

  useEffect(() => {
    activeRunIdRef.current += 1;
    const runId = activeRunIdRef.current;

    setIssues([]);
    setError(null);
    setAdoptingSet(new Set());
    setBulkAdoptProgress(null);

    let cancelled = false;

    if (!open) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);

    void window.shipperAPI
      .listAdoptableIssues(repo)
      .then((result) => {
        if (cancelled || !isRunActive(runId)) {
          return;
        }

        if (!result.ok) {
          setError(result.error);
          return;
        }

        setIssues(result.issues);
      })
      .catch((fetchError: unknown) => {
        if (!cancelled && isRunActive(runId)) {
          const message = fetchError instanceof Error ? fetchError.message : String(fetchError);
          setError(message);
        }
      })
      .finally(() => {
        if (!cancelled && isRunActive(runId)) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open, repo]);

  async function handleAdoptIssue(issueNumber: number): Promise<boolean> {
    const runId = activeRunIdRef.current;

    setError(null);
    setAdoptingSet((current) => new Set(current).add(issueNumber));

    try {
      const result = await window.shipperAPI.adoptIssue(repo, issueNumber);
      if (!isRunActive(runId)) {
        return false;
      }

      if (!result.ok) {
        setError(result.error);
        return false;
      }

      setIssues((currentIssues) => removeIssue(currentIssues, issueNumber));
      onAdopted();
      return true;
    } catch (adoptError) {
      if (!isRunActive(runId)) {
        return false;
      }

      const message = adoptError instanceof Error ? adoptError.message : String(adoptError);
      setError(message);
      return false;
    } finally {
      if (isRunActive(runId)) {
        setAdoptingSet((current) => {
          const next = new Set(current);
          next.delete(issueNumber);
          return next;
        });
      }
    }
  }

  async function handleAdoptAll(): Promise<void> {
    const issueNumbers = issues.map((issue) => issue.number);
    if (issueNumbers.length === 0) {
      return;
    }

    const runId = activeRunIdRef.current;

    setError(null);
    setBulkAdoptProgress({ processed: 0, total: issueNumbers.length });
    setAdoptingSet(new Set());

    let adoptedCount = 0;
    const failures: string[] = [];

    try {
      for (const issueNumber of issueNumbers) {
        if (!isRunActive(runId)) {
          break;
        }

        try {
          const result = await window.shipperAPI.adoptIssue(repo, issueNumber);
          if (!isRunActive(runId)) {
            break;
          }

          if (!result.ok) {
            failures.push(`#${issueNumber}: ${result.error}`);
            continue;
          }

          adoptedCount += 1;
          setIssues((currentIssues) => removeIssue(currentIssues, issueNumber));
        } catch (adoptError) {
          if (!isRunActive(runId)) {
            break;
          }

          const message = adoptError instanceof Error ? adoptError.message : String(adoptError);
          failures.push(`#${issueNumber}: ${message}`);
        } finally {
          if (isRunActive(runId)) {
            setBulkAdoptProgress((prev) =>
              prev ? { ...prev, processed: prev.processed + 1 } : null
            );
          }
        }
      }

      if (!isRunActive(runId)) {
        return;
      }

      if (adoptedCount > 0) {
        onAdopted();
      }

      if (failures.length > 0) {
        setError(`Failed to adopt ${failures.length} issue(s): ${failures.join(' ')}`);
      }
    } finally {
      if (isRunActive(runId)) {
        setBulkAdoptProgress(null);
      }
    }
  }

  const showEmptyState = !isLoading && error === null && issues.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(80vh,40rem)] w-[min(calc(100vw-2rem),48rem)] grid-rows-[auto_1fr] gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-6 py-5">
          <DialogTitle>Adopt Issues</DialogTitle>
          <DialogDescription>
            Add <code>shipper:new</code> to existing GitHub issues so they enter the Shipper
            workflow.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-col gap-4 px-6 py-4">
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>Could not complete adopt request</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              {isLoading
                ? 'Loading adoptable issues...'
                : issues.length === 1
                  ? '1 adoptable issue'
                  : `${issues.length} adoptable issues`}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void handleAdoptAll();
              }}
              disabled={isLoading || isBulkAdopting || adoptingSet.size > 0 || issues.length === 0}
            >
              {bulkAdoptProgress ? (
                <>
                  <LoaderCircle className="size-4 animate-spin" />
                  Adopting {bulkAdoptProgress.processed}/{bulkAdoptProgress.total}...
                </>
              ) : (
                'Adopt All'
              )}
            </Button>
          </div>

          {isLoading ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" />
              Loading adoptable issues...
            </div>
          ) : null}

          {showEmptyState ? (
            <div className="rounded-sm border border-dashed border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
              All issues are already in the Shipper workflow.
            </div>
          ) : null}

          {!isLoading && issues.length > 0 ? (
            <div className="min-h-0 flex-1 overflow-y-auto rounded-sm border border-border bg-card">
              <ul className="divide-y divide-border">
                {issues.map((issue) => {
                  const isAdopting = adoptingSet.has(issue.number);

                  return (
                    <li
                      key={issue.number}
                      className="flex flex-col gap-3 px-4 py-4 md:flex-row md:items-start md:justify-between"
                    >
                      <div className="min-w-0 space-y-1">
                        <p className="text-sm font-medium text-muted-foreground">#{issue.number}</p>
                        <h3 className="text-sm font-semibold leading-snug text-foreground">
                          {issue.title}
                        </h3>
                        <p className="text-sm text-muted-foreground">
                          {issue.author} • {dateFormatter.format(new Date(issue.createdAt))}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="md:self-center"
                        onClick={() => {
                          void handleAdoptIssue(issue.number);
                        }}
                        disabled={isBulkAdopting || isAdopting}
                      >
                        {isAdopting ? 'Adopting...' : 'Adopt'}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
