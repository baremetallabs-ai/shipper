import { runPrompt } from '../lib/prompt-runner.js';

export function unblockCommand(issue: string) {
  if (!issue) {
    console.error('Error: Please provide an issue number.');
    console.error('Usage: shipper unblock <issue>');
    process.exit(1);
  }

  process.exit(runPrompt('unblock', { issueRef: issue }));
}
