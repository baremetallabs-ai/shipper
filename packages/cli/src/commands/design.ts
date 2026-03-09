import { autoSelectIssue } from '@dnsquared/shipper-core';
import { withStageHooks } from '@dnsquared/shipper-core';
import { withIssueLock } from '@dnsquared/shipper-core';
import { runPrompt } from '@dnsquared/shipper-core';

export function designCommand(issue?: string) {
  if (!issue) {
    const selected = autoSelectIssue('shipper:groomed');
    if (!selected) {
      console.error("No issues ready for design. Run 'shipper groom' first.");
      process.exit(1);
    }
    console.error(`Auto-selected #${selected.number}: ${selected.title}`);
    issue = String(selected.number);
  }

  process.exit(
    withIssueLock(issue, () =>
      withStageHooks('design', { issueNumber: issue }, () =>
        runPrompt('design', { issueRef: issue })
      )
    )
  );
}
