import { shell, type WebContents } from 'electron';

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:']);

function isExternalHttp(rawUrl: string): boolean {
  try {
    return EXTERNAL_PROTOCOLS.has(new URL(rawUrl).protocol);
  } catch {
    return false;
  }
}

export function configureExternalLinks(webContents: WebContents): void {
  webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalHttp(url)) {
      void shell.openExternal(url).catch(() => {});
    }

    return { action: 'deny' };
  });

  webContents.on('will-navigate', (event, url) => {
    if (!isExternalHttp(url) || url === webContents.getURL()) {
      return;
    }

    event.preventDefault();
    void shell.openExternal(url).catch(() => {});
  });
}
