// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useDragDrop } from '../../src/renderer/hooks/use-drag-drop.js';

describe('useDragDrop', () => {
  it('tracks pipeline and attention drag sources with a hovered stage', () => {
    const issue = {
      number: 42,
      title: 'Dragged issue',
      labels: [],
      state: 'OPEN' as const,
      author: 'octocat',
      createdAt: '2026-04-03T00:00:00Z',
      url: 'https://github.com/owner/repo/issues/42',
    };
    const { result } = renderHook(() => useDragDrop());

    act(() => {
      result.current.startPipelineDrag({ issue, columnIndex: 2 });
      result.current.setDragOverStage('groomed');
    });

    expect(result.current.dragSource).toEqual({ kind: 'pipeline', issue, columnIndex: 2 });
    expect(result.current.dragOverStage).toBe('groomed');

    act(() => {
      result.current.startAttentionDrag(issue);
      result.current.setDragOverStage('new');
    });

    expect(result.current.dragSource).toEqual({ kind: 'attention', issue });
    expect(result.current.dragOverStage).toBe('new');
  });

  it('clears drag state on endDrag and clearDrag', () => {
    const issue = {
      number: 7,
      title: 'Another issue',
      labels: [],
      state: 'OPEN' as const,
      author: 'octocat',
      createdAt: '2026-04-03T00:00:00Z',
      url: 'https://github.com/owner/repo/issues/7',
    };
    const { result } = renderHook(() => useDragDrop());

    act(() => {
      result.current.startPipelineDrag({ issue, columnIndex: 1 });
      result.current.setDragOverStage('new');
      result.current.endDrag();
    });

    expect(result.current.dragSource).toBeNull();
    expect(result.current.dragOverStage).toBeNull();

    act(() => {
      result.current.startAttentionDrag(issue);
      result.current.setDragOverStage('implemented');
      result.current.clearDrag();
    });

    expect(result.current.dragSource).toBeNull();
    expect(result.current.dragOverStage).toBeNull();
  });
});
