import { autoSelectPrForStage, resolveRef } from '@dnsquared/shipper-core';
import type { CommandMode } from '@dnsquared/shipper-core';
import { withStageHooks } from '@dnsquared/shipper-core';
import { withIssueLock } from '@dnsquared/shipper-core';
import { runPrompt } from '@dnsquared/shipper-core';

export async function prReviewCommand(pr?: string, mode?: CommandMode): Promise<void> {
  let issueNumber: string;

  if (!pr) {
    const selected = await autoSelectPrForStage(
      'shipper:pr-open',
      "No PRs ready for review. Run 'shipper pr open' first."
    );
    console.error(
      `Auto-selected PR #${selected.pr} (issue #${selected.issue.number}: ${selected.issue.title})`
    );
    pr = selected.pr;
    issueNumber = String(selected.issue.number);
  } else {
    const resolved = await resolveRef(pr, 'both');
    pr = resolved.prNumber;
    issueNumber = resolved.issueNumber;
  }

  const code = await withIssueLock(
    issueNumber,
    async () =>
      await withStageHooks(
        'pr-review',
        { issueNumber },
        async () => await runPrompt('pr_review', { issueRef: issueNumber, prRef: pr, mode })
      )
  );

  process.exitCode = code;
}
