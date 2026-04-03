import { useState } from 'react';

import type { ListIssueItem } from '@dnsquared/shipper-core';

interface DragSource {
  issue: ListIssueItem;
  columnIndex: number;
}

export interface UseDragDropResult {
  dragSource: DragSource | null;
  dragOverColumn: number | null;
  startDrag: (issue: ListIssueItem, columnIndex: number) => void;
  endDrag: () => void;
  setDragOverColumn: (columnIndex: number | null) => void;
  clearDrag: () => void;
}

export function useDragDrop(): UseDragDropResult {
  const [dragSource, setDragSource] = useState<DragSource | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<number | null>(null);

  function clearDrag(): void {
    setDragSource(null);
    setDragOverColumn(null);
  }

  function startDrag(issue: ListIssueItem, columnIndex: number): void {
    setDragSource({ issue, columnIndex });
  }

  function endDrag(): void {
    clearDrag();
  }

  return {
    dragSource,
    dragOverColumn,
    startDrag,
    endDrag,
    setDragOverColumn,
    clearDrag,
  };
}
