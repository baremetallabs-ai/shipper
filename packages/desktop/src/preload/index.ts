import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

interface ConfigPayload {
  repos: string[];
  activeRepo: string;
}

interface PtyOutputEvent {
  sessionId: string;
  sequence: number;
  data: string;
}

interface PtyExitEvent {
  sessionId: string;
  exitCode: number | null;
}

const shipperAPI = {
  checkPrerequisites: () => ipcRenderer.invoke('check-prerequisites'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  listRepos: () => ipcRenderer.invoke('list-repos'),
  listIssues: (repo: string) => ipcRenderer.invoke('list-issues', { repo }),
  setConfig: (config: ConfigPayload) => ipcRenderer.invoke('set-config', config),

  spawnShipperNew: (request: string, repo: string, cols: number, rows: number) =>
    ipcRenderer.invoke('pty-spawn-shipper-new', { request, repo, cols, rows }),
  ptyWrite: (sessionId: string, data: string) =>
    ipcRenderer.invoke('pty-write', { sessionId, data }),
  ptyResize: (sessionId: string, cols: number, rows: number) =>
    ipcRenderer.invoke('pty-resize', { sessionId, cols, rows }),
  ptyKill: (sessionId: string) => ipcRenderer.invoke('pty-kill', { sessionId }),

  onPtyOutput: (callback: (data: PtyOutputEvent) => void) => {
    const handler = (_event: IpcRendererEvent, data: PtyOutputEvent): void => {
      callback(data);
    };
    ipcRenderer.on('pty-output', handler);
    return () => {
      ipcRenderer.removeListener('pty-output', handler);
    };
  },
  onPtyExit: (callback: (data: PtyExitEvent) => void) => {
    const handler = (_event: IpcRendererEvent, data: PtyExitEvent): void => {
      callback(data);
    };
    ipcRenderer.on('pty-exit', handler);
    return () => {
      ipcRenderer.removeListener('pty-exit', handler);
    };
  },
};

contextBridge.exposeInMainWorld('shipperAPI', shipperAPI);
