import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { scripts } from '../lib/scripts.js';
import { DEFAULTS, SETTING_DESCRIPTIONS } from '../lib/settings.js';
import { CLI_VERSION } from '../lib/version.js';
import readmeContent from '../templates/readme.md';
import {
  runPrereqChecks,
  checkGitRepo,
  checkGhInstalled,
  checkGhAuth,
  checkGitHubRemote,
} from '../lib/prerequisites.js';

const LABELS = [
  { name: 'shipper:new', color: 'C2E0C6', description: 'New issue from shipper' },
  { name: 'shipper:groomed', color: 'BFD4F2', description: 'Product-groomed' },
  { name: 'shipper:designed', color: 'D4C5F9', description: 'Design-reviewed' },
  { name: 'shipper:planned', color: 'FEF2C0', description: 'Implementation planned' },
  { name: 'shipper:implemented', color: 'FBCA04', description: 'Implementation complete' },
  { name: 'shipper:pr-open', color: 'F9D0C4', description: 'PR opened' },
  { name: 'shipper:pr-reviewed', color: 'E6B8AF', description: 'PR reviewed, pending remediation' },
  { name: 'shipper:ready', color: '0E8A16', description: 'Ready for final review and merge' },
  {
    name: 'shipper:blocked',
    color: 'E11D48',
    description: 'Blocked by a dependency — run shipper unblock',
  },
  { name: 'shipper:locked', color: 'D93F0B', description: 'Locked by an active shipper instance' },
];

const VALID_AGENTS = ['claude', 'codex'] as const;

function getStoredAgent(): string | undefined {
  const basePath = path.resolve('.shipper', 'settings.json');
  const localPath = path.resolve('.shipper', 'settings.local.json');
  for (const filepath of [localPath, basePath]) {
    try {
      const data = JSON.parse(readFileSync(filepath, 'utf-8')) as Record<string, unknown>;
      const agents = data.agents as Record<string, unknown> | undefined;
      if (agents?.default && typeof agents.default === 'string') return agents.default;
      if (typeof data.agent === 'string' && data.agent) return data.agent;
    } catch {
      // Missing or malformed — skip
    }
  }
  return undefined;
}

