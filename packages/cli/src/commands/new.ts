import { resolveMode, runPrompt, type AgentName, type CommandMode } from '@dnsquared/shipper-core';

export async function newCommand(
  requestWords: string[],
  options: { mode?: CommandMode; agent?: AgentName; model?: string; logFile?: string } = {}
): Promise<void> {
  const request = requestWords.join(' ').trim();
  if (!request) {
    const effectiveMode = resolveMode('new', options.mode);
    if (effectiveMode === 'headless') {
      console.error('Error: A request is required when running in headless mode.');
      console.error('Usage: shipper new <request...> --mode headless');
      process.exit(1);
      return;
    }
  }

  const exitCode = await runPrompt('new', {
    userInput: request || undefined,
    mode: options.mode,
    agent: options.agent,
    model: options.model,
    logFile: options.logFile,
  });
  process.exit(exitCode);
}
