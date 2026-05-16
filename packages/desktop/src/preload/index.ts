import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  AgentName,
  NewIssueImageMimeType,
  WorkflowStage,
} from '@baremetallabs-ai/shipper-core';

interface ConfigPayload {
  repos: string[];
  activeRepo: string;
  autoMergeRepos: string[];
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

type PtyCloseState =
  | { state: 'finalizable' }
  | { state: 'requires-discard-confirmation' }
  | { state: 'finalizing' }
  | { state: 'exited' };

interface PtyStatusEvent {
  sessionId: string;
  status: 'running' | 'waiting' | 'finalizing' | 'exited';
}

type BackgroundCommand = 'new' | 'ship' | 'init' | 'unblock';
type BackgroundStatus = 'queued' | 'running' | 'complete' | 'failed' | 'paused';

interface BackgroundStatusMeta {
  issueNumber?: number;
  issueTitle?: string;
  merge?: boolean;
  prMerged?: boolean;
  issueUrl?: string;
  logFile?: string;
  request?: string;
  cancelled?: boolean;
  pausePending?: boolean;
  origin?: 'auto' | 'manual';
  autoShipHalted?: boolean;
  retriable?: boolean;
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

interface NewIssueCapabilities {
  agent: AgentName;
  supportsImages: boolean;
  acceptedMimeTypes: NewIssueImageMimeType[];
  maxImageBytes: number;
  maxImages: number;
}

interface NewIssueScreenshotPayload {
  mimeType: NewIssueImageMimeType;
  bytes: ArrayBuffer;
}

const shipperAPI = {
  checkPrerequisites: () => ipcRenderer.invoke('check-prerequisites'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  listRepos: () => ipcRenderer.invoke('list-repos'),
  searchRepos: (request: { query: string; cursor?: string | null }) =>
    ipcRenderer.invoke('search-repos', request),
  listAdoptableIssues: (repo: string) => ipcRenderer.invoke('list-adoptable-issues', { repo }),
  listIssues: (repo: string) => ipcRenderer.invoke('list-issues', { repo }),
  fetchIssueTimelines: (repo: string, issueNumbers: number[]) =>
    ipcRenderer.invoke('fetch-issue-timelines', { repo, issueNumbers }),
  listPausedIssues: (repo: string) => ipcRenderer.invoke('pause-state:list', repo),
  setConfig: (config: ConfigPayload) => ipcRenderer.invoke('set-config', config),
  adoptIssue: (repo: string, issueNumber: number) =>
    ipcRenderer.invoke('adopt-issue', { repo, issueNumber }),
  checkInit: (repo: string) => ipcRenderer.invoke('check-init', { repo }),
  scanReset: (repo: string, issueNumber: number, targetStage: WorkflowStage) =>
    ipcRenderer.invoke('scan-reset', { repo, issueNumber, targetStage }),
  executeReset: (repo: string, issueNumber: number, targetStage: WorkflowStage) =>
    ipcRenderer.invoke('execute-reset', { repo, issueNumber, targetStage }),
  checkLockStale: (repo: string, issueNumber: number) =>
    ipcRenderer.invoke('check-lock-stale', { repo, issueNumber }),
  unlockIssue: (repo: string, issueNumber: number) =>
    ipcRenderer.invoke('unlock-issue', { repo, issueNumber }),
  pauseIssue: (repo: string, issueNumber: number) =>
    ipcRenderer.invoke('pause-state:add', { repo, issueNumber }),
  resumeIssue: (repo: string, issueNumber: number) =>
    ipcRenderer.invoke('pause-state:remove', { repo, issueNumber }),
  closeNotPlanned: (repo: string, issueNumber: number) =>
    ipcRenderer.invoke('close-not-planned', { repo, issueNumber }),
  setPriority: (repo: string, issueNumber: number, level: 'high' | 'normal' | 'low') =>
    ipcRenderer.invoke('set-priority', { repo, issueNumber, level }),

  spawnShipperGroom: (issueNumber: number, repo: string, cols: number, rows: number) =>
    ipcRenderer.invoke('pty-spawn-shipper-groom', { issueNumber, repo, cols, rows }),
  spawnShipperSetup: (repo: string, cols: number, rows: number) =>
    ipcRenderer.invoke('pty-spawn-shipper-setup', { repo, cols, rows }),
  getNewIssueCapabilities: (repo: string): Promise<NewIssueCapabilities> =>
    ipcRenderer.invoke('get-new-issue-capabilities', { repo }) as Promise<NewIssueCapabilities>,
  spawnBackgroundNew: (request: string, repo: string, screenshots?: NewIssueScreenshotPayload[]) =>
    ipcRenderer.invoke('bg-spawn-new', {
      request,
      repo,
      ...(screenshots === undefined ? {} : { screenshots }),
    }),
  spawnBackgroundShip: (
    issueNumber: number,
    repo: string,
    merge: boolean,
    origin?: 'auto' | 'manual',
    issueTitle?: string
  ) => ipcRenderer.invoke('bg-spawn-ship', { issueNumber, repo, merge, origin, issueTitle }),
  spawnBackgroundInit: (repo: string) => ipcRenderer.invoke('bg-spawn-init', { repo }),
  spawnBackgroundUnblock: (issueNumber: number, repo: string, issueTitle?: string) =>
    ipcRenderer.invoke('bg-spawn-unblock', { issueNumber, repo, issueTitle }),
  killBackground: (sessionId: string) => ipcRenderer.invoke('bg-kill', { sessionId }),
  requestPauseActive: (sessionId: string) => ipcRenderer.invoke('bg-request-pause', { sessionId }),
  requestAutoShipHalt: (repo: string) => ipcRenderer.invoke('bg-request-auto-ship-halt', { repo }),
  removeQueuedSession: (sessionId: string) =>
    ipcRenderer.invoke('bg-remove-queued-session', { sessionId }),
  getBackgroundOutput: (sessionId: string) => ipcRenderer.invoke('bg-get-output', { sessionId }),
  ptyWrite: (sessionId: string, data: string) =>
    ipcRenderer.invoke('pty-write', { sessionId, data }),
  ptyResize: (sessionId: string, cols: number, rows: number) =>
    ipcRenderer.invoke('pty-resize', { sessionId, cols, rows }),
  ptyCloseState: (sessionId: string): Promise<PtyCloseState> =>
    ipcRenderer.invoke('pty-close-state', { sessionId }) as Promise<PtyCloseState>,
  ptyFinalize: (sessionId: string) => ipcRenderer.invoke('pty-finalize', { sessionId }),
  ptyForceKill: (sessionId: string) => ipcRenderer.invoke('pty-force-kill', { sessionId }),

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
  onPtyStatus: (callback: (data: PtyStatusEvent) => void) => {
    const handler = (_event: IpcRendererEvent, data: PtyStatusEvent): void => {
      callback(data);
    };
    ipcRenderer.on('pty-status', handler);
    return () => {
      ipcRenderer.removeListener('pty-status', handler);
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