export async function initCommand(options: { agent?: string }) {
  // Check prerequisites
  const ok = runPrereqChecks([checkGitRepo, checkGhInstalled, checkGhAuth, checkGitHubRemote]);
  if (!ok) {
    process.exit(1);
  }

  // Resolve agent selection
  let agent: string;
  if (options.agent) {
    if (!VALID_AGENTS.includes(options.agent as (typeof VALID_AGENTS)[number])) {
      console.error(
        `Error: Invalid agent "${options.agent}". Must be one of: ${VALID_AGENTS.join(', ')}`
      );
      process.exit(1);
      return;
    }
    agent = options.agent;
  } else {
    const stored = getStoredAgent();
    if (stored && VALID_AGENTS.includes(stored as (typeof VALID_AGENTS)[number])) {
      agent = stored;
      console.log(`Using agent: ${stored} (from settings)`);
    } else {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(
        'Which coding agent do you use? [Claude Code / Codex CLI] (default: Claude Code): '
      );
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      if (!trimmed || trimmed === 'claude code' || trimmed === 'claude') {
        agent = 'claude';
      } else if (trimmed === 'codex cli' || trimmed === 'codex') {
        agent = 'codex';
      } else {
        console.error(
          `Error: Unrecognized agent "${answer.trim()}". Expected "Claude Code" or "Codex CLI".`
        );
        process.exit(1);
        return;
      }
    }
  }

  // Codex guard
  if (agent !== 'claude') {
    console.error('Codex CLI prompts are not yet available. Use Claude Code or check for updates.');
    process.exit(1);
    return;
  }

  // Create directories
  const dirs = [
    path.resolve('.shipper', 'scripts'),
    path.resolve('.shipper', 'tmp'),
    path.resolve('.shipper', 'hooks'),
  ];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }

  // Write .gitignore
  const gitignorePath = path.resolve('.shipper', '.gitignore');
  writeFileSync(gitignorePath, 'tmp/\nsettings.local.json\n');

  // Write settings.json (merge with existing if present)
  const settingsPath = path.resolve('.shipper', 'settings.json');
  let merged = { ...DEFAULTS };
  let existingAgent: string | undefined;
  if (existsSync(settingsPath)) {
    try {
      const existing = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
      const existingAgents = existing.agents as Record<string, unknown> | undefined;
      existingAgent =
        (existingAgents?.default as string | undefined) ?? (existing.agent as string | undefined);
      merged = { ...DEFAULTS, ...existing };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: Malformed JSON in ${settingsPath}: ${message}`);
      process.exit(1);
    }
  }

  // Re-init warning
  if (existingAgent && existingAgent !== agent) {
    console.log(`Switching agent from ${existingAgent} to ${agent}`);
  }

  const existingAgentsObj =
    typeof merged.agents === 'object' && merged.agents !== null && !Array.isArray(merged.agents)
      ? merged.agents
      : {};
  merged.agents = { ...existingAgentsObj, default: agent as 'claude' | 'codex' };
  delete (merged as Record<string, unknown>).agent;
  (merged as Record<string, unknown>).cliVersion = CLI_VERSION;
  writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + '\n');
  console.log('Wrote .shipper/settings.json with default settings:');
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (typeof value === 'object' && value !== null) continue;
    const desc = SETTING_DESCRIPTIONS[key];
    console.log(`  ${key}: ${value}${desc ? `  — ${desc}` : ''}`);
  }
  for (const [key, desc] of Object.entries(SETTING_DESCRIPTIONS)) {
    if (key in DEFAULTS) continue;
    let value: unknown;
    if (key.includes('.')) {
      const parts = key.split('.');
      let obj: unknown = merged;
      for (const part of parts) {
        obj = (obj as Record<string, unknown>)?.[part];
      }
      value = obj;
    } else {
      value = (merged as Record<string, unknown>)[key];
    }
    if (value !== undefined) {
      console.log(`  ${key}: ${value}  — ${desc}`);
    } else {
      console.log(`  ${key}: (not set)  — ${desc}`);
    }
  }

  // Write script files
  let scriptCount = 0;
  for (const [filename, content] of Object.entries(scripts)) {
    const dest = path.resolve('.shipper', 'scripts', filename);
    writeFileSync(dest, content);
    chmodSync(dest, 0o755);
    scriptCount++;
  }
  console.log(`Wrote ${scriptCount} script files to .shipper/scripts/`);

  // Write README
  const readmePath = path.resolve('.shipper', 'README.md');
  writeFileSync(readmePath, readmeContent);
  console.log('Wrote .shipper/README.md');

  // Ensure labels exist
  let labelCount = 0;
  for (const label of LABELS) {
    try {
      execFileSync(
        'gh',
        ['label', 'create', label.name, '--color', label.color, '--description', label.description],
        { stdio: 'ignore' }
      );
      labelCount++;
    } catch {
      // Label already exists — that's fine
    }
  }

  if (labelCount > 0) {
    console.log(`Created ${labelCount} new label(s)`);
  } else {
    console.log('All labels already exist');
  }

  // Check if .shipper is gitignored or tracked
  const rootGitignore = path.resolve('.gitignore');
  if (existsSync(rootGitignore)) {
    const content = readGitignore(rootGitignore);
    if (!content.includes('.shipper/tmp')) {
      console.log('\nTip: .shipper/tmp/ is gitignored within .shipper/.');
    }
  }

  console.log('\nshipper initialized! You can now run:');
  console.log('  shipper setup          — configure install command and get onboarding help');
  console.log('  shipper new <pitch>    — create a new issue from an idea');
  console.log('  shipper adopt <issue>  — bring an existing issue into the workflow');
  console.log('  shipper groom <issue>  — groom an issue for implementation');
}

function readGitignore(filepath: string): string {
  try {
    return readFileSync(filepath, 'utf-8');
  } catch {
    return '';
  }
}
