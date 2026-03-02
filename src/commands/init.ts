import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { prompts } from '../lib/prompts.js';
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
  { name: 'shipper:released', color: '0E8A16', description: 'Released' },
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
    path.resolve('.shipper', 'tmp'),
    path.resolve('.shipper', 'hooks'),
  ];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }

  // Write .gitignore
  const gitignorePath = path.resolve('.shipper', '.gitignore');
  writeFileSync(gitignorePath, 'tmp/\n');

  // Write prompt files
  let promptCount = 0;
  for (const [filename, content] of Object.entries(prompts)) {
    const dest = path.resolve('.shipper', 'prompts', filename);
    writeFileSync(dest, content);
    promptCount++;
  }
  console.log(`Wrote ${promptCount} prompt files to .shipper/prompts/`);

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
  console.log('  shipper groom <issue>  — groom an existing issue');
}

function readGitignore(filepath: string): string {
  try {
    return readFileSync(filepath, 'utf-8');
  } catch {
    return '';
  }
}
