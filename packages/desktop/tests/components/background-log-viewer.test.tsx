// @vitest-environment jsdom

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

interface ViewerPreElement extends PreElementLike {
  classList: {
    contains: (token: string) => boolean;
  };
  getAttribute: (name: string) => string | null;
  parentElement: {
    classList: {
      contains: (token: string) => boolean;
    };
  } | null;
  tabIndex: number;
  textContent: string | null;
}

interface NavigatorLike {
  clipboard?: {
    writeText: (value: string) => Promise<void>;
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
  const originalCreateElement = documentLike.createElement.bind(documentLike);

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
    getPre: (): ViewerPreElement => getViewerPre(),
    onOpenChange,
  };
}

function getViewerPre(): ViewerPreElement {
  const documentLike = globalThis.document as {
    querySelector: (selector: string) => unknown;
  };
  const pre = documentLike.querySelector('pre.background-log-viewer');
  expect(pre).toBeTruthy();
  return pre as ViewerPreElement;
}

function getActiveElement(): unknown {
  const documentLike = globalThis.document as {
    activeElement: unknown;
  };
  return documentLike.activeElement;
}

function scrollViewer(pre: PreElementLike): void {
  fireEvent.scroll(pre);
}

function getMaxScrollTop(metrics: PreMetricsState): number {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight);
}

function expectHorizontalScrollContract(pre: ViewerPreElement): void {
  expect(pre.parentElement?.classList.contains('min-w-0')).toBe(true);
  expect(pre.classList.contains('w-full')).toBe(true);
  expect(pre.classList.contains('min-w-0')).toBe(true);
  expect(pre.classList.contains('overflow-x-auto')).toBe(true);
  expect(pre.classList.contains('overflow-y-auto')).toBe(true);
  expect(pre.classList.contains('whitespace-pre')).toBe(true);
  expect(pre.classList.contains('outline-none')).toBe(true);
  expect(pre.classList.contains('focus-visible:ring-[3px]')).toBe(true);
  expect(pre.classList.contains('focus-visible:ring-ring/50')).toBe(true);
  expect(pre.classList.contains('focus-visible:ring-inset')).toBe(true);
  expect(pre.classList.contains('whitespace-pre-wrap')).toBe(false);
  expect(pre.classList.contains('overflow-auto')).toBe(false);
  expect(pre.getAttribute('role')).toBe('region');
  expect(pre.getAttribute('aria-label')).toBe('Command log output');
  expect(pre.tabIndex).toBe(0);
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

  it('preserves long buffered output without wrapping and keeps scrolling bounded', () => {
    const metrics = mockPreMetrics({ clientHeight: 200, scrollHeight: 240, scrollTop: 0 });
    const longToken = `https://example.test/${'a'.repeat(180)}?sha=${'b'.repeat(64)}`;
    const content = `first  line\n  spaced    output\n${longToken}`;

    try {
      const { getPre } = renderViewer({ content });
      const pre = getPre();

      expect(pre.textContent).toBe(content);
      expectHorizontalScrollContract(pre);
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

  it('pins live appended long output to the tail while preserving the horizontal scroll contract', () => {
    const metrics = mockPreMetrics({ clientHeight: 200, scrollHeight: 400, scrollTop: 0 });
    const longToken = `https://example.test/${'a'.repeat(180)}?sha=${'b'.repeat(64)}`;
    const content = `line 1\n${longToken}`;

    try {
      const { getPre, rerender } = renderViewer({ content: 'line 1' });
      const pre = getPre();

      expect(pre.scrollTop).toBe(getMaxScrollTop(metrics.state));

      metrics.state.scrollHeight = 700;
      rerender(
        <BackgroundLogViewer
          open
          title="Background logs"
          content={content}
          onOpenChange={vi.fn()}
        />
      );

      expect(pre.textContent).toBe(content);
      expectHorizontalScrollContract(pre);
      expect(pre.scrollTop).toBe(getMaxScrollTop(metrics.state));
    } finally {
      metrics.restore();
    }
  });

  it('copies complete long log content', async () => {
    const metrics = mockPreMetrics({ clientHeight: 200, scrollHeight: 240, scrollTop: 0 });
    const longToken = `https://example.test/${'a'.repeat(180)}?sha=${'b'.repeat(64)}`;
    const content = `first  line\n  spaced    output\n${longToken}`;
    const writeText = vi.fn<(value: string) => Promise<void>>().mockResolvedValue(undefined);
    const navigatorLike = globalThis.navigator as NavigatorLike;
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigatorLike, 'clipboard');

    Object.defineProperty(navigatorLike, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    try {
      renderViewer({ content });
      fireEvent.click(screen.getByRole('button', { name: 'Copy logs to clipboard' }));

      await waitFor(() => {
        expect(writeText).toHaveBeenCalledTimes(1);
      });
      expect(writeText).toHaveBeenCalledWith(content);
    } finally {
      metrics.restore();
      if (clipboardDescriptor) {
        Object.defineProperty(navigatorLike, 'clipboard', clipboardDescriptor);
      } else {
        Reflect.deleteProperty(navigatorLike, 'clipboard');
      }
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
