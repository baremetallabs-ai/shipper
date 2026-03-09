import { autoSelectIssue } from '@dnsquared/shipper-core';
import type { CommandMode } from '@dnsquared/shipper-core';
import { withStageHooks } from '@dnsquared/shipper-core';
import { withIssueLock } from '@dnsquared/shipper-core';
import { runPrompt } from '@dnsquared/shipper-core';

export async function designCommand(issue?: string, mode?: CommandMode): Promise<void> {
  if (!issue) {
    const selected = await autoSelectIssue('shipper:groomed');
    if (!selected) {
      console.error("No issues ready for design. Run 'shipper groom' first.");
      process.exit(1);
    }
    console.error(`Auto-selected #${selected.number}: ${selected.title}`);
    issue = String(selected.number);
  }

  const code = await withIssueLock(
    issue,
    async () =>
      await withStageHooks(
        'design',
        { issueNumber: issue },
        async () => await runPrompt('design', { issueRef: issue, mode })
      )
  );

  process.exitCode = code;
}
