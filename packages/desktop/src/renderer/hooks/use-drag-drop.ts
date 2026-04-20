import { useState } from 'react';

import type { ListIssueItem, WorkflowStage } from '@dnsquared/shipper-core';

export type DragSource =
  | {
      kind: 'pipeline';
      issue: ListIssueItem;
      columnIndex: number;
    }
  | {
      kind: 'attention';
      issue: ListIssueItem;
    };

interface PipelineDragInput {
  issue: ListIssueItem;
  columnIndex: number;
}

export interface UseDragDropResult {
  dragSource: DragSource | null;
  dragOverStage: WorkflowStage | null;
  startPipelineDrag: (input: PipelineDragInput) => void;
  startAttentionDrag: (issue: ListIssueItem) => void;
  endDrag: () => void;
  setDragOverStage: (stage: WorkflowStage | null) => void;
  clearDrag: () => void;
}

export function useDragDrop(): UseDragDropResult {
  const [dragSource, setDragSource] = useState<DragSource | null>(null);
  const [dragOverStage, setDragOverStage] = useState<WorkflowStage | null>(null);

  function clearDrag(): void {
    setDragSource(null);
    setDragOverStage(null);
  }

  function startPipelineDrag({ issue, columnIndex }: PipelineDragInput): void {
    setDragSource({ kind: 'pipeline', issue, columnIndex });
  }

  function startAttentionDrag(issue: ListIssueItem): void {
    setDragSource({ kind: 'attention', issue });
  }

  function endDrag(): void {
    clearDrag();
  }

  return {
    dragSource,
    dragOverStage,
    startPipelineDrag,
    startAttentionDrag,
    endDrag,
    setDragOverStage,
    clearDrag,
  };
}
