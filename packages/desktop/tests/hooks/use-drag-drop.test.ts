// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useDragDrop } from '../../src/renderer/hooks/use-drag-drop.js';

describe('useDragDrop', () => {
  it('tracks the current drag source and hovered column', () => {
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
      result.current.startDrag(issue, 2);
      result.current.setDragOverColumn(0);
    });

    expect(result.current.dragSource).toEqual({ issue, columnIndex: 2 });
    expect(result.current.dragOverColumn).toBe(0);
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
      result.current.startDrag(issue, 1);
      result.current.setDragOverColumn(0);
      result.current.endDrag();
    });

    expect(result.current.dragSource).toBeNull();
    expect(result.current.dragOverColumn).toBeNull();

    act(() => {
      result.current.startDrag(issue, 3);
      result.current.clearDrag();
    });

    expect(result.current.dragSource).toBeNull();
    expect(result.current.dragOverColumn).toBeNull();
  });
});
