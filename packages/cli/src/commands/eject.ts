import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { agentPrompts, logger } from '@dnsquared/shipper-core';
import { getSettings } from '@dnsquared/shipper-core';

function filenameToCliName(filename: string): string {
  return filename.replace(/\.md$/, '').replace(/_/g, '-');
}

function cliNameToFilename(name: string): string {
  return `${name.replace(/-/g, '_')}.md`;
}

export function ejectCommand(name?: string) {
  const agent = getSettings().commands.default.agent;
  const promptSet = agentPrompts[agent];
  if (!promptSet) {
    logger.error(`Error: No bundled prompts found for agent "${agent}".`);
    process.exit(1);
  }
  const allFilenames = Object.keys(promptSet).filter((filename) => filename !== 'setup.md');
  const cliNames = allFilenames.map(filenameToCliName);
  const targetDir = path.resolve('.shipper', 'prompts', agent);
  const filenamesToEject = name ? [cliNameToFilename(name)] : allFilenames;

  if (name) {
    if (!cliNames.includes(name)) {
      logger.error(
        `Error: Invalid prompt name "${name}". Valid prompt names: ${cliNames.join(', ')}`
      );
      process.exit(1);
    }
  }

  mkdirSync(targetDir, { recursive: true });

  let wroteCount = 0;
  let skippedCount = 0;

  for (const filename of filenamesToEject) {
    const cliName = filenameToCliName(filename);
    const targetPath = path.resolve('.shipper', 'prompts', agent, filename);
    const prompt = promptSet[filename];

    if (existsSync(targetPath)) {
      skippedCount += 1;
      logger.log(`Skipping ${cliName} — already exists at ${targetPath}`);
      continue;
    }

    if (prompt === undefined) {
      logger.error(`Error: No bundled prompt found for "${cliName}".`);
      process.exit(1);
    }

    writeFileSync(targetPath, prompt);
    wroteCount += 1;
    logger.log(`Wrote ${targetPath}`);
  }

  if (!name) {
    logger.log(`Summary: wrote ${wroteCount}, skipped ${skippedCount}`);
  }
}
