// @vitest-environment jsdom

import React from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTerminalRuntime } from '../../src/renderer/hooks/use-terminal-runtime.js';
import { createMockShipperApi } from './test-utils.js';

const terminalState = vi.hoisted(() => ({
  instances: [] as Array<{
    dataHandler: ((data: string) => void) | null;
    dispose: ReturnType<typeof vi.fn>;
    loadAddon: ReturnType<typeof vi.fn>;
    onData: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    cols: number;
    rows: number;
  }>,
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn(function FitAddon() {
    return {
      fit: vi.fn(),
    };
  }),
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn(function Terminal() {
    const instance = {
      dataHandler: null as ((data: string) => void) | null,
      dispose: vi.fn(),
      loadAddon: vi.fn(),
      onData: vi.fn((handler: (data: string) => void) => {
        instance.dataHandler = handler;
        return { dispose: vi.fn() };
      }),
      open: vi.fn(),
      reset: vi.fn(),
      write: vi.fn(),
      cols: 80,
      rows: 24,
    };
    terminalState.instances.push(instance);
    return instance;
  }),
}));

class MockResizeObserver {
  disconnect = vi.fn();
  observe = vi.fn();
}

function RuntimeHarness({
  status,
  onInput,
}: {
  status: 'running' | 'waiting' | 'finalizing' | 'exited';
  onInput: () => void;
}) {
  const { containerRef } = useTerminalRuntime({
    sessionId: 'pty-1',
    status,
    visible: true,
    onInput,
  });

  return <div ref={containerRef} />;
}

describe('useTerminalRuntime', () => {
  beforeEach(() => {
    terminalState.instances = [];
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      value: MockResizeObserver,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not forward terminal input while finalizing', async () => {
    const shipper = createMockShipperApi();
    shipper.install();
    const onInput = vi.fn();

    const { rerender } = render(<RuntimeHarness status="running" onInput={onInput} />);
    await act(async () => {
      await Promise.resolve();
    });

    const terminal = terminalState.instances[0];
    if (!terminal) {
      throw new Error('Expected terminal to be initialized.');
    }

    act(() => {
      terminal.dataHandler?.('a');
    });

    expect(shipper.api.ptyWrite).toHaveBeenCalledWith('pty-1', 'a');
    expect(onInput).toHaveBeenCalledTimes(1);

    rerender(<RuntimeHarness status="finalizing" onInput={onInput} />);
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      terminal.dataHandler?.('b');
    });

    expect(shipper.api.ptyWrite).toHaveBeenCalledTimes(1);
    expect(onInput).toHaveBeenCalledTimes(1);
  });
});
