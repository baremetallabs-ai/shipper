import { gh, isPlainObject, toErrorMessage } from '@dnsquared/shipper-core';

export interface AdoptIssuePayload {
  repo: string;
  issueNumber: number;
}

export interface RawResetIssueData {
  number: number;
  state: string;
  labels: { name: string }[];
}

export const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function parseRepo(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const repo = value.trim();
  return repoPattern.test(repo) ? repo : null;
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function parseRepoPayload(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('repo' in value)) {
    return null;
  }

  return parseRepo(value.repo);
}

export function parseAdoptIssuePayload(value: unknown): AdoptIssuePayload | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('repo' in value) ||
    !('issueNumber' in value)
  ) {
    return null;
  }

  const repo = parseRepo(value.repo);
  if (repo === null || !isPositiveInteger(value.issueNumber)) {
    return null;
  }

  return {
    repo,
    issueNumber: value.issueNumber,
  };
}

export function parseResetIssueJson(
  repo: string,
  issueNumber: number,
  json: string
): RawResetIssueData {
  try {
    const parsed: unknown = JSON.parse(json);
    if (
      !isPlainObject(parsed) ||
      typeof parsed.number !== 'number' ||
      typeof parsed.state !== 'string' ||
      !Array.isArray(parsed.labels)
    ) {
      throw new Error('GitHub CLI returned an invalid issue payload.');
    }

    return {
      number: parsed.number,
      state: parsed.state,
      labels: parsed.labels.map((label) => {
        if (!isPlainObject(label) || typeof label.name !== 'string') {
          throw new Error('GitHub CLI returned an invalid issue label.');
        }

        return { name: label.name };
      }),
    };
  } catch (error) {
    const message = toErrorMessage(error);
    throw new Error(`Failed to fetch reset data for issue #${issueNumber} in ${repo}: ${message}`);
  }
}

export async function loadResetIssue(
  repo: string,
  issueNumber: number
): Promise<RawResetIssueData> {
  const result = await gh([
    'issue',
    'view',
    String(issueNumber),
    '-R',
    repo,
    '--json',
    'number,state,labels',
  ]);

  return parseResetIssueJson(repo, issueNumber, result.stdout);
}
