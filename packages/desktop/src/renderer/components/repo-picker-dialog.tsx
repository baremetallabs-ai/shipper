import { LoaderCircle, PlusCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { JSX } from 'react';

import { Alert, AlertDescription, AlertTitle } from './ui/alert.js';
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

interface RepoPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repos: string[];
  onSelectRepo: (repo: string) => void | Promise<void>;
}

const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function toRepoKey(repo: string): string {
  return repo.trim().toLowerCase();
}

function isValidRepo(repo: string): boolean {
  return repoPattern.test(repo);
}

export function RepoPickerDialog({
  open,
  onOpenChange,
  repos,
  onSelectRepo,
}: RepoPickerDialogProps): JSX.Element {
  const [availableRepos, setAvailableRepos] = useState<string[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    setAvailableRepos([]);
    setFetchError(null);
    setQuery('');

    let cancelled = false;

    if (!open) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);

    void window.shipperAPI
      .listRepos()
      .then((nextRepos) => {
        if (!cancelled) {
          setAvailableRepos(nextRepos);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : String(error);
          setFetchError(message);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  const normalizedQuery = query.trim();
  const queryKey = toRepoKey(normalizedQuery);
  const configuredRepoKeys = new Set(repos.map((repo) => toRepoKey(repo)));
  const filteredRepos = availableRepos.filter((repo) => {
    if (configuredRepoKeys.has(toRepoKey(repo))) {
      return false;
    }

    if (!queryKey) {
      return true;
    }

    return toRepoKey(repo).includes(queryKey);
  });
  const showManualAdd =
    normalizedQuery.length > 0 &&
    isValidRepo(normalizedQuery) &&
    !configuredRepoKeys.has(queryKey) &&
    !filteredRepos.some((repo) => toRepoKey(repo) === queryKey);
  const showDuplicateManual = normalizedQuery.length > 0 && configuredRepoKeys.has(queryKey);
  const showEmpty =
    !isLoading && filteredRepos.length === 0 && !showManualAdd && !showDuplicateManual;

  function handleSelect(repo: string): void {
    void onSelectRepo(repo);
    onOpenChange(false);
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

        {fetchError ? (
          <div className="px-6 pt-4">
            <Alert variant="destructive">
              <AlertTitle>Could not load repositories</AlertTitle>
              <AlertDescription>{fetchError}</AlertDescription>
            </Alert>
          </div>
        ) : null}

        <Command shouldFilter={false}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Search repositories or type owner/repo"
          />
          <CommandList className="px-2 py-2">
            {isLoading ? (
              <div className="flex items-center gap-2 px-2 py-6 text-sm text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" />
                Loading repositories...
              </div>
            ) : null}

            {showEmpty ? (
              <CommandEmpty>No repositories match the current search.</CommandEmpty>
            ) : null}

            {filteredRepos.length > 0 ? (
              <CommandGroup heading="Your repositories">
                {filteredRepos.map((repo) => (
                  <CommandItem
                    key={repo}
                    value={repo}
                    onSelect={() => {
                      handleSelect(repo);
                    }}
                  >
                    <PlusCircle className="size-4 text-muted-foreground" />
                    <span>{repo}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}

            {showManualAdd || showDuplicateManual ? (
              <>
                {filteredRepos.length > 0 ? <CommandSeparator /> : null}
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
