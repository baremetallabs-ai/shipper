import type { JSX } from 'react';
import { LoaderCircle } from 'lucide-react';

import { Button } from './ui/button.js';

interface PipelineEmptyStateProps {
  repoCount: number;
  repoInitialized: boolean | null;
  canFetch: boolean;
  hasActiveRepo: boolean;
  onAddRepo: () => void;
  onInit: () => void;
}

export function PipelineEmptyState({
  repoCount,
  repoInitialized,
  canFetch,
  hasActiveRepo,
  onAddRepo,
  onInit,
}: PipelineEmptyStateProps): JSX.Element | null {
  if (repoCount === 0) {
    return (
      <section className="relative flex min-h-[24rem] flex-col items-center justify-center rounded-sm border border-dashed border-border bg-card px-6 py-10 text-center">
        <svg
          className="pointer-events-none absolute opacity-[0.06] text-foreground"
          width="140"
          height="140"
          viewBox="0 0 100 100"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <circle cx="50" cy="50" r="40" />
          <circle cx="50" cy="50" r="3" fill="currentColor" />
          <line x1="50" y1="5" x2="50" y2="95" />
          <line x1="5" y1="50" x2="95" y2="50" />
          <polygon points="50,8 46,25 54,25" fill="currentColor" />
          <polygon points="50,92 46,75 54,75" fill="currentColor" />
          <polygon points="8,50 25,46 25,54" fill="currentColor" />
          <polygon points="92,50 75,46 75,54" fill="currentColor" />
        </svg>
        <div className="max-w-md space-y-3">
          <h2 className="text-xl font-semibold tracking-tight">Add a repository to get started</h2>
          <p className="text-sm text-muted-foreground">
            Choose a GitHub repository to load its shipper-labeled issues into the desktop inbox.
          </p>
          <Button onClick={onAddRepo}>Add repository</Button>
        </div>
      </section>
    );
  }

  if (repoInitialized === null) {
    return (
      <section className="relative flex min-h-[24rem] flex-col items-center justify-center rounded-sm border border-dashed border-border bg-card px-6 py-10 text-center">
        <LoaderCircle className="size-8 animate-spin text-muted-foreground" />
      </section>
    );
  }

  if (!repoInitialized) {
    return (
      <section className="relative flex min-h-[24rem] flex-col items-center justify-center rounded-sm border border-dashed border-border bg-card px-6 py-10 text-center">
        <div className="max-w-md space-y-3">
          <h2 className="text-xl font-semibold tracking-tight">Initialize this repository</h2>
          <p className="text-sm text-muted-foreground">
            Run shipper init to set up workflow labels and configuration.
          </p>
          <Button onClick={onInit} disabled={!canFetch || !hasActiveRepo}>
            Initialize
          </Button>
        </div>
      </section>
    );
  }

  return null;
}
