import { ipcMain } from 'electron';
import {
  gh,
  listIssues,
  LOCKED_LABEL,
  PRIORITY_HIGH_LABEL,
  PRIORITY_LOW_LABEL,
  toErrorMessage,
  type ListIssueItem,
} from '@dnsquared/shipper-core';

import { loadResetIssue, parseAdoptIssuePayload, parseRepoPayload } from './shared.js';

interface ListIssuesSuccess {
  ok: true;
  issues: Awaited<ReturnType<typeof listIssues>>;
}

interface ListIssuesFailure {
  ok: false;
  error: string;
}

interface RawListIssueData {
  number: number;
  title: string;
  state: string;
  labels: { name: string }[];
  author: { login: string } | null;
  createdAt: string;
  url: string;
}

function parseIssueListJson(repo: string, json: string): RawListIssueData[] {
  try {
    return JSON.parse(json) as RawListIssueData[];
  } catch (error) {
    const message = toErrorMessage(error);
    const preview = json.length > 200 ? `${json.slice(0, 200)}…` : json;
    throw new Error(`Failed to list adoptable issues for ${repo}: ${message}. Output: ${preview}`);
  }
}

export function registerIssueHandlers(): void {
  ipcMain.handle('list-issues', async (_event, payload: unknown) => {
    const repo = parseRepoPayload(payload);

    if (repo === null) {
      const response: ListIssuesFailure = {
        ok: false,
        error: 'Enter a repository in owner/repo format.',
      };
      return response;
    }

    try {
      const issues = await listIssues(repo);
      const response: ListIssuesSuccess = { ok: true, issues };
      return response;
    } catch (error) {
      const message = toErrorMessage(error);
      const response: ListIssuesFailure = { ok: false, error: message };
      return response;
    }
  });

  ipcMain.handle('list-adoptable-issues', async (_event, payload: unknown) => {
    const repo = parseRepoPayload(payload);

    if (repo === null) {
      const response: ListIssuesFailure = {
        ok: false,
        error: 'Enter a repository in owner/repo format.',
      };
      return response;
    }

    try {
      const result = await gh([
        'issue',
        'list',
        '-R',
        repo,
        '--state',
        'open',
        '--limit',
        '1000',
        '--json',
        'number,title,labels,state,author,createdAt,url',
      ]);
      const rawIssues = parseIssueListJson(repo, result.stdout);
      const issues: ListIssueItem[] = rawIssues
        .map((issue) => ({
          number: issue.number,
          title: issue.title,
          labels: issue.labels.map((label) => label.name),
          state: issue.state,
          author: issue.author?.login ?? 'ghost',
          createdAt: issue.createdAt,
          url: issue.url,
        }))
        .filter((issue) => !issue.labels.some((label) => label.startsWith('shipper:')));
      const response: ListIssuesSuccess = { ok: true, issues };
      return response;
    } catch (error) {
      const message = toErrorMessage(error);
      const response: ListIssuesFailure = { ok: false, error: message };
      return response;
    }
  });

  ipcMain.handle('close-not-planned', async (_event, payload: unknown) => {
    const parsedPayload = parseAdoptIssuePayload(payload);
    if (parsedPayload === null) {
      return {
        ok: false,
        error: 'Enter a repository in owner/repo format and a positive issue number.',
      };
    }

    try {
      const issue = await loadResetIssue(parsedPayload.repo, parsedPayload.issueNumber);
      if (issue.state !== 'OPEN') {
        return {
          ok: false,
          error: `Issue #${issue.number} is already closed.`,
        };
      }

      if (issue.labels.some((label) => label.name === LOCKED_LABEL)) {
        return {
          ok: false,
          error: `Issue #${issue.number} is locked. Close as not planned is unavailable until that run finishes.`,
        };
      }

      await gh([
        'issue',
        'close',
        String(issue.number),
        '-R',
        parsedPayload.repo,
        '--reason',
        'not planned',
      ]);

      const shipperLabels = issue.labels
        .map((label) => label.name)
        .filter((label) => label.startsWith('shipper:'));
      if (shipperLabels.length > 0) {
        await gh([
          'issue',
          'edit',
          String(issue.number),
          '-R',
          parsedPayload.repo,
          '--remove-label',
          shipperLabels.join(','),
        ]);
      }

      return { ok: true };
    } catch (error) {
      const message = toErrorMessage(error);
      return { ok: false, error: message };
    }
  });

  ipcMain.handle('set-priority', async (_event, payload: unknown) => {
    const parsedPayload = parseAdoptIssuePayload(payload);
    if (parsedPayload === null) {
      return {
        ok: false,
        error: 'Enter a repository in owner/repo format and a positive issue number.',
      };
    }

    const level =
      typeof payload === 'object' && payload !== null && 'level' in payload ? payload.level : null;
    if (level !== 'high' && level !== 'normal' && level !== 'low') {
      return { ok: false, error: 'Invalid priority level.' };
    }

    try {
      const args = ['issue', 'edit', String(parsedPayload.issueNumber), '-R', parsedPayload.repo];
      if (level === 'high') {
        args.push('--add-label', PRIORITY_HIGH_LABEL, '--remove-label', PRIORITY_LOW_LABEL);
      } else if (level === 'low') {
        args.push('--add-label', PRIORITY_LOW_LABEL, '--remove-label', PRIORITY_HIGH_LABEL);
      } else {
        args.push('--remove-label', PRIORITY_HIGH_LABEL, '--remove-label', PRIORITY_LOW_LABEL);
      }

      await gh(args);
      return { ok: true };
    } catch (error) {
      const message = toErrorMessage(error);
      return { ok: false, error: message };
    }
  });

  ipcMain.handle('adopt-issue', async (_event, payload: unknown) => {
    const parsedPayload = parseAdoptIssuePayload(payload);
    if (parsedPayload === null) {
      return {
        ok: false,
        error: 'Enter a repository in owner/repo format and a positive issue number.',
      };
    }

    try {
      await gh([
        'issue',
        'edit',
        String(parsedPayload.issueNumber),
        '-R',
        parsedPayload.repo,
        '--add-label',
        'shipper:new',
      ]);
      return { ok: true };
    } catch (error) {
      const message = toErrorMessage(error);
      return { ok: false, error: message };
    }
  });
}
