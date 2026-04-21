import type { DragEvent, JSX } from 'react';
import { Check, EllipsisVertical, LoaderCircle, Square } from 'lucide-react';

import {
  BLOCKED_LABEL,
  DISPLAY_NAME_MAP,
  FAILED_LABEL,
  getPriorityTier,
  LOCKED_LABEL,
  type ListIssueItem,
  type TokenUsage,
  type WorkflowStage,
} from '@dnsquared/shipper-core';

import {
  POST_IMPLEMENTATION_LABELS,
  RESET_STAGE_LABELS,
  RESET_STAGE_ORDER,
} from '../lib/constants.js';
import type { DragSource } from '../hooks/use-drag-drop.js';
import { formatCompactTokens } from '../lib/format-tokens.js';
import { cn } from '../lib/utils.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './ui/dropdown-menu.js';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip.js';

const spokenTokenFormatter = new Intl.NumberFormat('en-US');

const TOKEN_USAGE_ROWS = [
  { label: 'Input', key: 'inputTokens' },
  { label: 'Output', key: 'outputTokens' },
  { label: 'Cache read', key: 'cacheReadTokens' },
  { label: 'Cache write', key: 'cacheWriteTokens' },
] as const satisfies Array<{ label: string; key: keyof TokenUsage }>;

export function getResetTargets(labels: string[]): WorkflowStage[] {
  const hasPrLabels = POST_IMPLEMENTATION_LABELS.some((label) => labels.includes(label));
  if (hasPrLabels) {
    return RESET_STAGE_ORDER.map(({ stage }) => stage);
  }

  for (let index = RESET_STAGE_ORDER.length - 1; index >= 0; index -= 1) {
    const entry = RESET_STAGE_ORDER[index];
    if (entry && labels.includes(entry.label)) {
      return RESET_STAGE_ORDER.slice(0, index).map(({ stage }) => stage);
    }
  }

  if (labels.includes(FAILED_LABEL)) {
    return RESET_STAGE_ORDER.map(({ stage }) => stage);
  }

  return [];
}

function getResetTargetLabel(stage: WorkflowStage): string {
  return DISPLAY_NAME_MAP[RESET_STAGE_LABELS[stage]] ?? stage;
}

export function isValidDropTarget(source: DragSource, targetStage: WorkflowStage): boolean {
  if (targetStage === 'new' && source.kind !== 'attention') {
    return false;
  }

  const resetTargets = getResetTargets(source.issue.labels);
  return resetTargets.includes(targetStage);
}

export interface IssueCardProps {
  issue: ListIssueItem;
  tokenUsage: TokenUsage;
  onGroom?: (issueNumber: number) => void;
  onResetSelect?: (targetStage: WorkflowStage) => void;
  onSetPriority?: (level: 'high' | 'normal' | 'low') => void;
  onCloseNotPlanned?: () => void;
  onUnlock?: () => void;
  onUnblock?: () => void;
  resetTargets?: WorkflowStage[];
  groomDisabled?: boolean;
  isResetting?: boolean;
  isUnlocking?: boolean;
  isUnblocking?: boolean;
  isSettingPriority?: boolean;
  onShip?: (issueNumber: number) => void;
  shipDisabled?: boolean;
  shippingStatus?: 'queued' | 'running';
  onStopShip?: () => void;
  draggable?: boolean;
  onDragStart?: (e: DragEvent) => void;
  onDragEnd?: () => void;
}

function getTotalTokens(tokenUsage: TokenUsage): number {
  return TOKEN_USAGE_ROWS.reduce((total, row) => total + tokenUsage[row.key], 0);
}

function formatTokenBreakdownSentence(tokenUsage: TokenUsage): string {
  const total = getTotalTokens(tokenUsage);
  const rows = TOKEN_USAGE_ROWS.map(
    (row) => `${spokenTokenFormatter.format(tokenUsage[row.key])} ${row.label.toLowerCase()}`
  );

  return `${spokenTokenFormatter.format(total)} total tokens: ${rows.join(', ')}`;
}

