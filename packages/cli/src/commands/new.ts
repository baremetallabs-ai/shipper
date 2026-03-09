import { runPrompt, type CommandMode } from '@dnsquared/shipper-core';

export async function newCommand(
  pitchWords: string[],
  options: { mode?: CommandMode } = {}
): Promise<void> {
  const pitch = pitchWords.join(' ').trim();
  if (!pitch) {
    console.error('Error: Please provide a pitch for the new issue.');
    console.error('Usage: shipper new <pitch>');
    process.exit(1);
  }

  const exitCode = await runPrompt('new', { userInput: pitch, mode: options.mode });
  process.exit(exitCode);
}
