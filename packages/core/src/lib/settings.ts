import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { toErrorMessage } from './errors.js';
import { isMcpGroomingEnabled } from './feature-flags.js';
import { logger } from './logger.js';
import { isPlainObject } from './type-guards.js';

export type AgentName = 'claude' | 'codex' | 'copilot';
export type CommandMode = 'headless' | 'interactive' | 'default';

export type PrReviewWait =
  | { mode: 'timer'; durationMinutes: number }
  | { mode: 'checks'; minDurationMinutes?: number; maxDurationMinutes?: number };

export interface CommandConfig {
  mode?: CommandMode;
  agent?: AgentName;
  model?: string;
  disableMcp?: boolean;
}

export interface MergeSettings {
  requirePassingChecks: boolean;
}

export interface Settings {
  prReviewWait: PrReviewWait;
  lockTimeoutMinutes: number;
  agentTimeoutMinutes: number;
  hookTimeoutMinutes: number;
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
  prReviewWait: { mode: 'checks', maxDurationMinutes: 30 },
  lockTimeoutMinutes: 30,
  agentTimeoutMinutes: 60,
  hookTimeoutMinutes: 10,
  commands: {
    default: { agent: 'claude' as const },
    groom: { disableMcp: true },
  },
  merge: { requirePassingChecks: true },
};

export const SETTING_DESCRIPTIONS: Record<string, string> = {
  prReviewWait:
    'PR review wait strategy: { mode: "timer", durationMinutes: number } | { mode: "checks", minDurationMinutes?: number, maxDurationMinutes?: number }',
  lockTimeoutMinutes: 'stale lock timeout (minutes) before auto-clearing shipper:locked',
  agentTimeoutMinutes: 'agent process timeout in headless mode (minutes); 0 to disable',
  hookTimeoutMinutes: 'file-based hook and worktree install timeout (minutes); 0 to disable',
  commands:
    'per-command settings map (e.g. { "default": { "agent": "claude" }, "groom": { "mode": "headless" } })',
  'commands.default.agent':
    'default coding agent for all steps (supports per-step overrides via commands.<step>.agent)',
  'commands.default.model':
    'default model override for all steps (supports per-step overrides via commands.<step>.model)',
  'commands.default.mode':
    'default execution mode for prompt-running commands: "headless", "interactive", or "default"',
  'commands.default.disableMcp':
    'default MCP loading policy for prompt-running commands; when true, suppresses all MCP servers for that invocation',
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
  settings = await loadSettingsFromDir(process.cwd());
}

export async function loadSettingsFromDir(repoPath: string): Promise<Settings> {
  const basePath = path.resolve(repoPath, '.shipper', 'settings.json');
  const localPath = path.resolve(repoPath, '.shipper', 'settings.local.json');

  let base: Partial<Settings> = {};
  let local: Partial<Settings> = {};

  base = await readSettingsFile(basePath);
  local = await readSettingsFile(localPath);

  return mergeSettings(base, local);
}

function mergeSettings(base: Partial<Settings>, local: Partial<Settings>): Settings {
  const baseCommands: Record<string, unknown> = isPlainObject(base.commands) ? base.commands : {};
  const localCommands: Record<string, unknown> = isPlainObject(local.commands)
    ? local.commands
    : {};
  const allCommandSteps = new Set([
    ...Object.keys(DEFAULTS.commands).filter(isSafeCommandKey),
    ...Object.keys(baseCommands).filter(isSafeCommandKey),
    ...Object.keys(localCommands).filter(isSafeCommandKey),
    'default',
  ]);
  const mergedCommands: Settings['commands'] = {
    ...Object.fromEntries(
      Object.entries(DEFAULTS.commands).map(([step, config]) => [step, { ...config }])
    ),
    default: { ...DEFAULTS.commands.default },
  };

  for (const step of allCommandSteps) {
    const baseConfig = isPlainObject(baseCommands[step]) ? baseCommands[step] : {};
    const localConfig = isPlainObject(localCommands[step]) ? localCommands[step] : {};
    if (step === 'default') {
      mergedCommands.default = {
        ...DEFAULTS.commands.default,
        ...baseConfig,
        ...localConfig,
      };
      continue;
    }

    mergedCommands[step] = {
      ...DEFAULTS.commands[step],
      ...baseConfig,
      ...localConfig,
    };
  }

  const mergedSettings: Settings = {
    ...DEFAULTS,
    ...base,
    ...local,
    merge: { ...DEFAULTS.merge, ...base.merge, ...local.merge },
    commands: mergedCommands,
  };

  if ((isPlainObject(base) && 'hooks' in base) || (isPlainObject(local) && 'hooks' in local)) {
    logger.warn(
      'Warning: Unknown setting "hooks" — settings-based hooks have been removed. Use file-based hooks in .shipper/hooks/ instead.'
    );
  }

  for (const [command, config] of Object.entries(mergedSettings.commands)) {
    validateModel(config?.model, command);
    validateDisableMcp(config?.disableMcp, command);
  }
  validateHookTimeoutMinutes(mergedSettings.hookTimeoutMinutes);

  for (const command of Object.keys(mergedSettings.commands)) {
    if (command !== 'default' && !KNOWN_PROMPT_COMMANDS.has(command)) {
      logger.warn(`Warning: Unknown command "${command}" in settings.commands.`);
    }
  }

  return mergedSettings;
}

