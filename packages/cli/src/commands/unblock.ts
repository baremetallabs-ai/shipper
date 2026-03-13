import type { AgentName, CommandMode } from '@dnsquared/shipper-core';
import { withIssueLock } from '@dnsquared/shipper-core';
import { runPrompt } from '@dnsquared/shipper-core';

export async function unblockCommand(
  repo: string,
  issue: string,
  mode?: CommandMode,
  agent?: AgentName,
  model?: string
): Promise<void> {
  if (!issue) {
    console.error('Error: Please provide an issue number.');
    console.error('Usage: shipper unblock <issue>');
    process.exit(1);
  }

  const code = await withIssueLock(
    repo,
    issue,
    async () => await runPrompt('unblock', { repo, issueRef: issue, mode, agent, model })
  );
  process.exitCode = code;
}
