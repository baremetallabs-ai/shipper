import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface Settings {
  prReviewWaitMinutes: number;
  lockTimeoutMinutes: number;
  hooks: {
    postMerge?: string;
    worktreeSetup?: string;
    worktreeTeardown?: string;
  };
}

export const DEFAULTS: Settings = {
  prReviewWaitMinutes: 15,
  lockTimeoutMinutes: 30,
  hooks: {},
};

export const SETTING_DESCRIPTIONS: Record<string, string> = {
  prReviewWaitMinutes: 'minimum wait (minutes) before PR review remediation',
  lockTimeoutMinutes: 'stale lock timeout (minutes) before auto-clearing shipper:locked',
  'hooks.postMerge': 'shell command to run after a PR is merged',
  'hooks.worktreeSetup':
    'shell command to run after a worktree is created (before the agent starts)',
  'hooks.worktreeTeardown': 'shell command to run before a worktree is removed',
};

let settings: Settings | undefined;

export function loadSettings(): void {
  const basePath = path.resolve('.shipper', 'settings.json');
  const localPath = path.resolve('.shipper', 'settings.local.json');

  let base: Partial<Settings> = {};
  let local: Partial<Settings> = {};

  base = readSettingsFile(basePath);
  local = readSettingsFile(localPath);

  settings = {
    ...DEFAULTS,
    ...base,
    ...local,
    hooks: { ...DEFAULTS.hooks, ...base?.hooks, ...local?.hooks },
  };
}

export function getSettings(): Settings {
  return settings ?? { ...DEFAULTS };
}

function readSettingsFile(filepath: string): Partial<Settings> {
  let raw: string;
  try {
    raw = readFileSync(filepath, 'utf-8');
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as { code: string }).code === 'ENOENT') {
      return {};
    }
    throw err;
  }

  try {
    return JSON.parse(raw) as Partial<Settings>;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: Malformed JSON in ${filepath}: ${message}`);
    process.exit(1);
  }
}
