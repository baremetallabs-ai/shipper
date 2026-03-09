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
}

export interface Settings {
  prReviewWait: PrReviewWait;
  lockTimeoutMinutes: number;
  commands: {
    default: CommandConfig & { agent: AgentName };
    [step: string]: CommandConfig | undefined;
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
  commands: { default: { agent: 'claude' as const } },
  hooks: {},
};

export const SETTING_DESCRIPTIONS: Record<string, string> = {
  prReviewWait: 'PR review wait strategy: { mode: "checks" | "timer", timeoutMinutes: number }',
  lockTimeoutMinutes: 'stale lock timeout (minutes) before auto-clearing shipper:locked',
  commands:
    'per-command settings map (e.g. { "default": { "agent": "claude" }, "groom": { "mode": "headless" } })',
  'commands.default.agent':
    'default coding agent for all steps (supports per-step overrides via commands.<step>.agent)',
  'commands.default.mode':
    'default execution mode for prompt-running commands: "headless", "interactive", or "default"',
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
    ...Object.keys(baseCommands),
    ...Object.keys(localCommands),
    'default',
  ]);
  const mergedCommands: Settings['commands'] = {
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
    hooks: { ...DEFAULTS.hooks, ...base?.hooks, ...local?.hooks },
    commands: mergedCommands,
  };

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
    }
  );
}

export function resolveAgent(step: string): AgentName {
  const s = getSettings();
  const agent = s.commands[step]?.agent ?? s.commands.default.agent;
  if (agent !== 'claude' && agent !== 'codex') {
    console.error(
      `Error: Invalid agent "${agent}" for step "${step}". Must be "claude" or "codex".`
    );
    process.exit(1);
  }
  return agent;
}

export function resolveMode(step: string, override?: CommandMode): CommandMode {
  if (override && override !== 'default') {
    return override;
  }

  const s = getSettings();
  return s.commands[step]?.mode ?? s.commands.default.mode ?? 'default';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
          agent: agents.default === 'codex' ? 'codex' : 'claude',
        },
      };

      for (const [step, agent] of Object.entries(agents)) {
        if (step === 'default') continue;
        commands[step] = { ...commands[step], agent: agent as AgentName };
      }

      if (parsed.headless && isPlainObject(parsed.headless)) {
        for (const [step, enabled] of Object.entries(parsed.headless)) {
          if (enabled === true) {
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
        if (enabled === true) {
          commands[step] = { mode: 'headless' };
        }
      }

      parsed.commands = commands;
      delete parsed.headless;
    }

    return parsed as Partial<Settings>;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: Malformed JSON in ${filepath}: ${message}`);
    process.exit(1);
  }
}
