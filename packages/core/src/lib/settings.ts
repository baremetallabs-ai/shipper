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
  merge: MergeSettings;
  cliVersion?: string;
}

export const DEFAULTS: Settings = {
  prReviewWait: { mode: 'checks', timeoutMinutes: 15 },
  lockTimeoutMinutes: 30,
  agentTimeoutMinutes: 60,
  commands: { default: { agent: 'claude' as const } },
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

export async function loadSettings(): Promise<void> {
  const basePath = path.resolve('.shipper', 'settings.json');
  const localPath = path.resolve('.shipper', 'settings.local.json');

  let base: Partial<Settings> = {};
  let local: Partial<Settings> = {};

  base = await readSettingsFile(basePath);
  local = await readSettingsFile(localPath);

  const baseCommands: Record<string, unknown> = isPlainObject(base?.commands) ? base.commands : {};
  const localCommands: Record<string, unknown> = isPlainObject(local?.commands)
    ? local.commands
    : {};
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
    merge: { ...DEFAULTS.merge, ...base?.merge, ...local?.merge },
    commands: mergedCommands,
  };

  if ('hooks' in base || 'hooks' in local) {
    console.warn(
      'Warning: Unknown setting "hooks" — settings-based hooks have been removed. Use file-based hooks in .shipper/hooks/ instead.'
    );
  }

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
      merge: { ...DEFAULTS.merge },
    }
  );
}

export function resolveAgent(step: string, override?: AgentName): AgentName {
  if (override) {
    return override;
  }
  const s = getSettings();
  const agent = s.commands[step]?.agent ?? s.commands.default.agent;
  if (agent !== 'claude' && agent !== 'codex') {
    throw new Error(`Invalid agent "${agent}" for step "${step}". Must be "claude" or "codex".`);
  }
  return agent;
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
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // Auto-migrate legacy "agent" string to "agents.default"
    if (typeof parsed.agent === 'string' && !parsed.agents && !parsed.commands) {
      parsed.agents = { default: parsed.agent };
      delete parsed.agent;
    }
    // Auto-migrate legacy "prReviewWaitMinutes" to "prReviewWait"
    if (typeof parsed.prReviewWaitMinutes === 'number' && !parsed.prReviewWait) {
      parsed.prReviewWait = { mode: 'timer', timeoutMinutes: parsed.prReviewWaitMinutes };
      delete parsed.prReviewWaitMinutes;
    }
    if (parsed.agents && !parsed.commands) {
      const agents = isPlainObject(parsed.agents) ? parsed.agents : {};
      const commands: Record<string, CommandConfig> = {
        default: {
          agent: typeof agents.default === 'string' ? (agents.default as AgentName) : 'claude',
        },
      };

      for (const [step, agent] of Object.entries(agents)) {
        if (step === 'default' || !isSafeCommandKey(step)) continue;
        commands[step] = { ...commands[step], agent: agent as AgentName };
      }

      if (parsed.headless && isPlainObject(parsed.headless)) {
        for (const [step, enabled] of Object.entries(parsed.headless)) {
          if (enabled === true && isSafeCommandKey(step)) {
            commands[step] = { ...commands[step], mode: 'headless' };
          }
        }
        delete parsed.headless;
      }

      parsed.commands = commands;
      delete parsed.agents;
    }

    if (parsed.headless && !parsed.agents && !parsed.commands && isPlainObject(parsed.headless)) {
      const commands: Record<string, CommandConfig> = {
        default: { agent: 'claude' },
      };

      for (const [step, enabled] of Object.entries(parsed.headless)) {
        if (enabled === true && isSafeCommandKey(step)) {
          commands[step] = { ...commands[step], mode: 'headless' };
        }
      }

      parsed.commands = commands;
      delete parsed.headless;
    }

    return parsed as Partial<Settings>;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Malformed JSON in ${filepath}: ${message}`);
  }
}
