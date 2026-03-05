import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface Settings {
  prReviewWaitMinutes: number;
  lockTimeoutMinutes: number;
  agents: {
    default: 'claude' | 'codex';
    [step: string]: 'claude' | 'codex' | undefined;
  };
  defaultBaseBranch?: string;
  hooks: {
    worktreeSetup?: string;
    worktreeTeardown?: string;
  };
}

export const DEFAULTS: Settings = {
  prReviewWaitMinutes: 15,
  lockTimeoutMinutes: 30,
  agents: { default: 'claude' as const },
  hooks: {},
};

export const SETTING_DESCRIPTIONS: Record<string, string> = {
  prReviewWaitMinutes: 'minimum wait (minutes) before PR review remediation',
  lockTimeoutMinutes: 'stale lock timeout (minutes) before auto-clearing shipper:locked',
  'agents.default': 'default coding agent for all steps (supports per-step overrides via agents.<step>)',
  defaultBaseBranch: 'target branch for PRs (auto-detected from GitHub if not set)',
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
    agents: { ...DEFAULTS.agents, ...base?.agents, ...local?.agents },
  };
}

export function getSettings(): Settings {
  return settings ?? { ...DEFAULTS };
}

export function resolveAgent(step: string): 'claude' | 'codex' {
  const s = getSettings();
  const agent = s.agents[step] ?? s.agents.default;
  if (agent !== 'claude' && agent !== 'codex') {
    console.error(
      `Error: Invalid agent "${agent}" for step "${step}". Must be "claude" or "codex".`
    );
    process.exit(1);
  }
  return agent;
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
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // Auto-migrate legacy "agent" string to "agents.default"
    if (typeof parsed.agent === 'string' && !parsed.agents) {
      parsed.agents = { default: parsed.agent };
      delete parsed.agent;
    }
    return parsed as Partial<Settings>;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: Malformed JSON in ${filepath}: ${message}`);
    process.exit(1);
  }
}
