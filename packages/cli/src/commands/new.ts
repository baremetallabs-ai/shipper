import {
  logger,
  resolveMode,
  runPrompt,
  type AgentName,
  type CommandMode,
} from '@dnsquared/shipper-core';

export async function newCommand(
  requestWords: string[],
  options: { mode?: CommandMode; agent?: AgentName; model?: string; logFile?: string } = {}
): Promise<void> {
  const request = requestWords.join(' ').trim();
  if (!request) {
    const effectiveMode = resolveMode('new', options.mode);
    if (effectiveMode === 'headless') {
      logger.error('Usage: shipper new <request...> --mode headless');
      throw new Error('Error: A request is required when running in headless mode.');
    }
  }

  const exitCode = await runPrompt('new', {
    userInput: request || undefined,
    mode: options.mode,
    agent: options.agent,
    model: options.model,
    logFile: options.logFile,
  });
  process.exitCode = exitCode;
}
