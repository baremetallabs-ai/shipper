import { readFile } from 'node:fs/promises';
import path from 'node:path';

export type AgentName = 'claude' | 'codex';
export type CommandMode = 'headless' | 'interactive' | 'default';

export interface PrReviewWait {
  mode: 'checks' | 'timer';
  timeoutMinutes: number;
}

export interface CommandConfig {
  mode?: CommandMode;
  agent?: AgentName;
  model?: string;
}

export interface MergeSettings {
  requirePassingChecks: boolean;
}

export interface Settings {
  prReviewWait: PrReviewWait;
  lockTimeoutMinutes: number;
  agentTimeoutMinutes: number;
  commands: {
    default: CommandConfig & { agent: AgentName };
    [step: string]: CommandConfig | undefined;
  };
  defaultBaseBranch?: string;
  installCommand?: string;
  worktreeEnv?: Record<string, string>;
  hooks: {
    worktreeSetup?: string;
    worktreeTeardown?: string;
  };
  merge: MergeSettings;
  cliVersion?: string;
}

export const DEFAULTS: Settings = {
  prReviewWait: { mode: 'checks', timeoutMinutes: 15 },
  lockTimeoutMinutes: 30,
  agentTimeoutMinutes: 60,
  commands: { default: { agent: 'claude' as const } },
  hooks: {},
  merge: { requirePassingChecks: true },
};

export const SETTING_DESCRIPTIONS: Record<string, string> = {
  prReviewWait: 'PR review wait strategy: { mode: "checks" | "timer", timeoutMinutes: number }',
  lockTimeoutMinutes: 'stale lock timeout (minutes) before auto-clearing shipper:locked',
  agentTimeoutMinutes: 'agent process timeout in headless mode (minutes); 0 to disable',
  commands:
    'per-command settings map (e.g. { "default": { "agent": "claude" }, "groom": { "mode": "headless" } })',
  'commands.default.agent':
    'default coding agent for all steps (supports per-step overrides via commands.<step>.agent)',
  'commands.default.model':
    'default model override for all steps (supports per-step overrides via commands.<step>.model)',
  'commands.default.mode':
    'default execution mode for prompt-running commands: "headless", "interactive", or "default"',
  defaultBaseBranch: 'target branch for PRs (auto-detected from GitHub if not set)',
  installCommand:
    'shell command to install project dependencies (e.g. npm ci, pnpm install --frozen-lockfile)',
  worktreeEnv:
    'flat env-var map applied inside worktree execution; values are passed through exactly as configured',
  'hooks.worktreeSetup':
    'shell command to run after a worktree is created (before the agent starts)',
  'hooks.worktreeTeardown': 'shell command to run before a worktree is removed',
  'merge.requirePassingChecks': 'require all CI checks to pass before auto-merging (default: true)',
};

let settings: Settings | undefined;
const UNSAFE_COMMAND_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

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

