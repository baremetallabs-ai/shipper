import type { JSX } from 'react';
import { FileText, LoaderCircle, Square, TimerReset } from 'lucide-react';

import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import { cn } from '../lib/utils.js';

export type BackgroundIndicatorCommand = 'new' | 'ship' | 'init';
export type BackgroundIndicatorStatus = 'queued' | 'running' | 'complete' | 'failed';

export interface BackgroundStatusItem {
  id: string;
  command: BackgroundIndicatorCommand;
  status: BackgroundIndicatorStatus;
  title: string;
  detail?: string;
  canCancel: boolean;
  canShowLogs: boolean;
  cancelled?: boolean;
}

interface BackgroundStatusIndicatorProps {
  commands: BackgroundStatusItem[];
  onCancel: (sessionId: string) => void;
  onShowLogs: (sessionId: string) => void;
  className?: string;
}

function getStatusBadgeVariant(
  status: BackgroundIndicatorStatus
): 'outline' | 'secondary' | 'success' | 'destructive' {
  switch (status) {
    case 'running':
      return 'secondary';
    case 'queued':
      return 'outline';
    case 'complete':
      return 'success';
    case 'failed':
      return 'destructive';
  }
}

function getStatusLabel(status: BackgroundIndicatorStatus, cancelled: boolean | undefined): string {
  if (status === 'failed' && cancelled) {
    return 'Cancelled';
  }

  switch (status) {
    case 'running':
      return 'Running';
    case 'queued':
      return 'Queued';
    case 'complete':
      return 'Complete';
    case 'failed':
      return 'Failed';
  }
}

function getCommandLabel(command: BackgroundIndicatorCommand): string {
  switch (command) {
    case 'new':
      return 'New';
    case 'ship':
      return 'Ship';
    case 'init':
      return 'Init';
  }
}

function StatusIcon({ status }: { status: BackgroundIndicatorStatus }): JSX.Element {
  if (status === 'running') {
    return <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />;
  }

  if (status === 'queued') {
    return <TimerReset className="size-3.5" aria-hidden="true" />;
  }

  return <FileText className="size-3.5" aria-hidden="true" />;
}

export function BackgroundStatusIndicator({
  commands,
  onCancel,
  onShowLogs,
  className,
}: BackgroundStatusIndicatorProps): JSX.Element | null {
  if (commands.length === 0) {
    return null;
  }

  return (
    <section className={cn('background-status-list', className)} aria-live="polite">
      {commands.map((item) => (
        <article key={item.id} className="background-status-item">
          <div className="flex min-w-0 items-start gap-2">
            <div className="mt-0.5 rounded-full bg-muted p-1 text-muted-foreground">
              <StatusIcon status={item.status} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="truncate text-sm font-medium text-foreground">{item.title}</p>
                <Badge variant="outline" className="uppercase tracking-[0.12em]">
                  {getCommandLabel(item.command)}
                </Badge>
                <Badge variant={getStatusBadgeVariant(item.status)}>
                  {getStatusLabel(item.status, item.cancelled)}
                </Badge>
              </div>
              {item.detail ? (
                <p className="truncate text-xs text-muted-foreground">{item.detail}</p>
              ) : null}
            </div>
          </div>

          <div className="flex items-center gap-1">
            {item.canShowLogs ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => {
                  onShowLogs(item.id);
                }}
              >
                Logs
              </Button>
            ) : null}
            {item.canCancel ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground hover:text-destructive"
                aria-label={`Stop ${item.title}`}
                onClick={() => {
                  onCancel(item.id);
                }}
              >
                <Square className="size-3.5 fill-current" />
              </Button>
            ) : null}
          </div>
        </article>
      ))}
    </section>
  );
}
