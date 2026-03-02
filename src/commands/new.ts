import { ensureInitialized } from '../lib/prerequisites.js';
import { runPrompt } from '../lib/prompt-runner.js';

export function newCommand(pitchWords: string[]) {
  const pitch = pitchWords.join(' ').trim();
  if (!pitch) {
    console.error('Error: Please provide a pitch for the new issue.');
    console.error('Usage: shipper new <pitch>');
    process.exit(1);
  }

  ensureInitialized();
  runPrompt('new', pitch);
}