function getObjectValue(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

export async function loadSettings(): Promise<void> {
  const basePath = path.resolve('.shipper', 'settings.json');
  const localPath = path.resolve('.shipper', 'settings.local.json');

  let base: Partial<Settings> = {};
  let local: Partial<Settings> = {};

  base = await readSettingsFile(basePath);
  local = await readSettingsFile(localPath);

  const baseCommands: Record<string, unknown> = getObjectValue(base.commands);
  const localCommands: Record<string, unknown> = getObjectValue(local.commands);
  const baseHooks = getObjectValue(base.hooks);
  const localHooks = getObjectValue(local.hooks);
  const baseMerge = getObjectValue(base.merge);
  const localMerge = getObjectValue(local.merge);
  const allCommandSteps = new Set([
    ...Object.keys(baseCommands).filter(isSafeCommandKey),
    ...Object.keys(localCommands).filter(isSafeCommandKey),
    'default',
  ]);
  const mergedCommands = {
    default: { ...DEFAULTS.commands.default },
  } as Settings['commands'];

  for (const step of allCommandSteps) {
    const baseConfig = isPlainObject(baseCommands[step]) ? baseCommands[step] : {};
    const localConfig = isPlainObject(localCommands[step]) ? localCommands[step] : {};
    if (step === 'default') {
      mergedCommands.default = {
        ...DEFAULTS.commands.default,
        ...baseConfig,
        ...localConfig,
      } as Settings['commands']['default'];
      continue;
    }

    mergedCommands[step] = {
      ...baseConfig,
      ...localConfig,
    } as CommandConfig;
  }

  settings = {
    ...DEFAULTS,
    ...base,
    ...local,
    hooks: { ...DEFAULTS.hooks, ...baseHooks, ...localHooks },
    merge: { ...DEFAULTS.merge, ...baseMerge, ...localMerge },
    commands: mergedCommands,
  };

  for (const [command, config] of Object.entries(settings.commands)) {
    validateModel(config?.model, command);
  }

  for (const command of Object.keys(settings.commands)) {
    if (command !== 'default' && !KNOWN_PROMPT_COMMANDS.has(command)) {
      console.warn(`Warning: Unknown command "${command}" in settings.commands.`);
    }
  }
}

export function getSettings(): Settings {
  return (
    settings ?? {
      ...DEFAULTS,
      commands: { default: { ...DEFAULTS.commands.default } },
      hooks: { ...DEFAULTS.hooks },
      merge: { ...DEFAULTS.merge },
    }
  );
}

export function resolveAgent(step: string, override?: AgentName): AgentName {
  if (override) {
    return override;
  }
  const s = getSettings();
  const rawAgent: unknown = s.commands[step]?.agent ?? s.commands.default.agent;
  if (rawAgent !== 'claude' && rawAgent !== 'codex') {
    throw new Error(
      `Invalid agent "${String(rawAgent)}" for step "${step}". Must be "claude" or "codex".`
    );
  }
  return rawAgent;
}

export function resolveMode(step: string, override?: CommandMode): CommandMode {
  if (override && override !== 'default') {
    return validateMode(override, step);
  }

  const s = getSettings();
  const mode = s.commands[step]?.mode ?? s.commands.default.mode;
  if (mode === undefined) {
    return 'default';
  }
  return validateMode(mode, step);
}

export function resolveModel(step: string, override?: string): string | undefined {
  if (override) {
    return override;
  }

  const s = getSettings();
  return validateModel(s.commands[step]?.model ?? s.commands.default.model, step);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeCommandKey(key: string): boolean {
  return !UNSAFE_COMMAND_KEYS.has(key);
}

function validateMode(mode: unknown, step: string): CommandMode {
  if (mode === 'headless' || mode === 'interactive' || mode === 'default') {
    return mode;
  }

  throw new Error(
    `Invalid mode "${String(mode)}" for step "${step}". Must be "headless", "interactive", or "default".`
  );
}

function validateModel(model: unknown, step: string): string | undefined {
  if (model === undefined || typeof model === 'string') {
    return model;
  }

  throw new Error(`Invalid model for step "${step}". Must be a string.`);
}

async function readSettingsFile(filepath: string): Promise<Partial<Settings>> {
  let raw: string;
  try {
    raw = await readFile(filepath, 'utf-8');
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as { code: string }).code === 'ENOENT') {
      return {};
    }
    throw err;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainObject(parsed)) {
      throw new Error('Settings file must contain a JSON object.');
    }

    const normalized: Record<string, unknown> = { ...parsed };
    // Auto-migrate legacy "agent" string to "agents.default"
    if (typeof normalized.agent === 'string' && !normalized.agents && !normalized.commands) {
      normalized.agents = { default: normalized.agent };
      delete normalized.agent;
    }
    // Auto-migrate legacy "prReviewWaitMinutes" to "prReviewWait"
    if (typeof normalized.prReviewWaitMinutes === 'number' && !normalized.prReviewWait) {
      normalized.prReviewWait = {
        mode: 'timer',
        timeoutMinutes: normalized.prReviewWaitMinutes,
      };
      delete normalized.prReviewWaitMinutes;
    }
    if (normalized.agents && !normalized.commands) {
      const agents = getObjectValue(normalized.agents);
      const commands: Record<string, CommandConfig> = {
        default: {
          agent: typeof agents.default === 'string' ? (agents.default as AgentName) : 'claude',
        },
      };

      for (const [step, agent] of Object.entries(agents)) {
        if (step === 'default' || !isSafeCommandKey(step)) continue;
        commands[step] = { ...commands[step], agent: agent as AgentName };
      }

      if (normalized.headless && isPlainObject(normalized.headless)) {
        for (const [step, enabled] of Object.entries(normalized.headless)) {
          if (enabled === true && isSafeCommandKey(step)) {
            commands[step] = { ...commands[step], mode: 'headless' };
          }
        }
        delete normalized.headless;
      }

      normalized.commands = commands;
      delete normalized.agents;
    }

    if (
      normalized.headless &&
      !normalized.agents &&
      !normalized.commands &&
      isPlainObject(normalized.headless)
    ) {
      const commands: Record<string, CommandConfig> = {
        default: { agent: 'claude' },
      };

      for (const [step, enabled] of Object.entries(normalized.headless)) {
        if (enabled === true && isSafeCommandKey(step)) {
          commands[step] = { ...commands[step], mode: 'headless' };
        }
      }

      normalized.commands = commands;
      delete normalized.headless;
    }

    return normalized as Partial<Settings>;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Malformed JSON in ${filepath}: ${message}`);
  }
}
