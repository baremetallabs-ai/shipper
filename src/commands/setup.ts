import { existsSync } from 'node:fs';
import path from 'node:path';
import { runPrompt } from '../lib/prompt-runner.js';

export function setupCommand(words: string[]) {
  const userText = words.join(' ').trim();

  let userInput: string;
  if (userText) {
    userInput = userText;
  } else {
    const repoName = path.basename(process.cwd());
    const hasShipperDir = existsSync('.shipper');
    userInput = hasShipperDir
      ? `Run setup for ${repoName}. .shipper/ directory already exists.`
      : `Run setup for ${repoName}. This is a fresh setup — no .shipper/ directory found.`;
  }

  process.exit(runPrompt('setup', { userInput }));
}
