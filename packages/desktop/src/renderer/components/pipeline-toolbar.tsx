import type { JSX } from 'react';
import { LoaderCircle } from 'lucide-react';

import { dateFormatter } from '../lib/constants.js';
import { Button } from './ui/button.js';

interface PipelineToolbarProps {
  lastUpdated: Date | null;
  canFetch: boolean;
  isLoading: boolean;
  setupEnabled: boolean;
  isSetupPending: boolean;
  onNewIssue: () => void;
  onAdopt: () => void;
  onSetup: () => void;
  onRefresh: () => void;
}

export function PipelineToolbar({
  lastUpdated,
  canFetch,
  isLoading,
  setupEnabled,
  isSetupPending,
  onNewIssue,
  onAdopt,
  onSetup,
  onRefresh,
}: PipelineToolbarProps): JSX.Element {
  return (
    <div className="flex items-center justify-end gap-3">
      {lastUpdated ? (
        <p className="text-sm text-muted-foreground">
          Last updated {dateFormatter.format(lastUpdated)}
        </p>
      ) : null}
      <Button variant="outline" onClick={onNewIssue} disabled={!canFetch}>
        New Issue
      </Button>
      <Button variant="outline" onClick={onAdopt} disabled={!canFetch}>
        Adopt
      </Button>
      <Button variant="outline" onClick={onSetup} disabled={!setupEnabled || isSetupPending}>
        {isSetupPending ? (
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
        ) : null}
        Setup
      </Button>
      <Button variant="outline" onClick={onRefresh} disabled={!canFetch || isLoading}>
        {isLoading ? 'Refreshing...' : 'Refresh'}
      </Button>
    </div>
  );
}
