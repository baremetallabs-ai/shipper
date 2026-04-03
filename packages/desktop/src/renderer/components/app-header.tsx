import type { JSX } from 'react';

import { cn } from '../lib/utils.js';
import { RepoTabBar } from './repo-tab-bar.js';

interface AppHeaderProps {
  repos: string[];
  activeRepo: string;
  activeCommandRepos: ReadonlySet<string>;
  onSelectRepo: (repo: string) => void;
  onCloseRepo: (repo: string) => void;
  onAddRepo: () => void;
  onReorderRepos: (repos: string[]) => void;
}

export function AppHeader({
  repos,
  activeRepo,
  activeCommandRepos,
  onSelectRepo,
  onCloseRepo,
  onAddRepo,
  onReorderRepos,
}: AppHeaderProps): JSX.Element {
  return (
    <header
      className={cn(
        'sticky top-0 z-10 bg-background nautical-wave-border',
        repos.length === 0 && 'border-b border-border'
      )}
    >
      <div className="mx-auto flex max-w-7xl flex-col gap-4 px-6 py-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">
            Shipper Desktop
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">Pipeline</h1>
        </div>
      </div>
      {repos.length > 0 ? (
        <RepoTabBar
          repos={repos}
          activeRepo={activeRepo}
          activeCommandRepos={activeCommandRepos}
          onSelectRepo={onSelectRepo}
          onCloseRepo={onCloseRepo}
          onAddRepo={onAddRepo}
          onReorderRepos={onReorderRepos}
        />
      ) : null}
    </header>
  );
}
