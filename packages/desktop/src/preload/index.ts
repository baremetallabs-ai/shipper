import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { WorkflowStage } from '@dnsquared/shipper-core';

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

type BackgroundCommand = 'new' | 'ship' | 'init';
type BackgroundStatus = 'queued' | 'running' | 'complete' | 'failed';

interface BackgroundStatusMeta {
  issueNumber?: number;
  issueUrl?: string;
  logFile?: string;
  request?: string;
  cancelled?: boolean;
}

interface BackgroundStatusEvent {
  sessionId: string;
  command: BackgroundCommand;
  repo: string;
  status: BackgroundStatus;
  exitCode?: number | null;
  meta?: BackgroundStatusMeta;
}

interface BackgroundOutputEvent {
  sessionId: string;
  data: string;
}

const shipperAPI = {
  checkPrerequisites: () => ipcRenderer.invoke('check-prerequisites'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  listRepos: () => ipcRenderer.invoke('list-repos'),
  listAdoptableIssues: (repo: string) => ipcRenderer.invoke('list-adoptable-issues', { repo }),
  listIssues: (repo: string) => ipcRenderer.invoke('list-issues', { repo }),
  setConfig: (config: ConfigPayload) => ipcRenderer.invoke('set-config', config),
  adoptIssue: (repo: string, issueNumber: number) =>
    ipcRenderer.invoke('adopt-issue', { repo, issueNumber }),
  checkInit: (repo: string) => ipcRenderer.invoke('check-init', { repo }),
  scanReset: (repo: string, issueNumber: number, targetStage: WorkflowStage) =>
    ipcRenderer.invoke('scan-reset', { repo, issueNumber, targetStage }),
  executeReset: (repo: string, issueNumber: number, targetStage: WorkflowStage) =>
    ipcRenderer.invoke('execute-reset', { repo, issueNumber, targetStage }),
  closeNotPlanned: (repo: string, issueNumber: number) =>
    ipcRenderer.invoke('close-not-planned', { repo, issueNumber }),

  spawnShipperGroom: (issueNumber: number, repo: string, cols: number, rows: number) =>
    ipcRenderer.invoke('pty-spawn-shipper-groom', { issueNumber, repo, cols, rows }),
  spawnBackgroundNew: (request: string, repo: string) =>
    ipcRenderer.invoke('bg-spawn-new', { request, repo }),
  spawnBackgroundShip: (issueNumber: number, repo: string) =>
    ipcRenderer.invoke('bg-spawn-ship', { issueNumber, repo }),
  spawnBackgroundInit: (repo: string) => ipcRenderer.invoke('bg-spawn-init', { repo }),
  killBackground: (sessionId: string) => ipcRenderer.invoke('bg-kill', { sessionId }),
  getBackgroundOutput: (sessionId: string) => ipcRenderer.invoke('bg-get-output', { sessionId }),
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
  onBackgroundStatus: (callback: (data: BackgroundStatusEvent) => void) => {
    const handler = (_event: IpcRendererEvent, data: BackgroundStatusEvent): void => {
      callback(data);
    };
    ipcRenderer.on('bg-status', handler);
    return () => {
      ipcRenderer.removeListener('bg-status', handler);
    };
  },
  onBackgroundOutput: (callback: (data: BackgroundOutputEvent) => void) => {
    const handler = (_event: IpcRendererEvent, data: BackgroundOutputEvent): void => {
      callback(data);
    };
    ipcRenderer.on('bg-output', handler);
    return () => {
      ipcRenderer.removeListener('bg-output', handler);
    };
  },
};

contextBridge.exposeInMainWorld('shipperAPI', shipperAPI);
