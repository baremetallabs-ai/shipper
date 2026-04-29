import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type IpcHandler = (event: unknown, payload: unknown) => unknown;

let mockUserDataPath = '';

const state = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => mockUserDataPath,
  },
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => {
      state.handlers.set(channel, handler);
    },
  },
}));

async function loadHandlers(): Promise<Map<string, IpcHandler>> {
  vi.resetModules();
  state.handlers.clear();

  const { registerPauseStateHandlers } = await import('../src/main/handlers/pause-state.js');
  registerPauseStateHandlers();

  return state.handlers;
}

function getHandler(name: string): IpcHandler {
  const handler = state.handlers.get(name);
  if (!handler) {
    throw new Error(`Missing IPC handler: ${name}`);
  }

  return handler;
}

beforeEach(() => {
  mockUserDataPath = mkdtempSync(join(tmpdir(), 'shipper-pause-state-'));
});

afterEach(() => {
  state.handlers.clear();
  if (mockUserDataPath) {
    rmSync(mockUserDataPath, { recursive: true, force: true });
    mockUserDataPath = '';
  }
});

describe('pause-state handlers', () => {
  it('returns an empty list when the pause-state file does not exist', async () => {
    await loadHandlers();
    const handler = getHandler('pause-state:list');

    expect(handler({}, 'owner/repo')).toEqual([]);
  }, 10_000);

  it('falls back to an empty list when the pause-state file contains malformed JSON', async () => {
    await loadHandlers();
    writeFileSync(join(mockUserDataPath, 'pause-state.json'), '{not-json', 'utf8');
    const handler = getHandler('pause-state:list');

    expect(handler({}, 'owner/repo')).toEqual([]);
  });

  it('keeps paused issues separated by repo', async () => {
    await loadHandlers();
    const addHandler = getHandler('pause-state:add');
    const listHandler = getHandler('pause-state:list');

    await addHandler({}, { repo: 'owner/repo', issueNumber: 42 });
    await addHandler({}, { repo: 'other/repo', issueNumber: 7 });

    expect(listHandler({}, 'owner/repo')).toEqual([42]);
    expect(listHandler({}, 'other/repo')).toEqual([7]);
  });

  it('adds issues idempotently and stores a deduplicated sorted list', async () => {
    await loadHandlers();
    const addHandler = getHandler('pause-state:add');

    await addHandler({}, { repo: 'owner/repo', issueNumber: 42 });
    await addHandler({}, { repo: 'owner/repo', issueNumber: 5 });
    await addHandler({}, { repo: 'owner/repo', issueNumber: 42 });

    expect(JSON.parse(readFileSync(join(mockUserDataPath, 'pause-state.json'), 'utf8'))).toEqual({
      'owner/repo': [5, 42],
    });
  });

  it('removes issues idempotently without affecting other repos', async () => {
    await loadHandlers();
    const addHandler = getHandler('pause-state:add');
    const removeHandler = getHandler('pause-state:remove');
    const listHandler = getHandler('pause-state:list');

    await addHandler({}, { repo: 'owner/repo', issueNumber: 42 });
    await addHandler({}, { repo: 'owner/repo', issueNumber: 7 });
    await addHandler({}, { repo: 'other/repo', issueNumber: 9 });

    await removeHandler({}, { repo: 'owner/repo', issueNumber: 42 });
    await removeHandler({}, { repo: 'owner/repo', issueNumber: 42 });

    expect(listHandler({}, 'owner/repo')).toEqual([7]);
    expect(listHandler({}, 'other/repo')).toEqual([9]);
  });

  it('persists pause state across handler reloads', async () => {
    await loadHandlers();
    const addHandler = getHandler('pause-state:add');
    await addHandler({}, { repo: 'owner/repo', issueNumber: 42 });

    await loadHandlers();
    const listHandler = getHandler('pause-state:list');

    expect(listHandler({}, 'owner/repo')).toEqual([42]);
  });
});
