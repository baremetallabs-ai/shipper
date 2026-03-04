import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { prompts } from '../lib/prompts.js';
import { scripts } from '../lib/scripts.js';
import { DEFAULTS, SETTING_DESCRIPTIONS } from '../lib/settings.js';
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

export function initCommand() {
  // Check prerequisites
  const ok = runPrereqChecks([checkGitRepo, checkGhInstalled, checkGhAuth, checkGitHubRemote]);
  if (!ok) {
    process.exit(1);
  }

  // Create directories
  const dirs = [
    path.resolve('.shipper', 'prompts'),
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
  if (existsSync(settingsPath)) {
    try {
      const existing = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
      merged = { ...DEFAULTS, ...existing };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: Malformed JSON in ${settingsPath}: ${message}`);
      process.exit(1);
    }
  }
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

  // Write prompt files
  let promptCount = 0;
  for (const [filename, content] of Object.entries(prompts)) {
    const dest = path.resolve('.shipper', 'prompts', filename);
    writeFileSync(dest, content);
    promptCount++;
  }
  console.log(`Wrote ${promptCount} prompt files to .shipper/prompts/`);

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
      console.log('You may want to commit .shipper/prompts/ to your repo.');
    }
  }

  console.log('\nshipper initialized! You can now run:');
  console.log('  shipper new <pitch>    — create a new issue from an idea');
  console.log('  shipper adopt <issue>  — bring an existing issue into the workflow');
  console.log('  shipper groom <issue>  — groom an issue for implementation');
  console.log('  shipper next <ref>     — advance an issue or PR to its next step');
}

function readGitignore(filepath: string): string {
  try {
    return readFileSync(filepath, 'utf-8');
  } catch {
    return '';
  }
}
