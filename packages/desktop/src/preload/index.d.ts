import type { ListIssueItem, TokenUsage } from '@baremetallabs-ai/shipper-core';

interface CheckResult {
  ok: boolean;
  message: string;
}

interface ConfigPayload {
  repos: string[];
  activeRepo: string;
  autoMergeRepos: string[];
}

type RepoPickerRepository =
  | { nameWithOwner: string; group: 'owner' }
  | { nameWithOwner: string; group: 'other' }
  | { nameWithOwner: string; group: 'organization'; organizationLogin: string };

type RepoPickerSearchRepository = Extract<RepoPickerRepository, { group: 'owner' | 'other' }>;

interface RepoPickerSearchResult {
  repositories: RepoPickerSearchRepository[];
  pageInfo: {
    hasNextPage: boolean;
    endCursor: string | null;
  };
}

interface PipelineIssue extends ListIssueItem {
  tokenUsage: TokenUsage;
}

interface ListIssuesSuccess {
  ok: true;
  issues: PipelineIssue[];
}

interface ListAdoptableIssuesSuccess {
  ok: true;
  issues: ListIssueItem[];
}

interface ListIssuesFailure {
  ok: false;
  error: string;
}

interface TimelineLabelEvent {
  event: string;
  label?: {
    name: string;
  } | null;
  created_at?: string;
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
  listAdoptableIssues: (repo: string) => Promise<ListAdoptableIssuesSuccess | ListIssuesFailure>;
  listRepos: () => Promise<RepoPickerRepository[]>;
  searchRepos: (request: {
    query: string;
    cursor?: string | null;
  }) => Promise<RepoPickerSearchResult>;
  listIssues: (repo: string) => Promise<ListIssuesSuccess | ListIssuesFailure>;
  fetchIssueTimelines: (
    repo: string,
    issueNumbers: number[]
  ) => Promise<Map<number, TimelineLabelEvent[]>>;
  listPausedIssues: (repo: string) => Promise<number[]>;
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
  spawnShipperSetup: (
    repo: string,
    cols: number,
    rows: number
  ) => Promise<{
    sessionId: string;
  }>;
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
  ptyCloseState: (sessionId: string) => Promise<PtyCloseState>;
  ptyFinalize: (sessionId: string) => Promise<void>;
  ptyForceKill: (sessionId: string) => Promise<void>;
  onPtyOutput: (callback: (data: PtyOutputEvent) => void) => () => void;
  onPtyExit: (callback: (data: PtyExitEvent) => void) => () => void;
  onPtyStatus: (callback: (data: PtyStatusEvent) => void) => () => void;
  onBackgroundStatus: (callback: (data: BackgroundStatusEvent) => void) => () => void;
  onBackgroundOutput: (callback: (data: BackgroundOutputEvent) => void) => () => void;
}

declare global {
  interface Window {
    shipperAPI: ShipperAPI;
  }
}

export {};
