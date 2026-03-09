import { autoSelectPrForStage, resolveRef } from '@dnsquared/shipper-core';
import { withStageHooks } from '@dnsquared/shipper-core';
import { withIssueLock } from '@dnsquared/shipper-core';
import { runPrompt } from '@dnsquared/shipper-core';

export function prReviewCommand(pr?: string) {
  let issueNumber: string;

  if (!pr) {
    const selected = autoSelectPrForStage(
      'shipper:pr-open',
      "No PRs ready for review. Run 'shipper pr open' first."
    );
    console.error(
      `Auto-selected PR #${selected.pr} (issue #${selected.issue.number}: ${selected.issue.title})`
    );
    pr = selected.pr;
    issueNumber = String(selected.issue.number);
  } else {
    const resolved = resolveRef(pr, 'both');
    pr = resolved.prNumber;
    issueNumber = resolved.issueNumber;
  }

  process.exit(
    withIssueLock(issueNumber, () =>
      withStageHooks('pr-review', { issueNumber }, () =>
        runPrompt('pr_review', { issueRef: issueNumber, prRef: pr })
      )
    )
  );
}
