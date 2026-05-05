import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { agentPrompts, getSettings, logger } from '@baremetallabs-ai/shipper-core';

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
    throw new Error(`Error: No bundled prompts found for agent "${agent}".`);
  }
  const defaultFilenames = Object.keys(promptSet).filter(
    (filename) => filename !== 'setup.md' && filename !== 'setup_remediate.md'
  );
  const ejectedByNameFilenames = Object.keys(promptSet).filter(
    (filename) => filename !== 'setup_remediate.md'
  );
  const cliNames = ejectedByNameFilenames.map(filenameToCliName);
  const targetDir = path.resolve('.shipper', 'prompts', agent);
  const filenamesToEject = name ? [cliNameToFilename(name)] : defaultFilenames;

  if (name) {
    if (!cliNames.includes(name)) {
      throw new Error(
        `Error: Invalid prompt name "${name}". Valid prompt names: ${cliNames.join(', ')}`
      );
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
      throw new Error(`Error: No bundled prompt found for "${cliName}".`);
    }

    writeFileSync(targetPath, prompt);
    wroteCount += 1;
    logger.log(`Wrote ${targetPath}`);
  }

  if (!name) {
    logger.log(`Summary: wrote ${wroteCount}, skipped ${skippedCount}`);
  }
}
