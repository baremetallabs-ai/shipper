import type { ListIssueItem, TokenUsage, WorkflowStage } from '@dnsquared/shipper-core';

export interface CheckResult {
  ok: boolean;
  message: string;
}

export interface Prerequisites {
  ghInstalled: CheckResult;
  ghAuth: CheckResult;
}

export interface AppConfig {
  repos: string[];
  activeRepo: string;
  autoMergeRepos: string[];
}

export interface PipelineIssue extends ListIssueItem {
  tokenUsage: TokenUsage;
}

export interface ListIssuesSuccess {
  ok: true;
  issues: PipelineIssue[];
}

export interface ListAdoptableIssuesSuccess {
  ok: true;
  issues: ListIssueItem[];
}

export interface ListIssuesFailure {
  ok: false;
  error: string;
}

export interface TimelineLabelEvent {
  event: string;
  label?: {
    name: string;
  } | null;
  created_at?: string;
}

export interface ArtifactScanSummary {
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

export interface PtyOutputEvent {
  sessionId: string;
  sequence: number;
  data: string;
}

export interface PtyExitEvent {
  sessionId: string;
  exitCode: number | null;
}

export interface ShipperApi {
  checkPrerequisites: () => Promise<Prerequisites>;
  getConfig: () => Promise<AppConfig>;
  listRepos: () => Promise<string[]>;
  listAdoptableIssues: (repo: string) => Promise<ListAdoptableIssuesSuccess | ListIssuesFailure>;
  listIssues: (repo: string) => Promise<ListIssuesSuccess | ListIssuesFailure>;
  fetchIssueTimelines: (
    repo: string,
    issueNumbers: number[]
  ) => Promise<Map<number, TimelineLabelEvent[]>>;
  listPausedIssues: (repo: string) => Promise<number[]>;
  setConfig: (config: AppConfig) => Promise<void>;
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
  pauseIssue: (repo: string, issueNumber: number) => Promise<void>;
  resumeIssue: (repo: string, issueNumber: number) => Promise<void>;
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
  spawnShipperSetup: (repo: string, cols: number, rows: number) => Promise<{ sessionId: string }>;
  spawnBackgroundNew: (request: string, repo: string) => Promise<{ sessionId: string }>;
  spawnBackgroundShip: (
    issueNumber: number,
    repo: string,
    merge: boolean,
    origin?: 'auto' | 'manual'
  ) => Promise<{ sessionId: string }>;
  spawnBackgroundInit: (repo: string) => Promise<{ sessionId: string }>;
  spawnBackgroundUnblock: (issueNumber: number, repo: string) => Promise<{ sessionId: string }>;
  killBackground: (sessionId: string) => Promise<void>;
  requestPauseActive: (sessionId: string) => Promise<void>;
  requestAutoShipHalt: (repo: string) => Promise<number>;
  removeQueuedSession: (sessionId: string) => Promise<'ignored' | 'pause-requested' | 'paused'>;
  getBackgroundOutput: (sessionId: string) => Promise<string>;
  ptyWrite: (sessionId: string, data: string) => Promise<void>;
  ptyResize: (sessionId: string, cols: number, rows: number) => Promise<void>;
  ptyKill: (sessionId: string) => Promise<void>;
  onPtyOutput: (callback: (data: PtyOutputEvent) => void) => () => void;
  onPtyExit: (callback: (data: PtyExitEvent) => void) => () => void;
  onBackgroundStatus: (callback: (data: BackgroundStatusPayload) => void) => () => void;
  onBackgroundOutput: (callback: (data: BackgroundOutputPayload) => void) => () => void;
}

export type IssueListResult = Awaited<ReturnType<ShipperApi['listIssues']>>;

export interface IssuePipelineBridge {
  loadIssues: (repo: string) => Promise<IssueListResult | null>;
  clearIssueState: () => void;
  clearStageCacheForRepo: (repo: string) => void;
  setFetchError: (message: string | null) => void;
  getIssueByNumber: (issueNumber: number) => ListIssueItem | undefined;
  getPausedIssues: () => ReadonlySet<number>;
  trackPausedIssue: (issueNumber: number) => void;
  clearPausedIssue: (issueNumber: number) => void;
  trackUnblockIssue: (issueNumber: number) => void;
  clearUnblockIssue: (issueNumber: number) => void;
}

export interface BackgroundCommandsBridge {
  clearAutoShipStateForRepo: (repo: string) => void;
}

export type TerminalSessionStatus = 'running' | 'waiting' | 'exited';

export interface TerminalSession {
  id: string;
  label: string;
  status: TerminalSessionStatus;
  repo?: string;
  issueNumber?: number;
}

export interface ResetSelection {
  issue: ListIssueItem;
  targetStage: WorkflowStage;
}

export type BackgroundCommandKind = 'new' | 'ship' | 'init' | 'unblock';

export type BackgroundCommandStatus = 'queued' | 'running' | 'complete' | 'failed' | 'paused';

export type BackgroundRetryPayload =
  | { command: 'new'; repo: string; request: string }
  | {
      command: 'ship';
      repo: string;
      issueNumber: number;
      merge: boolean;
      origin?: 'auto' | 'manual';
    }
  | { command: 'init'; repo: string }
  | { command: 'unblock'; repo: string; issueNumber: number };

export interface BackgroundStatusMeta {
  issueNumber?: number;
  merge?: boolean;
  issueUrl?: string;
  logFile?: string;
  request?: string;
  cancelled?: boolean;
  pausePending?: boolean;
  origin?: 'auto' | 'manual';
  autoShipHalted?: boolean;
  retriable?: boolean;
}

export interface BackgroundStatusPayload {
  sessionId: string;
  command: BackgroundCommandKind;
  repo: string;
  status: BackgroundCommandStatus;
  exitCode?: number | null;
  meta?: BackgroundStatusMeta;
}

export interface BackgroundOutputPayload {
  sessionId: string;
  data: string;
}

export interface BackgroundCommandState {
  id: string;
  command: BackgroundCommandKind;
  repo: string;
  status: BackgroundCommandStatus;
  title: string;
  detail: string;
  output: string;
  request?: string;
  issueNumber?: number;
  merge?: boolean;
  issueUrl?: string;
  logFile?: string;
  exitCode?: number | null;
  cancelled: boolean;
  pausePending?: boolean;
  origin?: 'auto' | 'manual';
  autoShipHalted?: boolean;
  retriable?: boolean;
}

export type ActiveShippingCommand = BackgroundCommandState & {
  command: 'ship';
  status: 'queued' | 'running';
  issueNumber: number;
};

export interface BackgroundToastItem {
  id: string;
  sessionId: string;
  variant: 'success' | 'error' | 'cancelled' | 'info';
  title: string;
  description: string;
  issueUrl?: string;
  issueLabel?: string;
  retryable?: boolean;
  retryPayload?: BackgroundRetryPayload;
}

export interface BackgroundLogViewerState {
  open: boolean;
  sessionId: string | null;
  title: string;
  content: string;
}

export interface BackgroundDetailInput {
  command: BackgroundCommandKind;
  status: BackgroundCommandStatus;
  repo: string;
  issueNumber?: number;
  merge?: boolean;
  latestOutput?: string | null;
  cancelled?: boolean;
  pausePending?: boolean;
  retriable?: boolean;
  origin?: 'auto' | 'manual';
}

export interface AutoShipCandidate {
  issue: ListIssueItem;
  priorityTier: 0 | 1 | 2;
  stageIndex: number;
  issueIndex: number;
}

export interface SelectNextAutoUnblockIssueResult {
  issue: ListIssueItem | null;
  remainingIssueNumbers: number[];
}

export interface AutoShipFailureState {
  consecutiveFailures: number;
  skippedIssueNumbers: Set<number>;
  pauseAutoShip: boolean;
}

export type { PipelineColumnLabel } from './lib/constants.js';
