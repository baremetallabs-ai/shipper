import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';

type WindowOpenHandler = (details: { url: string }) => {
  action: 'deny' | 'allow';
};
type WillNavigateHandler = (event: { preventDefault: () => void }, url: string) => void;

const state = vi.hoisted(() => ({
  openExternalMock: vi.fn<(url: string) => Promise<void>>(),
}));

vi.mock('electron', () => ({
  shell: {
    openExternal: state.openExternalMock,
  },
}));

import { configureExternalLinks } from '../src/main/external-links.js';

function createWebContents(currentUrl = 'http://localhost:3000/board'): {
  webContents: Pick<WebContents, 'getURL' | 'on' | 'setWindowOpenHandler'>;
  getWillNavigateHandler: () => WillNavigateHandler;
  getWindowOpenHandler: () => WindowOpenHandler;
} {
  let windowOpenHandler: WindowOpenHandler | undefined;
  let willNavigateHandler: WillNavigateHandler | undefined;

  return {
    webContents: {
      getURL: vi.fn(() => currentUrl),
      on: vi.fn((event: string, handler: WillNavigateHandler) => {
        if (event === 'will-navigate') {
          willNavigateHandler = handler;
        }
      }),
      setWindowOpenHandler: vi.fn((handler: WindowOpenHandler) => {
        windowOpenHandler = handler;
      }),
    },
    getWillNavigateHandler: () => {
      if (!willNavigateHandler) {
        throw new Error('Expected configureExternalLinks() to register a will-navigate handler.');
      }

      return willNavigateHandler;
    },
    getWindowOpenHandler: () => {
      if (!windowOpenHandler) {
        throw new Error('Expected configureExternalLinks() to register a window-open handler.');
      }

      return windowOpenHandler;
    },
  };
}

describe('configureExternalLinks', () => {
  beforeEach(() => {
    state.openExternalMock.mockReset();
    state.openExternalMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('denies new windows and only opens external http(s) URLs in the OS browser', async () => {
    const { webContents, getWindowOpenHandler } = createWebContents();

    configureExternalLinks(webContents as WebContents);

    const handler = getWindowOpenHandler();

    expect(handler({ url: 'https://example.com/issues/627' })).toEqual({ action: 'deny' });
    expect(handler({ url: 'http://example.com/issues/627' })).toEqual({ action: 'deny' });
    expect(handler({ url: 'http://localhost:3000/settings' })).toEqual({ action: 'deny' });
    expect(handler({ url: 'mailto:test@example.com' })).toEqual({ action: 'deny' });
    expect(handler({ url: 'file:///tmp/example.txt' })).toEqual({ action: 'deny' });
    expect(handler({ url: 'not a url' })).toEqual({ action: 'deny' });

    await Promise.resolve();

    expect(state.openExternalMock).toHaveBeenCalledTimes(2);
    expect(state.openExternalMock).toHaveBeenNthCalledWith(1, 'https://example.com/issues/627');
    expect(state.openExternalMock).toHaveBeenNthCalledWith(2, 'http://example.com/issues/627');
  });

  it('prevents same-window navigation for external http(s) URLs only', async () => {
    const { webContents, getWillNavigateHandler } = createWebContents(
      'http://localhost:3000/issues'
    );

    configureExternalLinks(webContents as WebContents);

    const handler = getWillNavigateHandler();
    const externalEvent = { preventDefault: vi.fn() };
    const sameOriginEvent = { preventDefault: vi.fn() };
    const mailtoEvent = { preventDefault: vi.fn() };

    handler(externalEvent, 'https://github.com/baremetallabs-ai/shipper/issues/627');
    handler(sameOriginEvent, 'http://localhost:3000/settings');
    handler(mailtoEvent, 'mailto:test@example.com');

    await Promise.resolve();

    expect(externalEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(sameOriginEvent.preventDefault).not.toHaveBeenCalled();
    expect(mailtoEvent.preventDefault).not.toHaveBeenCalled();
    expect(state.openExternalMock).toHaveBeenCalledTimes(1);
    expect(state.openExternalMock).toHaveBeenCalledWith(
      'https://github.com/baremetallabs-ai/shipper/issues/627'
    );
  });

  it('still treats http(s) URLs as external when the renderer is not served from http(s)', async () => {
    const { webContents, getWillNavigateHandler } = createWebContents('file:///app/index.html');

    configureExternalLinks(webContents as WebContents);

    const handler = getWillNavigateHandler();
    const event = { preventDefault: vi.fn() };

    handler(event, 'https://example.com/issues/627');

    await Promise.resolve();

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(state.openExternalMock).toHaveBeenCalledWith('https://example.com/issues/627');
  });

  it('swallows shell.openExternal rejections for denied window opens', async () => {
    const { webContents, getWindowOpenHandler } = createWebContents();
    state.openExternalMock.mockRejectedValueOnce(new Error('No browser configured'));

    configureExternalLinks(webContents as WebContents);

    const handler = getWindowOpenHandler();

    expect(() => {
      expect(handler({ url: 'https://example.com/issues/627' })).toEqual({ action: 'deny' });
    }).not.toThrow();

    await Promise.resolve();

    expect(state.openExternalMock).toHaveBeenCalledWith('https://example.com/issues/627');
  });

  it('swallows shell.openExternal rejections for external navigations', async () => {
    const { webContents, getWillNavigateHandler } = createWebContents();
    state.openExternalMock.mockRejectedValueOnce(new Error('No browser configured'));

    configureExternalLinks(webContents as WebContents);

    const handler = getWillNavigateHandler();
    const event = { preventDefault: vi.fn() };

    expect(() => {
      handler(event, 'https://example.com/issues/627');
    }).not.toThrow();

    await Promise.resolve();

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(state.openExternalMock).toHaveBeenCalledWith('https://example.com/issues/627');
  });
});
