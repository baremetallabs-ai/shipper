// @vitest-environment jsdom

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { BackgroundLogViewer } from '../../src/renderer/components/background-log-viewer.js';

interface PreMetricsState {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
}

interface PreElementLike {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
  focus: () => void;
  style: {
    opacity: string;
  };
}

interface PreMetricsMock {
  restore: () => void;
  state: PreMetricsState;
}

function mockPreMetrics(initialState: PreMetricsState): PreMetricsMock {
  const state = { ...initialState };
  const documentLike = globalThis.document as {
    createElement: (tagName: string, options?: unknown) => unknown;
    querySelector: (selector: string) => unknown;
  };
  const originalCreateElement = documentLike.createElement.bind(documentLike) as (
    tagName: string,
    options?: unknown
  ) => unknown;

  function decoratePre(element: PreElementLike): void {
    Object.defineProperty(element, 'clientHeight', {
      configurable: true,
      get() {
        return state.clientHeight;
      },
    });

    Object.defineProperty(element, 'scrollHeight', {
      configurable: true,
      get() {
        return state.scrollHeight;
      },
    });

    Object.defineProperty(element, 'scrollTop', {
      configurable: true,
      get() {
        return state.scrollTop;
      },
      set(value: number) {
        const maxScrollTop = Math.max(0, state.scrollHeight - state.clientHeight);
        state.scrollTop = Math.max(0, Math.min(value, maxScrollTop));
      },
    });
  }

  documentLike.createElement = (tagName: string, options?: unknown): unknown => {
    const element = originalCreateElement(tagName, options);
    if (tagName.toLowerCase() === 'pre') {
      decoratePre(element as PreElementLike);
    }

    return element;
  };

  return {
    state,
    restore() {
      documentLike.createElement = originalCreateElement;
    },
  };
}

function renderViewer(overrides: Partial<React.ComponentProps<typeof BackgroundLogViewer>> = {}) {
  const onOpenChange = vi.fn();
  const result = render(
    <BackgroundLogViewer
      open
      title="Background logs"
      content={'first line\nsecond line'}
      onOpenChange={onOpenChange}
      {...overrides}
    />
  );

  return {
    ...result,
    getPre: (): PreElementLike => getViewerPre(),
    onOpenChange,
  };
}

function getViewerPre(): PreElementLike {
  const documentLike = globalThis.document as {
    querySelector: (selector: string) => unknown;
  };
  const pre = documentLike.querySelector('pre.background-log-viewer');
  expect(pre).toBeTruthy();
  return pre as PreElementLike;
}

function getActiveElement(): unknown {
  const documentLike = globalThis.document as {
    activeElement: unknown;
  };
  return documentLike.activeElement;
}

function scrollViewer(pre: PreElementLike): void {
  fireEvent.scroll(pre as never);
}

function getMaxScrollTop(metrics: PreMetricsState): number {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight);
}

describe('BackgroundLogViewer', () => {
  it('opens with buffered content scrolled to the tail and keeps Jump to latest hidden', () => {
    const metrics = mockPreMetrics({ clientHeight: 200, scrollHeight: 800, scrollTop: 0 });

    try {
      const { getPre } = renderViewer();
      const pre = getPre();

      expect(pre.scrollTop).toBe(getMaxScrollTop(metrics.state));
      expect(pre.style.opacity).toBe('1');
      expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull();
    } finally {
      metrics.restore();
    }
  });

  it('opens with empty content using the existing empty-state message', () => {
    const metrics = mockPreMetrics({ clientHeight: 200, scrollHeight: 200, scrollTop: 0 });

    try {
      const { getPre } = renderViewer({ content: '' });
      const pre = getPre();

      expect(pre.scrollTop).toBe(getMaxScrollTop(metrics.state));
      expect(pre.style.opacity).toBe('1');
      expect(screen.getByText('No log output yet.')).toBeTruthy();
    } finally {
      metrics.restore();
    }
  });

  it('shows Jump to latest when scrolled away from the tail and hides it again at the bottom', () => {
    const metrics = mockPreMetrics({ clientHeight: 200, scrollHeight: 800, scrollTop: 0 });

    try {
      const { getPre } = renderViewer();
      const pre = getPre();

      metrics.state.scrollTop = 300;
      scrollViewer(pre);
      expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeTruthy();

      metrics.state.scrollTop = 596;
      scrollViewer(pre);
      expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull();
    } finally {
      metrics.restore();
    }
  });

  it('jumps back to the tail when Jump to latest is clicked', () => {
    const metrics = mockPreMetrics({ clientHeight: 200, scrollHeight: 800, scrollTop: 0 });

    try {
      const { getPre } = renderViewer();
      const pre = getPre();

      metrics.state.scrollTop = 300;
      scrollViewer(pre);
      fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }));

      expect(metrics.state.scrollTop).toBe(getMaxScrollTop(metrics.state));
      expect(getActiveElement()).toBe(pre as never);
      expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull();
    } finally {
      metrics.restore();
    }
  });

  it('pins appended content to the tail only while the viewer is already at the bottom', () => {
    const metrics = mockPreMetrics({ clientHeight: 200, scrollHeight: 400, scrollTop: 0 });

    try {
      const { getPre, rerender } = renderViewer({ content: 'line 1' });
      const pre = getPre();

      expect(pre.scrollTop).toBe(getMaxScrollTop(metrics.state));

      metrics.state.scrollHeight = 700;
      rerender(
        <BackgroundLogViewer
          open
          title="Background logs"
          content={'line 1\nline 2'}
          onOpenChange={vi.fn()}
        />
      );

      expect(metrics.state.scrollTop).toBe(getMaxScrollTop(metrics.state));
    } finally {
      metrics.restore();
    }
  });

  it('preserves the current scroll position when new content arrives after scrolling away', () => {
    const metrics = mockPreMetrics({ clientHeight: 200, scrollHeight: 400, scrollTop: 0 });

    try {
      const { getPre, rerender } = renderViewer({ content: 'line 1' });
      const pre = getPre();

      metrics.state.scrollTop = 120;
      scrollViewer(pre);

      metrics.state.scrollHeight = 700;
      rerender(
        <BackgroundLogViewer
          open
          title="Background logs"
          content={'line 1\nline 2'}
          onOpenChange={vi.fn()}
        />
      );

      expect(metrics.state.scrollTop).toBe(120);
    } finally {
      metrics.restore();
    }
  });

  it('resets the tail state after close and reopen', () => {
    const metrics = mockPreMetrics({ clientHeight: 200, scrollHeight: 500, scrollTop: 0 });

    try {
      const onOpenChange = vi.fn();
      const { rerender } = render(
        <BackgroundLogViewer
          open
          title="Background logs"
          content={'line 1\nline 2'}
          onOpenChange={onOpenChange}
        />
      );

      const pre = getViewerPre();
      metrics.state.scrollTop = 150;
      scrollViewer(pre);
      expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeTruthy();

      rerender(
        <BackgroundLogViewer
          open={false}
          title="Background logs"
          content={'line 1\nline 2'}
          onOpenChange={onOpenChange}
        />
      );

      metrics.state.scrollHeight = 900;
      metrics.state.scrollTop = 0;
      rerender(
        <BackgroundLogViewer
          open
          title="Background logs"
          content={'line 1\nline 2\nline 3'}
          onOpenChange={onOpenChange}
        />
      );

      const reopenedPre = getViewerPre();
      expect(reopenedPre.scrollTop).toBe(getMaxScrollTop(metrics.state));
      expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull();
    } finally {
      metrics.restore();
    }
  });
});
