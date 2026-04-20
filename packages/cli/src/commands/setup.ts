import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  getSettings,
  logger,
  offerSetupFinalize,
  readGitStatusSnapshot,
  resolveMode,
  runPrompt,
  type AgentName,
  type CommandMode,
} from '@dnsquared/shipper-core';
import { confirm } from '../lib/confirm.js';

export async function setupCommand(
  words: string[],
  options: { mode?: CommandMode; agent?: AgentName; model?: string } = {}
): Promise<void> {
  const effectiveMode = resolveMode('setup', options.mode);
  const settings = getSettings();
  const effectiveAgent =
    options.agent ?? settings.commands.setup?.agent ?? settings.commands.default.agent;
  const effectiveModel =
    options.model ?? settings.commands.setup?.model ?? settings.commands.default.model;
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

  const before = await readGitStatusSnapshot(process.cwd());
  const setupExitCode = await runPrompt('setup', {
    userInput,
    mode: effectiveMode,
    agent: effectiveAgent,
    model: effectiveModel,
  });
  process.exitCode = setupExitCode;

  if (setupExitCode !== 0) {
    return;
  }

  if (effectiveMode === 'headless') {
    process.exitCode = 0;
    return;
  }

  const finalizeResult = await offerSetupFinalize({
    before,
    mode: effectiveMode,
    agent: effectiveAgent,
    model: effectiveModel,
    confirm,
  });

  if (finalizeResult.status === 'failed') {
    if (finalizeResult.error) {
      logger.error(finalizeResult.error);
    }
    process.exitCode = 1;
    return;
  }

  process.exitCode = 0;
}
