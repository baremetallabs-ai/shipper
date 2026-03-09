import type { CommandMode } from '@dnsquared/shipper-core';
import { withIssueLock } from '@dnsquared/shipper-core';
import { runPrompt } from '@dnsquared/shipper-core';

export async function unblockCommand(issue: string, mode?: CommandMode): Promise<void> {
  if (!issue) {
    console.error('Error: Please provide an issue number.');
    console.error('Usage: shipper unblock <issue>');
    process.exit(1);
  }

  const code = await withIssueLock(
    issue,
    async () => await runPrompt('unblock', { issueRef: issue, mode })
  );
  process.exitCode = code;
}
