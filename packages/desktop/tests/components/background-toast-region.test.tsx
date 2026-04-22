// @vitest-environment jsdom

import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { BackgroundToastRegion } from '../../src/renderer/components/background-toast-region.js';

describe('BackgroundToastRegion', () => {
  it('renders info toasts as status messages, auto-dismisses them, and omits retry', () => {
    vi.useFakeTimers();
    try {
      const onDismiss = vi.fn();

      render(
        <BackgroundToastRegion
          toasts={[
            {
              id: 'toast-1',
              variant: 'info',
              title: 'Auto-ship: #42 will retry later',
              description:
                'A transient merge conflict occurred. The issue remains eligible in this session.',
            },
          ]}
          onDismiss={onDismiss}
        />
      );

      expect(screen.getByRole('status')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();

      act(() => {
        vi.advanceTimersByTime(5_000);
      });

      expect(onDismiss).toHaveBeenCalledWith('toast-1');
    } finally {
      vi.useRealTimers();
    }
  });
});
