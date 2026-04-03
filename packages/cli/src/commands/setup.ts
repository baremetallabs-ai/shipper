import { existsSync } from 'node:fs';
import path from 'node:path';
import { runPrompt, type AgentName, type CommandMode } from '@dnsquared/shipper-core';

export async function setupCommand(
  words: string[],
  options: { mode?: CommandMode; agent?: AgentName; model?: string } = {}
): Promise<void> {
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

  process.exitCode = await runPrompt('setup', {
    userInput,
    mode: options.mode,
    agent: options.agent,
    model: options.model,
  });
}
