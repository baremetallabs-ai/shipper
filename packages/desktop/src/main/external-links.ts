import { shell, type WebContents } from 'electron';

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:']);

function parseUrl(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

function isExternalHttp(rawUrl: string, currentUrl: string): boolean {
  const targetUrl = parseUrl(rawUrl);
  if (!targetUrl || !EXTERNAL_PROTOCOLS.has(targetUrl.protocol)) {
    return false;
  }

  const activeUrl = parseUrl(currentUrl);
  if (
    activeUrl &&
    EXTERNAL_PROTOCOLS.has(activeUrl.protocol) &&
    targetUrl.origin === activeUrl.origin
  ) {
    return false;
  }

  return true;
}

function openExternal(url: string): void {
  void shell.openExternal(url).catch(() => {});
}

export function configureExternalLinks(webContents: WebContents): void {
  webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalHttp(url, webContents.getURL())) {
      openExternal(url);
    }

    return { action: 'deny' };
  });

  webContents.on('will-navigate', (event, url) => {
    if (!isExternalHttp(url, webContents.getURL())) {
      return;
    }

    event.preventDefault();
    openExternal(url);
  });
}
