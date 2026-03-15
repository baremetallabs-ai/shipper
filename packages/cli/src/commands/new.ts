import { runPrompt, type AgentName, type CommandMode } from '@dnsquared/shipper-core';

export async function newCommand(
  repo: string,
  requestWords: string[],
  options: { mode?: CommandMode; agent?: AgentName; model?: string } = {}
): Promise<void> {
  const request = requestWords.join(' ').trim();
  if (!request) {
    console.error('Error: Please provide a request for the new issue.');
    console.error('Usage: shipper new <request>');
    process.exit(1);
  }

  const exitCode = await runPrompt('new', {
    repo,
    userInput: request,
    mode: options.mode,
    agent: options.agent,
    model: options.model,
  });
  process.exit(exitCode);
}