export function IssueCard({
  issue,
  tokenUsage,
  onGroom,
  onResetSelect,
  onSetPriority,
  onCloseNotPlanned,
  onUnlock,
  onUnblock,
  resetTargets = [],
  groomDisabled = false,
  isResetting = false,
  isUnlocking = false,
  isUnblocking = false,
  isSettingPriority = false,
  onShip,
  shipDisabled = false,
  shippingStatus,
  onStopShip,
  draggable,
  onDragStart,
  onDragEnd,
}: IssueCardProps): JSX.Element {
  const isFailed = issue.labels.includes(FAILED_LABEL);
  const isBlocked = issue.labels.includes(BLOCKED_LABEL);
  const isLocked = issue.labels.includes(LOCKED_LABEL);
  const priorityTier = getPriorityTier(issue.labels);
  const isShipping = !!shippingStatus;
  const isBusy = isResetting || isUnlocking || isUnblocking;
  const isMenuDisabled = isBusy || isSettingPriority;
  const busyLabel = isResetting
    ? 'Resetting...'
    : isUnlocking
      ? 'Unlocking...'
      : isUnblocking
        ? 'Unblocking...'
        : null;
  const isGroomDisabled = groomDisabled || isBlocked || isLocked || isFailed || isShipping;
  const canUnlock = isLocked && !!onUnlock && !isShipping;
  const canUnblock = isBlocked && !isLocked && !!onUnblock && !isShipping;
  const canCloseNotPlanned = !!onCloseNotPlanned && !isLocked && !isShipping;
  const hasResetMenu = onResetSelect !== undefined && resetTargets.length > 0 && !isShipping;
  const hasPriorityMenu = onSetPriority !== undefined;
  const hasFlatActions = canCloseNotPlanned || canUnlock || canUnblock;
  const showOverflowMenu = hasResetMenu || hasFlatActions || hasPriorityMenu;
  const showStopShipButton = isShipping && onStopShip !== undefined;
  const isShipDisabled = shipDisabled || isBlocked || isLocked || isFailed || isShipping;
  const totalTokens = getTotalTokens(tokenUsage);
  const tokenBreakdownSentence = formatTokenBreakdownSentence(tokenUsage);

  function handleUnlockSelect(): void {
    onUnlock?.();
  }

  return (
    <article
      data-testid={`issue-card-${issue.number}`}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={cn(
        'relative space-y-3 rounded-sm border border-border bg-background px-4 py-4 transition-opacity',
        isBusy && 'opacity-70',
        shippingStatus === 'running' && 'shipping-active',
        isFailed && 'border-destructive/50 bg-destructive/10',
        draggable && 'cursor-grab'
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <a
          href={issue.url}
          target="_blank"
          rel="noreferrer"
          draggable
          onDragStart={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          className="text-sm font-medium text-muted-foreground no-underline hover:underline"
        >
          #{issue.number}
        </a>
        <div className="flex items-center gap-1">
          {showOverflowMenu ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  disabled={isMenuDisabled}
                  aria-label={`Issue #${issue.number} actions`}
                >
                  <EllipsisVertical className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {hasResetMenu ? (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>Reset</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      {resetTargets.map((targetStage) => (
                        <DropdownMenuItem
                          key={targetStage}
                          onSelect={() => {
                            onResetSelect(targetStage);
                          }}
                        >
                          {getResetTargetLabel(targetStage)}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                ) : null}
                {hasPriorityMenu ? (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>Priority</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      {(['high', 'normal', 'low'] as const).map((level) => {
                        const tier = level === 'high' ? 0 : level === 'low' ? 2 : 1;
                        const isActive = tier === priorityTier;

                        return (
                          <DropdownMenuItem
                            key={level}
                            disabled={isSettingPriority}
                            onSelect={() => {
                              if (isActive) {
                                return;
                              }

                              onSetPriority(level);
                            }}
                          >
                            {level.charAt(0).toUpperCase() + level.slice(1)}
                            {isActive ? (
                              <Check className="ml-auto size-4" aria-hidden="true" />
                            ) : null}
                          </DropdownMenuItem>
                        );
                      })}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                ) : null}
                {hasFlatActions && (hasResetMenu || hasPriorityMenu) ? (
                  <DropdownMenuSeparator />
                ) : null}
                {canCloseNotPlanned ? (
                  <DropdownMenuItem
                    onSelect={() => {
                      onCloseNotPlanned();
                    }}
                    className="text-destructive focus:text-destructive"
                  >
                    Close as not planned
                  </DropdownMenuItem>
                ) : null}
                {canUnlock ? (
                  <DropdownMenuItem onSelect={handleUnlockSelect}>Unlock</DropdownMenuItem>
                ) : null}
                {canUnblock ? (
                  <DropdownMenuItem
                    onSelect={() => {
                      onUnblock();
                    }}
                  >
                    Unblock
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          {showStopShipButton ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-destructive"
              aria-label={`Stop shipping #${issue.number}`}
              onClick={onStopShip}
            >
              <Square className="size-3.5 fill-current" />
            </Button>
          ) : null}
        </div>
      </div>
      <h4 className="text-sm font-semibold leading-snug text-foreground">{issue.title}</h4>
      {priorityTier !== 1 || isFailed || isBlocked || isLocked ? (
        <div className="flex flex-wrap gap-2">
          {priorityTier === 0 ? (
            <Badge variant="outline" className="border-orange-500 text-orange-600">
              High
            </Badge>
          ) : null}
          {priorityTier === 2 ? (
            <Badge variant="outline" className="text-muted-foreground">
              Low
            </Badge>
          ) : null}
          {isFailed ? (
            <Badge variant="outline" className="border-destructive text-destructive">
              Failed
            </Badge>
          ) : null}
          {isBlocked ? <Badge variant="outline">Blocked</Badge> : null}
          {isLocked ? <Badge variant="outline">Locked</Badge> : null}
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {isFailed && hasResetMenu ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" size="sm">
                  Reset
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {resetTargets.map((targetStage) => (
                  <DropdownMenuItem
                    key={targetStage}
                    onSelect={() => {
                      onResetSelect(targetStage);
                    }}
                  >
                    {getResetTargetLabel(targetStage)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <>
              {onGroom ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    onGroom(issue.number);
                  }}
                  disabled={isGroomDisabled}
                >
                  Groom
                </Button>
              ) : null}
              {onShip ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    onShip(issue.number);
                  }}
                  disabled={isShipDisabled}
                >
                  Ship
                </Button>
              ) : null}
            </>
          )}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="cursor-default rounded-[2px] text-xs text-muted-foreground tabular-nums outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <span className="sr-only">{tokenBreakdownSentence}</span>
              <span aria-hidden="true">{`${formatCompactTokens(totalTokens)} tokens`}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent
            aria-hidden="true"
            side="top"
            align="end"
            className="min-w-[11rem] space-y-1"
          >
            {TOKEN_USAGE_ROWS.map((row) => (
              <div key={row.key} className="flex items-center justify-between gap-3 text-xs">
                <span className="text-muted-foreground">{row.label}</span>
                <span className="tabular-nums text-foreground">
                  {formatCompactTokens(tokenUsage[row.key])}
                </span>
              </div>
            ))}
          </TooltipContent>
        </Tooltip>
      </div>
      {busyLabel ? (
        <div className="absolute inset-0 flex items-center justify-center rounded-sm bg-background/80">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            {busyLabel}
          </div>
        </div>
      ) : null}
    </article>
  );
}
