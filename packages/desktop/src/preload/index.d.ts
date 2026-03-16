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
  listRepos: () => Promise<string[]>;
  listIssues: (repo: string) => Promise<ListIssuesSuccess | ListIssuesFailure>;
  setConfig: (config: ConfigPayload) => Promise<void>;

  spawnShipperNew: (
    request: string,
    repo: string,
    cols: number,
    rows: number
  ) => Promise<{ sessionId: string }>;
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
