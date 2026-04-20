import type { DragEvent, JSX } from 'react';

import { DISPLAY_NAME_MAP, READY_LABEL, type ListIssueItem } from '@dnsquared/shipper-core';

import { useDragDrop } from '../hooks/use-drag-drop.js';
import { COLUMN_RESET_STAGE, PIPELINE_COLUMNS } from '../lib/constants.js';
import { cn } from '../lib/utils.js';
import type { ActiveShippingCommand, ResetSelection } from '../types.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import { IssueCard, getResetTargets, isValidDropTarget } from './issue-card.js';

export interface PipelineBoardProps {
  repo: string;
  issues: ListIssueItem[];
  columnMap: Map<string, ListIssueItem[]>;
  attentionIssues: {
    failed: ListIssueItem[];
    new: ListIssueItem[];
  };
  resettingIssues: ReadonlySet<number>;
  unlockingIssues: ReadonlySet<number>;
  unblockingIssues: ReadonlySet<number>;
  settingPriorityIssues: ReadonlySet<number>;
  shippingCommands: ReadonlyMap<number, ActiveShippingCommand>;
  autoMergeEnabled: boolean;
  autoShipEnabled: boolean;
  isLoading: boolean;
  canFetch: boolean;
  hasActiveRepo: boolean;
  isSavingAutoMerge: boolean;
  onToggleAutoMerge: () => void;
  onToggleAutoShip: () => void;
  onResetSelect: (selection: ResetSelection) => void;
  onCloseNotPlanned: (issue: ListIssueItem) => void;
  onSetPriority: (issue: ListIssueItem, level: 'high' | 'normal' | 'low') => void;
  onUnlockClick: (issue: ListIssueItem) => void;
  onUnblockClick: (issue: ListIssueItem) => void;
  onGroom: (issueNumber: number) => void;
  onShip: (issueNumber: number) => void;
  onCancelShip: (sessionId: string) => void;
}

