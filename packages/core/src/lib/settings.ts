import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface PrReviewWait {
  mode: 'checks' | 'timer';
  timeoutMinutes: number;
}

export interface Settings {
  prReviewWait: PrReviewWait;
  lockTimeoutMinutes: number;
  agents: {
    default: 'claude' | 'codex';
    [step: string]: 'claude' | 'codex' | undefined;
  };
  headless?: {
    [command: string]: boolean;
  };
  defaultBaseBranch?: string;
  installCommand?: string;
  hooks: {
    worktreeSetup?: string;
    worktreeTeardown?: string;
  };
  cliVersion?: string;
}

export const DEFAULTS: Settings = {
  prReviewWait: { mode: 'checks', timeoutMinutes: 15 },
  lockTimeoutMinutes: 30,
  agents: { default: 'claude' as const },
  headless: {},
  hooks: {},
};

export const SETTING_DESCRIPTIONS: Record<string, string> = {
  prReviewWait: 'PR review wait strategy: { mode: "checks" | "timer", timeoutMinutes: number }',
  lockTimeoutMinutes: 'stale lock timeout (minutes) before auto-clearing shipper:locked',
  'agents.default':
    'default coding agent for all steps (supports per-step overrides via agents.<step>)',
  headless:
    'per-command map enabling headless mode by default for specific commands (e.g. { "new": true })',
  defaultBaseBranch: 'target branch for PRs (auto-detected from GitHub if not set)',
  installCommand:
    'shell command to install project dependencies (e.g. npm ci, pnpm install --frozen-lockfile)',
  'hooks.worktreeSetup':
    'shell command to run after a worktree is created (before the agent starts)',
  'hooks.worktreeTeardown': 'shell command to run before a worktree is removed',
};

let settings: Settings | undefined;

const KNOWN_PROMPT_COMMANDS = new Set([
  'new',
  'groom',
  'design',
  'plan',
  'implement',
  'pr_open',
  'pr_review',
  'pr_remediate',
  'unblock',
  'setup',
]);

export function loadSettings(): void {
  const basePath = path.resolve('.shipper', 'settings.json');
  const localPath = path.resolve('.shipper', 'settings.local.json');

  let base: Partial<Settings> = {};
  let local: Partial<Settings> = {};

  base = readSettingsFile(basePath);
  local = readSettingsFile(localPath);

  const baseAgents = isPlainObject(base?.agents) ? base.agents : {};
  const localAgents = isPlainObject(local?.agents) ? local.agents : {};
  const baseHeadless = isPlainObject(base?.headless) ? base.headless : {};
  const localHeadless = isPlainObject(local?.headless) ? local.headless : {};

  settings = {
    ...DEFAULTS,
    ...base,
    ...local,
    hooks: { ...DEFAULTS.hooks, ...base?.hooks, ...local?.hooks },
    agents: { ...DEFAULTS.agents, ...baseAgents, ...localAgents },
    headless: { ...DEFAULTS.headless, ...baseHeadless, ...localHeadless },
  };

  for (const command of Object.keys(settings.headless ?? {})) {
    if (!KNOWN_PROMPT_COMMANDS.has(command)) {
      console.warn(`Warning: Unknown command "${command}" in settings.headless.`);
    }
  }
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
    // Auto-migrate legacy "prReviewWaitMinutes" to "prReviewWait"
    if (typeof parsed.prReviewWaitMinutes === 'number' && !parsed.prReviewWait) {
      parsed.prReviewWait = { mode: 'timer', timeoutMinutes: parsed.prReviewWaitMinutes };
      delete parsed.prReviewWaitMinutes;
    }
    return parsed as Partial<Settings>;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: Malformed JSON in ${filepath}: ${message}`);
    process.exit(1);
  }
}
