import { releaseIssueLock } from '@dnsquared/shipper-core';

export async function unlockCommand(issue: string): Promise<void> {
  if (!issue) {
    console.error('Error: Please provide an issue number.');
    console.error('Usage: shipper unlock <issue>');
    process.exit(1);
  }

  await releaseIssueLock(issue.replace(/^#/, ''));
}
