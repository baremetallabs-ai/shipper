import type { ListIssueItem } from '@dnsquared/shipper-core';

interface CheckResult {
  ok: boolean;
  message: string;
}

interface ConfigPayload {
  repos: string[];
  activeRepo: string;
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

  spawnShipperNew: (
    request: string,
    repo: string,
    cols: number,
    rows: number
  ) => Promise<{ sessionId: string }>;
  spawnShipperGroom: (
    issueNumber: number,
    repo: string,
    cols: number,
    rows: number
  ) => Promise<{ sessionId: string }>;
  spawnShipperShip: (
    issueNumber: number,
    repo: string,
    cols: number,
    rows: number
  ) => Promise<{ sessionId: string }>;
  spawnShipperInit: (repo: string, cols: number, rows: number) => Promise<{ sessionId: string }>;
  ptyWrite: (sessionId: string, data: string) => Promise<void>;
  ptyResize: (sessionId: string, cols: number, rows: number) => Promise<void>;
  ptyKill: (sessionId: string) => Promise<void>;
  onPtyOutput: (callback: (data: PtyOutputEvent) => void) => () => void;
  onPtyExit: (callback: (data: PtyExitEvent) => void) => () => void;
}

declare global {
  interface Window {
    shipperAPI: ShipperAPI;
  }
}

export {};