export function PipelineBoard({
  repo,
  issues,
  columnMap,
  attentionIssues,
  resettingIssues,
  unlockingIssues,
  unblockingIssues,
  settingPriorityIssues,
  shippingCommands,
  autoMergeEnabled,
  autoShipEnabled,
  isLoading,
  canFetch,
  hasActiveRepo,
  isSavingAutoMerge,
  onToggleAutoMerge,
  onToggleAutoShip,
  onResetSelect,
  onCloseNotPlanned,
  onSetPriority,
  onUnlockClick,
  onUnblockClick,
  onGroom,
  onShip,
  onCancelShip,
}: PipelineBoardProps): JSX.Element {
  const { dragSource, dragOverColumn, startDrag, endDrag, setDragOverColumn, clearDrag } =
    useDragDrop();

  function handleDragStart(event: DragEvent, issue: ListIssueItem, columnIndex: number): void {
    event.dataTransfer.effectAllowed = 'move';
    startDrag(issue, columnIndex);
  }

  return (
    <section className="overflow-hidden rounded-sm border border-border bg-card">
      <div className="border-b border-border px-6 py-4">
        <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Issues by workflow stage</h2>
            <p className="text-sm text-muted-foreground">
              Review the current repository as a pipeline organized by shipper stage.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {repo ? (
              <Badge variant="outline" className="w-fit">
                {repo}
              </Badge>
            ) : null}
            <Button
              type="button"
              aria-pressed={autoMergeEnabled}
              variant={autoMergeEnabled ? 'default' : 'outline'}
              size="sm"
              onClick={onToggleAutoMerge}
              disabled={!canFetch || !hasActiveRepo || isSavingAutoMerge}
            >
              Auto-merge
            </Button>
            <Button
              type="button"
              aria-pressed={autoShipEnabled}
              variant={autoShipEnabled ? 'default' : 'outline'}
              size="sm"
              onClick={onToggleAutoShip}
              disabled={!canFetch || !hasActiveRepo}
            >
              Auto-ship
            </Button>
          </div>
        </div>
      </div>

      {!hasActiveRepo ? (
        <div className="px-6 py-10 text-sm text-muted-foreground">
          Select a repository tab to begin.
        </div>
      ) : issues.length === 0 && !isLoading ? (
        <div className="px-6 py-10 text-sm text-muted-foreground">
          No shipper-labeled issues found for this repository.
        </div>
      ) : (
        <div className="space-y-6 px-6 py-6">
          {attentionIssues.failed.length > 0 || attentionIssues.new.length > 0 ? (
            <div className="space-y-3 border-b border-border pb-6">
              {attentionIssues.failed.length > 0 ? (
                <div className="space-y-3" data-testid="failed-attention-section">
                  <div>
                    <h3 className="text-sm font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                      Failed
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      Investigate failed runs here before returning work to the pipeline.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-3">
                    {attentionIssues.failed.map((issue) => (
                      <div key={issue.number} className="w-[240px] shrink-0">
                        <IssueCard
                          issue={issue}
                          onCloseNotPlanned={() => {
                            onCloseNotPlanned(issue);
                          }}
                          onSetPriority={(level) => {
                            onSetPriority(issue, level);
                          }}
                          onUnlock={() => {
                            onUnlockClick(issue);
                          }}
                          onUnblock={() => {
                            onUnblockClick(issue);
                          }}
                          isSettingPriority={settingPriorityIssues.has(issue.number)}
                          isUnlocking={unlockingIssues.has(issue.number)}
                          isUnblocking={unblockingIssues.has(issue.number)}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {attentionIssues.new.length > 0 ? (
                <div className="space-y-3" data-testid="new-attention-section">
                  <div>
                    <h3 className="text-sm font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                      New
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      New issues stay here until they are groomed into the pipeline.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-3">
                    {attentionIssues.new.map((issue) => (
                      <div key={issue.number} className="w-[240px] shrink-0">
                        <IssueCard
                          issue={issue}
                          onGroom={onGroom}
                          onCloseNotPlanned={() => {
                            onCloseNotPlanned(issue);
                          }}
                          onSetPriority={(level) => {
                            onSetPriority(issue, level);
                          }}
                          onUnlock={() => {
                            onUnlockClick(issue);
                          }}
                          onUnblock={() => {
                            onUnblockClick(issue);
                          }}
                          groomDisabled={!canFetch}
                          isSettingPriority={settingPriorityIssues.has(issue.number)}
                          isUnlocking={unlockingIssues.has(issue.number)}
                          isUnblocking={unblockingIssues.has(issue.number)}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="overflow-x-auto pb-1">
            <div className="flex min-w-max items-start gap-4">
              {PIPELINE_COLUMNS.map((label, columnIndex) => {
                const stageIssues = columnMap.get(label) ?? [];
                const isReadyColumn = label === READY_LABEL;
                const isValidTarget =
                  dragSource !== null && isValidDropTarget(dragSource, columnIndex);

                return (
                  <section
                    key={label}
                    className={cn(
                      'flex w-[240px] shrink-0 flex-col gap-4 rounded-sm border px-4 py-4 transition-colors',
                      isReadyColumn
                        ? 'border-success/30 bg-success/10'
                        : 'border-border bg-background/40',
                      dragSource !== null &&
                        (isValidTarget
                          ? dragOverColumn === columnIndex
                            ? 'border-blue-400 bg-blue-500/10'
                            : 'border-blue-400/40'
                          : 'opacity-50')
                    )}
                    onDragOver={(event) => {
                      if (!dragSource || !isValidDropTarget(dragSource, columnIndex)) {
                        event.dataTransfer.dropEffect = 'none';
                        return;
                      }

                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'move';
                    }}
                    onDragEnter={(event) => {
                      if (!dragSource || !isValidDropTarget(dragSource, columnIndex)) {
                        setDragOverColumn(null);
                        return;
                      }

                      event.preventDefault();
                      setDragOverColumn(columnIndex);
                    }}
                    onDragLeave={(event) => {
                      const { relatedTarget } = event;
                      if (
                        !(relatedTarget instanceof Node) ||
                        !event.currentTarget.contains(relatedTarget)
                      ) {
                        setDragOverColumn(null);
                      }
                    }}
                    onDrop={(event) => {
                      event.preventDefault();

                      if (!dragSource || !isValidDropTarget(dragSource, columnIndex)) {
                        clearDrag();
                        return;
                      }

                      const targetLabel = PIPELINE_COLUMNS[columnIndex];
                      const targetStage = targetLabel ? COLUMN_RESET_STAGE[targetLabel] : undefined;

                      if (targetStage) {
                        onResetSelect({
                          issue: dragSource.issue,
                          targetStage,
                        });
                      }

                      clearDrag();
                    }}
                  >
                    <div>
                      <h3 className="text-sm font-semibold">{DISPLAY_NAME_MAP[label]}</h3>
                    </div>

                    <div className="space-y-3">
                      {stageIssues.length > 0 ? (
                        stageIssues.map((issue) => {
                          const resetTargets = getResetTargets(issue.labels);
                          const shippingCmd = shippingCommands.get(issue.number);
                          const shippingStatus = shippingCmd?.status;

                          return (
                            <IssueCard
                              key={issue.number}
                              issue={issue}
                              onResetSelect={(targetStage) => {
                                onResetSelect({ issue, targetStage });
                              }}
                              onCloseNotPlanned={() => {
                                onCloseNotPlanned(issue);
                              }}
                              onSetPriority={(level) => {
                                onSetPriority(issue, level);
                              }}
                              onUnlock={() => {
                                onUnlockClick(issue);
                              }}
                              onUnblock={() => {
                                onUnblockClick(issue);
                              }}
                              resetTargets={resetTargets}
                              isResetting={resettingIssues.has(issue.number)}
                              isSettingPriority={settingPriorityIssues.has(issue.number)}
                              isUnlocking={unlockingIssues.has(issue.number)}
                              isUnblocking={unblockingIssues.has(issue.number)}
                              onShip={!isReadyColumn ? onShip : undefined}
                              shipDisabled={!!shippingStatus || !canFetch || !hasActiveRepo}
                              shippingStatus={shippingStatus}
                              onStopShip={
                                shippingCmd
                                  ? () => {
                                      onCancelShip(shippingCmd.id);
                                    }
                                  : undefined
                              }
                              draggable={
                                !resettingIssues.has(issue.number) &&
                                !unlockingIssues.has(issue.number) &&
                                !unblockingIssues.has(issue.number) &&
                                !shippingStatus
                              }
                              onDragStart={(event) => {
                                handleDragStart(event, issue, columnIndex);
                              }}
                              onDragEnd={endDrag}
                            />
                          );
                        })
                      ) : (
                        <p className="rounded-sm border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
                          No issues
                        </p>
                      )}
                    </div>
                  </section>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
