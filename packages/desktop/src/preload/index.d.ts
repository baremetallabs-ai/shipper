import type { ListIssueItem } from '@dnsquared/shipper-core';

interface CheckResult {
  ok: boolean;
  message: string;
}

interface ConfigPayload {
  repo: string;
}

interface ListIssuesSuccess {
  ok: true;
  issues: ListIssueItem[];
}

interface ListIssuesFailure {
  ok: false;
  error: string;
}

interface ShipperAPI {
  checkPrerequisites: () => Promise<{
    ghInstalled: CheckResult;
    ghAuth: CheckResult;
  }>;
  getConfig: () => Promise<ConfigPayload>;
  listIssues: (repo: string) => Promise<ListIssuesSuccess | ListIssuesFailure>;
  setConfig: (config: ConfigPayload) => Promise<void>;
}

declare global {
  interface Window {
    shipperAPI: ShipperAPI;
  }
}

export {};
