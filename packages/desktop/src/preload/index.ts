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

const shipperAPI = {
  checkPrerequisites: () => ipcRenderer.invoke('check-prerequisites'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  listRepos: () => ipcRenderer.invoke('list-repos'),
  listAdoptableIssues: (repo: string) => ipcRenderer.invoke('list-adoptable-issues', { repo }),
  listIssues: (repo: string) => ipcRenderer.invoke('list-issues', { repo }),
  setConfig: (config: ConfigPayload) => ipcRenderer.invoke('set-config', config),
  adoptIssue: (repo: string, issueNumber: number) =>
    ipcRenderer.invoke('adopt-issue', { repo, issueNumber }),
  scanReset: (repo: string, issueNumber: number, targetStage: WorkflowStage) =>
    ipcRenderer.invoke('scan-reset', { repo, issueNumber, targetStage }),
  executeReset: (repo: string, issueNumber: number, targetStage: WorkflowStage) =>
    ipcRenderer.invoke('execute-reset', { repo, issueNumber, targetStage }),

  spawnShipperNew: (request: string, repo: string, cols: number, rows: number) =>
    ipcRenderer.invoke('pty-spawn-shipper-new', { request, repo, cols, rows }),
  spawnShipperGroom: (issueNumber: number, repo: string, cols: number, rows: number) =>
    ipcRenderer.invoke('pty-spawn-shipper-groom', { issueNumber, repo, cols, rows }),
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
