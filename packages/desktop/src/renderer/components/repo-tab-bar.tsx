import { Plus, X } from 'lucide-react';
import { useState, type DragEvent, type JSX } from 'react';

import { cn } from '../lib/utils.js';
import { Button } from './ui/button.js';

interface RepoTabBarProps {
  repos: string[];
  activeRepo: string;
  activeCommandRepos: ReadonlySet<string>;
  onSelectRepo: (repo: string) => void;
  onCloseRepo: (repo: string) => void;
  onAddRepo: () => void;
  onReorderRepos: (repos: string[]) => void;
}

export function RepoTabBar({
  repos,
  activeRepo,
  activeCommandRepos,
  onSelectRepo,
  onCloseRepo,
  onAddRepo,
  onReorderRepos,
}: RepoTabBarProps): JSX.Element {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  function clearDragState(): void {
    setDragIndex(null);
    setDropIndex(null);
  }

  function handleDragStart(event: DragEvent<HTMLDivElement>, index: number, repo: string): void {
    if (repos.length <= 1) {
      return;
    }

    setDragIndex(index);
    setDropIndex(null);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', repo);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>, index: number): void {
    if (dragIndex === null) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';

    const { left, width } = event.currentTarget.getBoundingClientRect();
    const nextDropIndex = event.clientX < left + width / 2 ? index : index + 1;

    if (nextDropIndex === dragIndex || nextDropIndex === dragIndex + 1) {
      setDropIndex(null);
      return;
    }

    setDropIndex(nextDropIndex);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();

    if (dragIndex === null || dropIndex === null) {
      clearDragState();
      return;
    }

    const nextRepos = [...repos];
    const [draggedRepo] = nextRepos.splice(dragIndex, 1);
    if (!draggedRepo) {
      clearDragState();
      return;
    }

    const adjustedDropIndex = dropIndex > dragIndex ? dropIndex - 1 : dropIndex;
    nextRepos.splice(adjustedDropIndex, 0, draggedRepo);

    if (nextRepos.some((repo, index) => repo !== repos[index])) {
      onReorderRepos(nextRepos);
    }

    clearDragState();
  }

  return (
    <div className="bg-muted shadow-[inset_0_-1px_0_0_var(--color-border)]">
      <div className="mx-auto flex max-w-7xl items-end gap-1 overflow-x-auto px-6 pt-2">
        {repos.map((repo, index) => {
          const isActive = repo === activeRepo;
          const hasActiveCommands = activeCommandRepos.has(repo);
          const isDragged = dragIndex === index;
          const showBeforeIndicator = dropIndex === index;
          const showAfterIndicator = dropIndex === index + 1;

          return (
            <div
              key={repo}
              draggable={repos.length > 1}
              onDragStart={(event) => {
                handleDragStart(event, index, repo);
              }}
              onDragOver={(event) => {
                handleDragOver(event, index);
              }}
              onDrop={handleDrop}
              onDragEnd={clearDragState}
              className={cn(
                'relative flex shrink-0 items-center rounded-t-md',
                isActive
                  ? 'z-10 border border-border border-b-background bg-background text-foreground'
                  : 'text-muted-foreground transition-colors hover:bg-background/50',
                repos.length > 1 && 'cursor-grab',
                isDragged && 'cursor-grabbing opacity-50'
              )}
            >
              {showBeforeIndicator ? (
                <span
                  className="pointer-events-none absolute inset-y-1 -left-px w-0.5 rounded-full bg-primary"
                  aria-hidden="true"
                />
              ) : null}
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
              {showAfterIndicator ? (
                <span
                  className="pointer-events-none absolute inset-y-1 -right-px w-0.5 rounded-full bg-primary"
                  aria-hidden="true"
                />
              ) : null}
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
