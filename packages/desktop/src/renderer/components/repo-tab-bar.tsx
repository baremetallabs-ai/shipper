import { Plus, X } from 'lucide-react';
import type { JSX } from 'react';

import { cn } from '../lib/utils.js';
import { Button } from './ui/button.js';

interface RepoTabBarProps {
  repos: string[];
  activeRepo: string;
  onSelectRepo: (repo: string) => void;
  onCloseRepo: (repo: string) => void;
  onAddRepo: () => void;
}

export function RepoTabBar({
  repos,
  activeRepo,
  onSelectRepo,
  onCloseRepo,
  onAddRepo,
}: RepoTabBarProps): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {repos.map((repo) => {
        const isActive = repo === activeRepo;

        return (
          <div
            key={repo}
            className={cn(
              'flex items-center overflow-hidden rounded-sm border',
              isActive
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-card text-card-foreground'
            )}
          >
            <button
              type="button"
              className="min-w-0 px-3 py-2 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onSelectRepo(repo)}
            >
              <span className="block max-w-52 truncate">{repo}</span>
            </button>
            <button
              type="button"
              className={cn(
                'border-l px-2 py-2 transition-colors',
                isActive
                  ? 'border-primary-foreground/20 hover:bg-primary-foreground/10'
                  : 'border-border hover:bg-accent hover:text-accent-foreground'
              )}
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

      <Button variant="outline" size="sm" onClick={onAddRepo}>
        <Plus className="size-4" />
        Add repo
      </Button>
    </div>
  );
}
