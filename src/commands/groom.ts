import { ensureInitialized } from '../lib/prerequisites.js';
import { runPrompt } from '../lib/prompt-runner.js';

export function groomCommand(issue: string) {
  if (!issue) {
    console.error('Error: Please provide an issue number or URL.');
    console.error('Usage: shipper groom <issue>');
    process.exit(1);
  }

  ensureInitialized();
  runPrompt('groom', issue);
}
