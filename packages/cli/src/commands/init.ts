import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { promisify } from 'node:util';
import {
  gh,
  scripts,
  DEFAULTS,
  SETTING_DESCRIPTIONS,
  CLI_VERSION,
  readmeTemplate,
  LABELS,
  runPrereqChecks,
  checkGitRepo,
  checkGhInstalled,
  checkGhAuth,
  checkGitHubRemote,
} from '@dnsquared/shipper-core';

const execFileAsync = promisify(execFile);

function getErrorStderr(err: unknown): string {
  return typeof err === 'object' &&
    err !== null &&
    'stderr' in err &&
    typeof err.stderr === 'string'
    ? err.stderr.trim()
    : '';
}

const VALID_AGENTS = ['claude', 'codex', 'copilot'] as const;
const UNSAFE_COMMAND_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getNestedValue(source: Record<string, unknown>, dottedKey: string): unknown {
  let current: unknown = source;
  for (const part of dottedKey.split('.')) {
    if (!isPlainObject(current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function formatSettingValue(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return JSON.stringify(value);
}

function isSafeCommandKey(key: string): boolean {
  return !UNSAFE_COMMAND_KEYS.has(key);
}

function getStoredAgent(): string | undefined {
  const basePath = path.resolve('.shipper', 'settings.json');
  const localPath = path.resolve('.shipper', 'settings.local.json');
  for (const filepath of [localPath, basePath]) {
    try {
      const data = JSON.parse(readFileSync(filepath, 'utf-8')) as Record<string, unknown>;
      const commands = isPlainObject(data.commands) ? data.commands : undefined;
      const commandDefault = isPlainObject(commands?.default) ? commands.default : undefined;
      if (typeof commandDefault?.agent === 'string') return commandDefault.agent;
      const agents = data.agents as Record<string, unknown> | undefined;
      if (agents?.default && typeof agents.default === 'string') return agents.default;
      if (typeof data.agent === 'string' && data.agent) return data.agent;
    } catch {
      // Missing or malformed — skip
    }
  }
  return undefined;
}

function parseGitPathList(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((file) => file.trim())
    .filter(Boolean);
}

export async function initCommand(options: {
  agent?: string;
  autocommit?: boolean;
  push?: boolean;
}) {
  // Check prerequisites
  const ok = await runPrereqChecks([
    checkGitRepo,
    checkGhInstalled,
    checkGhAuth,
    checkGitHubRemote,
  ]);
  if (!ok) {
    process.exit(1);
  }

  if (options.push && !options.autocommit) {
    console.error('Error: --push requires --autocommit.');
    process.exit(1);
    return;
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
        'Which coding agent do you use? [Claude Code / Codex CLI / Copilot CLI] (default: Claude Code): '
      );
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      if (!trimmed || trimmed === 'claude code' || trimmed === 'claude') {
        agent = 'claude';
      } else if (trimmed === 'codex cli' || trimmed === 'codex') {
        agent = 'codex';
      } else if (
        trimmed === 'copilot cli' ||
        trimmed === 'copilot' ||
        trimmed === 'github copilot'
      ) {
        agent = 'copilot';
      } else {
        console.error(
          `Error: Unrecognized agent "${answer.trim()}". Expected "Claude Code", "Codex CLI", or "Copilot CLI".`
        );
        process.exit(1);
        return;
      }
    }
  }

  // Create directories
  const dirs = [
    path.resolve('.shipper', 'scripts'),
    path.resolve('.shipper', 'tmp'),
    path.resolve('.shipper', 'hooks'),
    path.resolve('.shipper', 'input'),
    path.resolve('.shipper', 'output'),
  ];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }
  for (const name of ['input', 'output']) {
    writeFileSync(path.resolve('.shipper', name, '.gitkeep'), '');
  }

  // Write .gitignore
  const gitignorePath = path.resolve('.shipper', '.gitignore');
  const gitignoreEntries = [
    'tmp/',
    'settings.local.json',
    'README.md',
    'input/*',
    '!input/.gitkeep',
    'output/*',
    '!output/.gitkeep',
  ];
  writeFileSync(gitignorePath, `${gitignoreEntries.join('\n')}\n`);

  let removedTrackedArtifactPaths: string[] = [];
  try {
    const { stdout } = await execFileAsync('git', [
      'ls-files',
      '--',
      '.shipper/output/',
      '.shipper/input/',
    ]);
    const trackedFiles = parseGitPathList(stdout).filter((file) => !file.endsWith('.gitkeep'));

    if (trackedFiles.length > 0) {
      try {
        await execFileAsync('git', ['rm', '--cached', '--', ...trackedFiles]);
        removedTrackedArtifactPaths = trackedFiles;
        for (const file of trackedFiles) {
          console.log(`Untracked: ${file}`);
        }
        console.log(
          'These files were tracked by git but should be gitignored. Commit the changes to complete the fix.'
        );
      } catch (err) {
        const stderr = getErrorStderr(err);
        console.error(
          'Warning: Failed to untrack tracked files under .shipper/output/ and .shipper/input.' +
            (stderr ? `\n${stderr}` : '')
        );
      }
    }
  } catch {
    // Not in a git repo or git ls-files failed — skip best-effort cleanup.
  }

  // Write settings.json (merge with existing if present)
  const settingsPath = path.resolve('.shipper', 'settings.json');
  let merged: Record<string, unknown> = {
    ...DEFAULTS,
    commands: { default: { ...DEFAULTS.commands.default } },
  };
  let existingAgent: string | undefined;
  if (existsSync(settingsPath)) {
    try {
      const existing = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
      const existingCommandsSource = isPlainObject(existing.commands) ? existing.commands : {};
      const hasExistingCommands = Object.keys(existingCommandsSource).length > 0;
      const existingCommandDefault = isPlainObject(existingCommandsSource.default)
        ? existingCommandsSource.default
        : {};
      const existingAgents = isPlainObject(existing.agents) ? existing.agents : {};
      const existingHeadless = isPlainObject(existing.headless) ? existing.headless : {};
      const migratedCommands: Record<string, unknown> = {};

      for (const [step, config] of Object.entries(existingCommandsSource)) {
        if (!isSafeCommandKey(step) || !isPlainObject(config)) continue;
        migratedCommands[step] = { ...config };
      }
      migratedCommands.default = {
        ...DEFAULTS.commands.default,
        ...existingCommandDefault,
      };

      if (!hasExistingCommands) {
        if (typeof existingAgents.default === 'string') {
          migratedCommands.default = {
            ...(isPlainObject(migratedCommands.default) ? migratedCommands.default : {}),
            agent: existingAgents.default,
          };
        }

        for (const [step, stepAgent] of Object.entries(existingAgents)) {
          if (step === 'default' || typeof stepAgent !== 'string' || !isSafeCommandKey(step)) {
            continue;
          }
          const stepConfig = isPlainObject(migratedCommands[step]) ? migratedCommands[step] : {};
          migratedCommands[step] = { ...stepConfig, agent: stepAgent };
        }

        for (const [step, enabled] of Object.entries(existingHeadless)) {
          if (enabled !== true || !isSafeCommandKey(step)) continue;
          const stepConfig = isPlainObject(migratedCommands[step]) ? migratedCommands[step] : {};
          migratedCommands[step] = { ...stepConfig, mode: 'headless' };
        }
      }

      existingAgent =
        (existingCommandDefault.agent as string | undefined) ??
        (existingAgents.default as string | undefined) ??
        (existing.agent as string | undefined);
      merged = {
        ...DEFAULTS,
        ...existing,
        commands: migratedCommands,
      };
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

  const mergedCommands = isPlainObject(merged.commands) ? merged.commands : {};
  const mergedDefaultCommand = isPlainObject(mergedCommands.default) ? mergedCommands.default : {};
  merged.commands = {
    ...mergedCommands,
    default: { ...mergedDefaultCommand, agent: agent as 'claude' | 'codex' | 'copilot' },
  };
  delete merged.agent;
  delete merged.agents;
  delete merged.headless;
  delete merged.hooks;
  merged.cliVersion = CLI_VERSION;
  writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + '\n');
  console.log('Wrote .shipper/settings.json with default settings:');
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (typeof value === 'object' && value !== null) continue;
    const desc = SETTING_DESCRIPTIONS[key];
    console.log(`  ${key}: ${value}${desc ? `  — ${desc}` : ''}`);
  }
  for (const [key, desc] of Object.entries(SETTING_DESCRIPTIONS)) {
    if (key in DEFAULTS) continue;
    const value = key.includes('.') ? getNestedValue(merged, key) : merged[key];
    if (value !== undefined) {
      console.log(`  ${key}: ${formatSettingValue(value)}  — ${desc}`);
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
  writeFileSync(readmePath, readmeTemplate);
  console.log('Wrote .shipper/README.md');

  // Ensure labels match the canonical shipper definitions
  for (const label of LABELS) {
    await gh([
      'label',
      'create',
      label.name,
      '--force',
      '--color',
      label.color,
      '--description',
      label.description,
    ]);
  }
  console.log(`Synced ${LABELS.length} labels`);

  if (!options.autocommit) {
    console.log(
      "Tip: run 'git add .shipper/ && git commit' to commit your changes, then push to your default branch."
    );
  } else {
    // Stage, check for changes, commit, and optionally push
    await execFileAsync('git', ['add', '--', '.shipper/']);

    let hasChanges = false;
    try {
      await execFileAsync('git', ['diff', '--cached', '--quiet', '--', '.shipper/']);
    } catch {
      hasChanges = true;
    }

    if (!hasChanges) {
      console.log('.shipper/ files are unchanged — nothing to commit.');
    } else {
      if (removedTrackedArtifactPaths.length > 0) {
        const { stdout: stagedPathsOut } = await execFileAsync(
          'git',
          ['diff', '--cached', '--name-only', '-z'],
          {
            encoding: 'utf-8',
          }
        );
        const stagedPaths = stagedPathsOut.split('\0').filter(Boolean);
        const nonShipperStagedPaths = stagedPaths.filter((file) => !file.startsWith('.shipper/'));
        if (nonShipperStagedPaths.length > 0) {
          throw new Error(
            'shipper init found staged changes outside .shipper while untracking tracked artifacts. Commit or unstage them first, then rerun shipper init.'
          );
        }

        await execFileAsync('git', ['commit', '-m', 'chore: initialize shipper']);
      } else {
        await execFileAsync('git', [
          'commit',
          '-m',
          'chore: initialize shipper',
          '--',
          '.shipper/',
        ]);
      }

      if (!options.push) {
        console.log('Committed .shipper/ files.');
      } else {
        const { stdout: currentOut } = await execFileAsync('git', ['branch', '--show-current'], {
          encoding: 'utf-8',
        });
        const currentBranch = currentOut.trim();

        if (!currentBranch) {
          console.error(
            'Error: Failed to push from detached HEAD.\nCheck out a branch and retry with --push.'
          );
          process.exit(1);
          return;
        }

        // Resolve the push remote from branch config, falling back to 'origin'
        let remote = 'origin';
        try {
          const { stdout: remoteOut } = await execFileAsync(
            'git',
            ['config', `branch.${currentBranch}.remote`],
            { encoding: 'utf-8' }
          );
          if (remoteOut.trim()) {
            remote = remoteOut.trim();
          }
        } catch {
          // No branch remote configured — fall back to 'origin'
        }

        try {
          await execFileAsync('git', ['push', remote, currentBranch]);
        } catch (err) {
          const stderr = getErrorStderr(err);
          console.error(
            `Error: Failed to push to ${currentBranch}.` +
              (stderr ? `\n${stderr}` : '') +
              '\n\nThis may be due to branch protection rules.' +
              `\nPush manually with: git push ${remote} ${currentBranch}` +
              '\nOr adjust your branch protection settings.'
          );
          process.exit(1);
          return;
        }

        console.log(`Committed and pushed .shipper/ files to ${currentBranch}`);
      }
    }
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
  console.log('  shipper new <request>  — create a new issue from an idea');
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
