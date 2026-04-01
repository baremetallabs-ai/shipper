import { Plus, X } from 'lucide-react';
import type { JSX } from 'react';

import { cn } from '../lib/utils.js';
import { Button } from './ui/button.js';

interface RepoTabBarProps {
  repos: string[];
  activeRepo: string;
  activeCommandRepos: ReadonlySet<string>;
  onSelectRepo: (repo: string) => void;
  onCloseRepo: (repo: string) => void;
  onAddRepo: () => void;
}

export function RepoTabBar({
  repos,
  activeRepo,
  activeCommandRepos,
  onSelectRepo,
  onCloseRepo,
  onAddRepo,
}: RepoTabBarProps): JSX.Element {
  return (
    <div className="bg-muted shadow-[inset_0_-1px_0_0_var(--color-border)]">
      <div className="mx-auto flex max-w-7xl items-end gap-1 overflow-x-auto px-6 pt-2">
        {repos.map((repo) => {
          const isActive = repo === activeRepo;
          const hasActiveCommands = activeCommandRepos.has(repo);

          return (
            <div
              key={repo}
              className={cn(
                isActive
                  ? 'relative z-10 flex shrink-0 items-center rounded-t-md border border-border border-b-background bg-background text-foreground'
                  : 'flex shrink-0 items-center rounded-t-md text-muted-foreground transition-colors hover:bg-background/50'
              )}
            >
              <button
                type="button"
                className="cursor-pointer flex min-w-0 items-center gap-2 px-3 py-2 text-sm font-medium outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={hasActiveCommands ? `${repo} (active background work)` : repo}
                onClick={() => {
                  onSelectRepo(repo);
                }}
              >
                {hasActiveCommands ? (
                  <span className="size-2 shrink-0 rounded-full bg-primary" aria-hidden="true" />
                ) : null}
                <span className="block max-w-52 truncate">{repo}</span>
              </button>
              <button
                type="button"
                className="cursor-pointer rounded-sm px-1.5 py-2 opacity-60 transition-colors hover:opacity-100 hover:bg-foreground/10"
                aria-label={`Remove ${repo}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseRepo(repo);
                }}
              >
                <X className="size-4" />
              </button>
            </div>
          );
        })}

        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 border-transparent text-muted-foreground hover:text-foreground"
          onClick={onAddRepo}
        >
          <Plus className="size-4" />
          Add repo
        </Button>
      </div>
    </div>
  );
}
