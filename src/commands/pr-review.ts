import { ensureInitialized } from '../lib/prerequisites.js';
import { runPrompt } from '../lib/prompt-runner.js';

export function prReviewCommand(pr: string) {
  if (!pr) {
    console.error('Error: Please provide a PR number or URL.');
    console.error('Usage: shipper pr review <pr>');
    process.exit(1);
  }

  ensureInitialized();
  runPrompt('pr_review', { prRef: pr });
}
