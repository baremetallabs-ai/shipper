import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  FileText,
  LoaderCircle,
  Square,
  TimerReset,
  X,
} from 'lucide-react';

import { cn } from '../lib/utils.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip.js';

export type ActionQueueCommand = 'new' | 'ship' | 'init' | 'unblock';
export type ActionQueueStatus = 'queued' | 'running' | 'complete' | 'failed' | 'paused';

export interface ActionQueueItem {
  id: string;
  command: ActionQueueCommand;
  status: ActionQueueStatus;
  stateChangedAt: number;
  repo: string;
  issueNumber?: number;
  issueUrl?: string;
  issueTitle?: string;
  workflowStage?: string;
  stillBlocked?: boolean;
  prMerged?: boolean;
  canCancel: boolean;
  canShowLogs: boolean;
  cancelled?: boolean;
}

interface ActionQueueDrawerProps {
  open: boolean;
  onToggle: () => void;
  commands: ActionQueueItem[];
  onCancel: (sessionId: string) => void;
  onShowLogs: (sessionId: string) => void;
  onClearFinished: () => void;
  onDismiss: (sessionId: string) => void;
}

const statusPriority: Record<ActionQueueStatus, number> = {
  running: 0,
  queued: 1,
  failed: 2,
  paused: 3,
  complete: 4,
};

function getStatusBadgeVariant(
  status: ActionQueueStatus
): 'outline' | 'secondary' | 'success' | 'destructive' {
  switch (status) {
    case 'running':
      return 'secondary';
    case 'queued':
      return 'outline';
    case 'paused':
      return 'outline';
    case 'complete':
      return 'success';
    case 'failed':
      return 'destructive';
  }
}

function getStatusLabel(status: ActionQueueStatus, cancelled: boolean | undefined): string {
  if (status === 'failed' && cancelled) {
    return 'Cancelled';
  }

  switch (status) {
    case 'running':
      return 'Running';
    case 'queued':
      return 'Queued';
    case 'paused':
      return 'Paused';
    case 'complete':
      return 'Succeeded';
    case 'failed':
      return 'Failed';
  }
}

function getCommandLabel(command: ActionQueueCommand): string {
  switch (command) {
    case 'new':
      return 'NEW';
    case 'ship':
      return 'SHIP';
    case 'init':
      return 'INIT';
    case 'unblock':
      return 'UNBLOCK';
  }
}

function formatRelativeStateChangeTime(stateChangedAt: number, now: number): string {
  const elapsedSeconds = Math.max(0, Math.floor((now - stateChangedAt) / 1000));

  if (elapsedSeconds < 10) {
    return 'Just now';
  }

  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s ago`;
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m ago`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours}h ago`;
  }

  return `${Math.floor(elapsedHours / 24)}d ago`;
}

function formatAbsoluteStateChangeTime(stateChangedAt: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(stateChangedAt));
}

function isActiveStatus(status: ActionQueueStatus): boolean {
  return status === 'queued' || status === 'running';
}

function getIssueHref(item: ActionQueueItem): string | undefined {
  if (item.issueNumber === undefined) {
    return undefined;
  }

  return item.issueUrl ?? `https://github.com/${item.repo}/issues/${item.issueNumber}`;
}

function getResolvedWorkflowStage(item: ActionQueueItem): string | undefined {
  const workflowStage = item.workflowStage?.trim();
  return workflowStage && workflowStage.length > 0 ? workflowStage : undefined;
}

function getStatusOrStageLabel(item: ActionQueueItem): string {
  if (item.status !== 'complete') {
    return getStatusLabel(item.status, item.cancelled);
  }

  if (item.command === 'new' || item.command === 'init') {
    return 'Succeeded';
  }

  if (item.command === 'ship') {
    return item.prMerged === true ? 'Succeeded' : (getResolvedWorkflowStage(item) ?? 'Succeeded');
  }

  return item.stillBlocked === true ? 'Blocked' : (getResolvedWorkflowStage(item) ?? 'Succeeded');
}

function getActionTargetLabel(item: ActionQueueItem): string {
  return item.issueNumber ? `#${item.issueNumber}` : getCommandLabel(item.command).toLowerCase();
}

function StatusIcon({ status }: { status: ActionQueueStatus }): JSX.Element {
  if (status === 'running') {
    return <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />;
  }

  if (status === 'queued') {
    return <TimerReset className="size-3.5" aria-hidden="true" />;
  }

  return <FileText className="size-3.5" aria-hidden="true" />;
}