export function getSettings(): Settings {
  return (
    settings ?? {
      ...DEFAULTS,
      commands: Object.fromEntries(
        Object.entries(DEFAULTS.commands).map(([step, config]) => [step, { ...config }])
      ) as Settings['commands'],
      merge: { ...DEFAULTS.merge },
    }
  );
}

export function resolveAgent(step: string, override?: AgentName): AgentName {
  return resolveAgentFromSettings(getSettings(), step, override);
}

export function resolveAgentFromSettings(
  settings: Settings,
  step: string,
  override?: AgentName
): AgentName {
  if (override) {
    return override;
  }
  const configuredAgent: unknown =
    settings.commands[step]?.agent ?? settings.commands.default.agent;
  if (
    configuredAgent !== 'claude' &&
    configuredAgent !== 'codex' &&
    configuredAgent !== 'copilot'
  ) {
    throw new Error(
      `Invalid agent "${String(configuredAgent)}" for step "${step}". Must be "claude", "codex", or "copilot".`
    );
  }
  return configuredAgent;
}

export function resolveMode(step: string, override?: CommandMode): CommandMode {
  if (override && override !== 'default') {
    return validateMode(override, step);
  }

  const s = getSettings();
  const mode = s.commands[step]?.mode ?? s.commands.default.mode;
  if (mode === undefined) {
    if (step === 'groom' && isMcpGroomingEnabled()) {
      return 'headless';
    }
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

export function resolveDisableMcp(step: string, override?: boolean): boolean {
  if (override !== undefined) {
    return validateDisableMcp(override, step);
  }

  const s = getSettings();
  return validateDisableMcp(
    s.commands[step]?.disableMcp ?? s.commands.default.disableMcp ?? false,
    step
  );
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

function validateDisableMcp(disableMcp: unknown, step: string): boolean {
  if (disableMcp === undefined) {
    return false;
  }

  if (typeof disableMcp === 'boolean') {
    return disableMcp;
  }

  throw new Error(`Invalid disableMcp for step "${step}". Must be a boolean.`);
}

function validateHookTimeoutMinutes(hookTimeoutMinutes: unknown): number {
  if (
    typeof hookTimeoutMinutes === 'number' &&
    Number.isFinite(hookTimeoutMinutes) &&
    hookTimeoutMinutes >= 0
  ) {
    return hookTimeoutMinutes;
  }

  throw new Error(
    'Invalid hookTimeoutMinutes. Must be a finite number greater than or equal to 0.'
  );
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
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      return {};
    }
    // Auto-migrate legacy "agent" string to "agents.default"
    if (typeof parsed.agent === 'string' && !parsed.agents && !parsed.commands) {
      parsed.agents = { default: parsed.agent };
      delete parsed.agent;
    }
    // Auto-migrate legacy "prReviewWaitMinutes" to "prReviewWait"
    if (typeof parsed.prReviewWaitMinutes === 'number' && !parsed.prReviewWait) {
      parsed.prReviewWait = { mode: 'timer', durationMinutes: parsed.prReviewWaitMinutes };
      delete parsed.prReviewWaitMinutes;
    }
    if (
      isPlainObject(parsed.prReviewWait) &&
      typeof parsed.prReviewWait.timeoutMinutes === 'number'
    ) {
      const timeoutMinutes = parsed.prReviewWait.timeoutMinutes;
      const mode = parsed.prReviewWait.mode;

      if (mode === 'timer') {
        parsed.prReviewWait = { mode: 'timer', durationMinutes: timeoutMinutes };
      } else if (mode === 'checks') {
        parsed.prReviewWait = { mode: 'checks', maxDurationMinutes: timeoutMinutes };
      }
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

    return parsed;
  } catch (err: unknown) {
    throw new Error(`Malformed JSON in ${filepath}: ${toErrorMessage(err)}`);
  }
}
