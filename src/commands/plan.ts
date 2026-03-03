import { runPrompt } from '../lib/prompt-runner.js';

export function planCommand(issue: string) {
  if (!issue) {
    console.error('Error: Please provide an issue number or URL.');
    console.error('Usage: shipper plan <issue>');
    process.exit(1);
  }

  process.exit(runPrompt('plan', { issueRef: issue }));
}