export function ActionQueueDrawer({
  open,
  onToggle,
  commands,
  onCancel,
  onShowLogs,
  onClearFinished,
  onDismiss,
}: ActionQueueDrawerProps): JSX.Element {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [terminalNow, setTerminalNow] = useState(() => Date.now());
  const activeCount = commands.filter((command) => isActiveStatus(command.status)).length;
  const hasActiveRows = commands.some((command) => isActiveStatus(command.status));
  const hasClearable = commands.length > activeCount;
  const stateChangeSignature = useMemo(
    () =>
      commands
        .map((command) =>
          [
            command.id,
            command.status,
            command.cancelled ? 'cancelled' : 'active',
            command.stateChangedAt,
          ].join(':')
        )
        .join('|'),
    [commands]
  );
  const commandIndexById = useMemo(
    () => new Map(commands.map((command, index) => [command.id, index])),
    [commands]
  );
  const sortedCommands = useMemo(
    () =>
      [...commands].sort((a, b) => {
        const groupDiff = statusPriority[a.status] - statusPriority[b.status];
        if (groupDiff !== 0) {
          return groupDiff;
        }

        const indexA = commandIndexById.get(a.id) ?? 0;
        const indexB = commandIndexById.get(b.id) ?? 0;
        return indexB - indexA;
      }),
    [commandIndexById, commands]
  );
  const toggleAriaLabel =
    activeCount > 0 ? `Open activity (${activeCount} active)` : 'Open activity';

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) {
      return;
    }

    if (open) {
      panel.removeAttribute('inert');
      return;
    }

    panel.setAttribute('inert', '');
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    setNow(Date.now());

    if (!hasActiveRows) {
      return;
    }

    const intervalId = globalThis.setInterval(() => {
      setNow(Date.now());
    }, 30_000);

    return () => {
      globalThis.clearInterval(intervalId);
    };
  }, [hasActiveRows, open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    setTerminalNow(Date.now());
  }, [open, stateChangeSignature]);

  return (
    <>
      <div
        ref={panelRef}
        aria-hidden={!open}
        className={cn(
          'flex-shrink-0 overflow-hidden transition-[width] duration-200',
          open ? 'w-[300px] border-r border-border' : 'pointer-events-none w-0'
        )}
      >
        <div className="flex h-full min-w-[300px] flex-col bg-background">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <h2 className="text-sm font-semibold">Activity</h2>
            {hasClearable ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={onClearFinished}
              >
                Clear finished
              </Button>
            ) : null}
          </div>
          <div className="flex-1 overflow-y-auto">
            {sortedCommands.length === 0 ? (
              <div className="px-4 py-6 text-sm text-muted-foreground">No activity yet</div>
            ) : (
              sortedCommands.map((item) => {
                const referenceNow = isActiveStatus(item.status) ? now : terminalNow;
                const relativeTime = formatRelativeStateChangeTime(
                  item.stateChangedAt,
                  referenceNow
                );
                const absoluteTime = formatAbsoluteStateChangeTime(item.stateChangedAt);
                const issueHref = getIssueHref(item);
                const statusOrStageLabel = getStatusOrStageLabel(item);
                const actionTargetLabel = getActionTargetLabel(item);

                return (
                  <article
                    key={item.id}
                    className="flex items-start gap-3 border-b border-border px-3 py-3"
                  >
                    <div className="mt-0.5 rounded-full bg-muted p-1 text-muted-foreground">
                      <StatusIcon status={item.status} />
                    </div>
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline" className="uppercase tracking-[0.12em]">
                          {getCommandLabel(item.command)}
                        </Badge>
                        {item.issueNumber !== undefined && issueHref ? (
                          <a
                            href={issueHref}
                            target="_blank"
                            rel="noreferrer"
                            className="text-sm font-medium text-foreground underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                          >
                            #{item.issueNumber}
                          </a>
                        ) : null}
                        <span aria-live="polite" aria-atomic="true">
                          <Badge variant={getStatusBadgeVariant(item.status)}>
                            {statusOrStageLabel}
                          </Badge>
                        </span>
                      </div>
                      {item.issueTitle ? (
                        <p className="truncate text-sm font-medium text-foreground">
                          {item.issueTitle}
                        </p>
                      ) : null}
                      <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                        <span className="truncate">{item.repo}</span>
                        <span aria-hidden="true">·</span>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              className="flex-shrink-0 rounded-sm outline-none underline-offset-2 hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                              aria-label={`${relativeTime}; state changed ${absoluteTime}`}
                              title={absoluteTime}
                            >
                              <time dateTime={new Date(item.stateChangedAt).toISOString()}>
                                {relativeTime}
                              </time>
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>{absoluteTime}</TooltipContent>
                        </Tooltip>
                      </div>
                      <div className="flex flex-wrap items-center gap-1">
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
                            size="sm"
                            className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-destructive"
                            aria-label={`Stop ${actionTargetLabel}`}
                            onClick={() => {
                              onCancel(item.id);
                            }}
                          >
                            <Square className="size-3.5 fill-current" aria-hidden="true" />
                            Stop
                          </Button>
                        ) : null}
                        {item.status === 'failed' ||
                        item.status === 'complete' ||
                        item.status === 'paused' ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 gap-1 px-2 text-xs text-muted-foreground"
                            aria-label={`Dismiss ${actionTargetLabel}`}
                            onClick={() => {
                              onDismiss(item.id);
                            }}
                          >
                            <X className="size-3.5" aria-hidden="true" />
                            Dismiss
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  </article>
                );
              })
            )}
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={onToggle}
        className="relative flex w-5 flex-shrink-0 cursor-pointer items-center justify-center border-r border-border bg-background text-muted-foreground outline-none transition-[color,box-shadow] hover:bg-muted hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        aria-label={open ? 'Close activity' : toggleAriaLabel}
      >
        {open ? (
          <ChevronLeft className="h-4 w-4" />
        ) : (
          <>
            <ChevronRight className="h-4 w-4" />
            {activeCount > 0 ? (
              <Badge className="absolute top-2 left-1/2 h-5 min-w-5 -translate-x-1/2 rounded-full px-1 text-[10px] leading-none">
                {activeCount}
              </Badge>
            ) : null}
          </>
        )}
      </button>
    </>
  );
}
