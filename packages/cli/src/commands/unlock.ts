import { releaseIssueLock } from '../lib/lock.js';

export function unlockCommand(issue: string) {
  if (!issue) {
    console.error('Error: Please provide an issue number.');
    console.error('Usage: shipper unlock <issue>');
    process.exit(1);
  }

  releaseIssueLock(issue.replace(/^#/, ''));
}
