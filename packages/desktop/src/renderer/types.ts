import type { ListIssueItem, WorkflowStage } from '@dnsquared/shipper-core';

import type { TerminalSessionTab } from './components/session-tab-bar.js';

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

export type TerminalSession = TerminalSessionTab;

export interface ResetSelection {
  issue: ListIssueItem;
  targetStage: WorkflowStage;
}

export type BackgroundCommandKind = 'new' | 'ship' | 'init' | 'unblock';

export type BackgroundCommandStatus = 'queued' | 'running' | 'complete' | 'failed';

export type BackgroundRetryPayload =
  | { command: 'new'; repo: string; request: string }
  | { command: 'ship'; repo: string; issueNumber: number; merge: boolean }
  | { command: 'init'; repo: string }
  | { command: 'unblock'; repo: string; issueNumber: number };

export interface BackgroundStatusMeta {
  issueNumber?: number;
  merge?: boolean;
  issueUrl?: string;
  logFile?: string;
  request?: string;
  cancelled?: boolean;
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
}

export type ActiveShippingCommand = BackgroundCommandState & {
  command: 'ship';
  status: 'queued' | 'running';
  issueNumber: number;
};

export interface BackgroundToastItem {
  id: string;
  sessionId: string;
  variant: 'success' | 'error' | 'cancelled';
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
