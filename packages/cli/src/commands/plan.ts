import { autoSelectIssue } from '@dnsquared/shipper-core';
import { withStageHooks } from '@dnsquared/shipper-core';
import { withIssueLock } from '@dnsquared/shipper-core';
import { runPrompt } from '@dnsquared/shipper-core';

export function planCommand(issue?: string) {
  if (!issue) {
    const selected = autoSelectIssue('shipper:designed');
    if (!selected) {
      console.error("No issues ready for planning. Run 'shipper design' first.");
      process.exit(1);
    }
    console.error(`Auto-selected #${selected.number}: ${selected.title}`);
    issue = String(selected.number);
  }

  process.exit(
    withIssueLock(issue, () =>
      withStageHooks('plan', { issueNumber: issue }, () => runPrompt('plan', { issueRef: issue }))
    )
  );
}
