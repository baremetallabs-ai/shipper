import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { agentPrompts } from '../lib/prompts.js';
import { getSettings } from '../lib/settings.js';

function filenameToCliName(filename: string): string {
  return filename.replace(/\.md$/, '').replace(/_/g, '-');
}

function cliNameToFilename(name: string): string {
  return `${name.replace(/-/g, '_')}.md`;
}

export function ejectCommand(name?: string) {
  const agent = getSettings().agents.default;
  const promptSet = agentPrompts[agent];
  if (!promptSet) {
    console.error(`Error: No bundled prompts found for agent "${agent}".`);
    process.exit(1);
  }
  const filenames = Object.keys(promptSet).filter((filename) => filename !== 'setup.md');
  const cliNames = filenames.map(filenameToCliName);
  const targetDir = path.resolve('.shipper', 'prompts', agent);

  if (name) {
    if (!cliNames.includes(name)) {
      console.error(
        `Error: Invalid prompt name "${name}". Valid prompt names: ${cliNames.join(', ')}`
      );
      process.exit(1);
    }

    const filename = cliNameToFilename(name);
    const targetPath = path.resolve('.shipper', 'prompts', agent, filename);

    mkdirSync(targetDir, { recursive: true });
    if (existsSync(targetPath)) {
      console.log(`Skipping ${name} — already exists at ${targetPath}`);
      return;
    }

    writeFileSync(targetPath, promptSet[filename]!);
    console.log(`Wrote ${targetPath}`);
    return;
  }

  mkdirSync(targetDir, { recursive: true });

  let wroteCount = 0;
  let skippedCount = 0;

  for (const filename of filenames) {
    const cliName = filenameToCliName(filename);
    const targetPath = path.resolve('.shipper', 'prompts', agent, filename);

    if (existsSync(targetPath)) {
      skippedCount += 1;
      console.log(`Skipping ${cliName} — already exists at ${targetPath}`);
      continue;
    }

    writeFileSync(targetPath, promptSet[filename]!);
    wroteCount += 1;
    console.log(`Wrote ${targetPath}`);
  }

  console.log(`Summary: wrote ${wroteCount}, skipped ${skippedCount}`);
}
