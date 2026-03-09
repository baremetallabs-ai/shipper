import { autoSelectIssue } from '@dnsquared/shipper-core';
import type { CommandMode } from '@dnsquared/shipper-core';
import { withStageHooks } from '@dnsquared/shipper-core';
import { withIssueLock } from '@dnsquared/shipper-core';
import { runPrompt } from '@dnsquared/shipper-core';

export async function planCommand(issue?: string, mode?: CommandMode): Promise<void> {
  if (!issue) {
    const selected = await autoSelectIssue('shipper:designed');
    if (!selected) {
      console.error("No issues ready for planning. Run 'shipper design' first.");
      process.exit(1);
    }
    console.error(`Auto-selected #${selected.number}: ${selected.title}`);
    issue = String(selected.number);
  }

  const code = await withIssueLock(
    issue,
    async () =>
      await withStageHooks(
        'plan',
        { issueNumber: issue },
        async () => await runPrompt('plan', { issueRef: issue, mode })
      )
  );

  process.exitCode = code;
}
