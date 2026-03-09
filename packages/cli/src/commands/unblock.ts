import { withIssueLock } from '@dnsquared/shipper-core';
import { runPrompt } from '@dnsquared/shipper-core';

export function unblockCommand(issue: string) {
  if (!issue) {
    console.error('Error: Please provide an issue number.');
    console.error('Usage: shipper unblock <issue>');
    process.exit(1);
  }

  process.exit(withIssueLock(issue, () => runPrompt('unblock', { issueRef: issue })));
}
