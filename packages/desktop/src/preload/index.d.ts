import type { ListIssueItem } from '@dnsquared/shipper-core';

interface CheckResult {
  ok: boolean;
  message: string;
}

interface ConfigPayload {
  repos: string[];
  activeRepo: string;
  autoMergeRepos: string[];
}

interface ListIssuesSuccess {
  ok: true;
  issues: ListIssueItem[];
}

interface ListIssuesFailure {
  ok: false;
  error: string;
}

type WorkflowStage = 'new' | 'groomed' | 'designed' | 'planned' | 'implemented';

interface ArtifactScanSummary {
  targetStage: WorkflowStage;
  targetLabel: string;
  labelsToRemove: string[];
  addTarget: boolean;
  prs: Array<{
    number: number;
    headRefName: string;
  }>;
  branchesToDelete: string[];
  localBranches: string[];
  localWorktrees: string[];
  commentCount: number;
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

type BackgroundCommand = 'new' | 'ship' | 'init' | 'unblock';
type BackgroundStatus = 'queued' | 'running' | 'complete' | 'failed';

interface BackgroundStatusMeta {
  issueNumber?: number;
  merge?: boolean;
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

interface ShipperAPI {
  checkPrerequisites: () => Promise<{
    ghInstalled: CheckResult;
    ghAuth: CheckResult;
  }>;
  getConfig: () => Promise<ConfigPayload>;
  listAdoptableIssues: (repo: string) => Promise<ListIssuesSuccess | ListIssuesFailure>;
  listRepos: () => Promise<string[]>;
  listIssues: (repo: string) => Promise<ListIssuesSuccess | ListIssuesFailure>;
  setConfig: (config: ConfigPayload) => Promise<void>;
  adoptIssue: (
    repo: string,
    issueNumber: number
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  checkInit: (repo: string) => Promise<{ initialized: boolean; error?: string }>;
  scanReset: (
    repo: string,
    issueNumber: number,
    targetStage: WorkflowStage
  ) => Promise<{ ok: true; scan: ArtifactScanSummary } | { ok: false; error: string }>;
  executeReset: (
    repo: string,
    issueNumber: number,
    targetStage: WorkflowStage
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  checkLockStale: (repo: string, issueNumber: number) => Promise<{ stale: boolean }>;
  unlockIssue: (
    repo: string,
    issueNumber: number
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  closeNotPlanned: (
    repo: string,
    issueNumber: number
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  setPriority: (
    repo: string,
    issueNumber: number,
    level: 'high' | 'normal' | 'low'
  ) => Promise<{ ok: true } | { ok: false; error: string }>;

  spawnShipperGroom: (
    issueNumber: number,
    repo: string,
    cols: number,
    rows: number
  ) => Promise<{ sessionId: string }>;
  spawnBackgroundNew: (request: string, repo: string) => Promise<{ sessionId: string }>;
  spawnBackgroundShip: (
    issueNumber: number,
    repo: string,
    merge: boolean
  ) => Promise<{ sessionId: string }>;
  spawnBackgroundInit: (repo: string) => Promise<{ sessionId: string }>;
  spawnBackgroundUnblock: (issueNumber: number, repo: string) => Promise<{ sessionId: string }>;
  killBackground: (sessionId: string) => Promise<void>;
  getBackgroundOutput: (sessionId: string) => Promise<string>;
  ptyWrite: (sessionId: string, data: string) => Promise<void>;
  ptyResize: (sessionId: string, cols: number, rows: number) => Promise<void>;
  ptyKill: (sessionId: string) => Promise<void>;
  onPtyOutput: (callback: (data: PtyOutputEvent) => void) => () => void;
  onPtyExit: (callback: (data: PtyExitEvent) => void) => () => void;
  onBackgroundStatus: (callback: (data: BackgroundStatusEvent) => void) => () => void;
  onBackgroundOutput: (callback: (data: BackgroundOutputEvent) => void) => () => void;
}

declare global {
  interface Window {
    shipperAPI: ShipperAPI;
  }
}

export {};
