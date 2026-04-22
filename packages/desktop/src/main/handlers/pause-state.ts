import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { app, ipcMain } from 'electron';

import { isPositiveInteger, parseRepo } from './shared.js';

type PauseState = Record<string, number[]>;

interface ParsePauseStateResult {
  state: PauseState;
  changed: boolean;
}

interface PauseIssuePayload {
  repo: string;
  issueNumber: number;
}

function getPauseStatePath(): string {
  return join(app.getPath('userData'), 'pause-state.json');
}

function parsePauseIssuePayload(value: unknown): PauseIssuePayload | null {
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

  return { repo, issueNumber: value.issueNumber };
}

function parsePauseState(value: unknown): ParsePauseStateResult | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  const state: PauseState = {};
  let changed = false;

  for (const [rawRepo, rawIssueNumbers] of Object.entries(value)) {
    const repo = parseRepo(rawRepo);
    if (repo === null || !Array.isArray(rawIssueNumbers)) {
      changed = true;
      continue;
    }

    const issueNumbers = [...new Set(rawIssueNumbers.filter(isPositiveInteger))].sort(
      (left, right) => left - right
    );

    if (issueNumbers.length !== rawIssueNumbers.length) {
      changed = true;
    } else if (!rawIssueNumbers.every((number, index) => number === issueNumbers[index])) {
      changed = true;
    }

    if (issueNumbers.length === 0) {
      changed = true;
      continue;
    }

    state[repo] = issueNumbers;
    if (repo !== rawRepo) {
      changed = true;
    }
  }

  return { state, changed };
}

function readPauseState(): PauseState {
  const pauseStatePath = getPauseStatePath();

  try {
    const parsed = JSON.parse(readFileSync(pauseStatePath, 'utf8')) as unknown;
    const parsedState = parsePauseState(parsed);
    if (parsedState !== null) {
      if (parsedState.changed) {
        writePauseState(parsedState.state);
      }

      return parsedState.state;
    }

    return {};
  } catch (error) {
    if (error instanceof SyntaxError) {
      return {};
    }

    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return {};
    }

    throw error;
  }
}

function writePauseState(state: PauseState): void {
  const pauseStatePath = getPauseStatePath();
  mkdirSync(dirname(pauseStatePath), { recursive: true });
  writeFileSync(pauseStatePath, JSON.stringify(state, null, 2), 'utf8');
}

function listPausedIssues(repo: string): number[] {
  return [...(readPauseState()[repo] ?? [])];
}

function addPausedIssue(repo: string, issueNumber: number): void {
  const state = readPauseState();
  const issueNumbers = new Set(state[repo] ?? []);
  issueNumbers.add(issueNumber);
  state[repo] = [...issueNumbers].sort((left, right) => left - right);
  writePauseState(state);
}

function removePausedIssue(repo: string, issueNumber: number): void {
  const state = readPauseState();
  const issueNumbers = (state[repo] ?? []).filter((value) => value !== issueNumber);
  if (issueNumbers.length > 0) {
    writePauseState({ ...state, [repo]: issueNumbers });
    return;
  }

  const { [repo]: _removedRepo, ...nextState } = state;
  writePauseState(nextState);
}

export function registerPauseStateHandlers(): void {
  ipcMain.handle('pause-state:list', (_event, payload: unknown) => {
    const repo = parseRepo(payload);
    if (repo === null) {
      throw new Error('Invalid pause-state:list payload.');
    }

    return listPausedIssues(repo);
  });

  ipcMain.handle('pause-state:add', (_event, payload: unknown) => {
    const parsedPayload = parsePauseIssuePayload(payload);
    if (parsedPayload === null) {
      throw new Error('Invalid pause-state:add payload.');
    }

    addPausedIssue(parsedPayload.repo, parsedPayload.issueNumber);
  });

  ipcMain.handle('pause-state:remove', (_event, payload: unknown) => {
    const parsedPayload = parsePauseIssuePayload(payload);
    if (parsedPayload === null) {
      throw new Error('Invalid pause-state:remove payload.');
    }

    removePausedIssue(parsedPayload.repo, parsedPayload.issueNumber);
  });
}
