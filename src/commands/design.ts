import { runPrompt } from '../lib/prompt-runner.js';

export function designCommand(issue: string) {
  if (!issue) {
    console.error('Error: Please provide an issue number or URL.');
    console.error('Usage: shipper design <issue>');
    process.exit(1);
  }

  process.exit(runPrompt('design', { issueRef: issue }));
}
