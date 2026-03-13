import { autoSelectPrForStage, resolveRef } from '@dnsquared/shipper-core';
import type { AgentName, CommandMode } from '@dnsquared/shipper-core';
import { withStageHooks } from '@dnsquared/shipper-core';
import { withIssueLock } from '@dnsquared/shipper-core';
import { runPrompt } from '@dnsquared/shipper-core';

export async function prReviewCommand(
  repo: string,
  pr?: string,
  mode?: CommandMode,
  agent?: AgentName,
  model?: string
): Promise<void> {
  let issueNumber: string;

  if (!pr) {
    const selected = await autoSelectPrForStage(
      repo,
      'shipper:pr-open',
      "No PRs ready for review. Run 'shipper pr open' first."
    );
    console.error(
      `Auto-selected PR #${selected.pr} (issue #${selected.issue.number}: ${selected.issue.title})`
    );
    pr = selected.pr;
    issueNumber = String(selected.issue.number);
  } else {
    const resolved = await resolveRef(repo, pr, 'both');
    pr = resolved.prNumber;
    issueNumber = resolved.issueNumber;
  }

  const code = await withIssueLock(
    repo,
    issueNumber,
    async () =>
      await withStageHooks(
        'pr-review',
        { issueNumber },
        async () =>
          await runPrompt('pr_review', {
            repo,
            issueRef: issueNumber,
            prRef: pr,
            mode,
            agent,
            model,
          })
      )
  );

  process.exitCode = code;
}
