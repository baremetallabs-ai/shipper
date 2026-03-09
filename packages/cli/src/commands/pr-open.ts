import { findBranchForIssue, getRepoRoot } from '@dnsquared/shipper-core';
import { autoSelectIssue, resolveBaseBranch, resolveRef } from '@dnsquared/shipper-core';
import { withStageHooks } from '@dnsquared/shipper-core';
import { getSettings } from '@dnsquared/shipper-core';
import { withIssueLock } from '@dnsquared/shipper-core';
import { withWorktree } from '@dnsquared/shipper-core';
import { runPrompt } from '@dnsquared/shipper-core';

export async function prOpenCommand(issue?: string): Promise<void> {
  if (!issue) {
    const selected = await autoSelectIssue('shipper:implemented');
    if (!selected) {
      console.error("No issues ready for PR. Run 'shipper implement' first.");
      process.exit(1);
    }
    console.error(`Auto-selected #${selected.number}: ${selected.title}`);
    issue = String(selected.number);
  } else {
    const resolved = await resolveRef(issue, 'issue');
    issue = resolved.issueNumber;
  }

  const settings = getSettings();
  const baseBranch = await resolveBaseBranch(settings.defaultBaseBranch);

  const code = await withIssueLock(issue, async () => {
    const repoRoot = await getRepoRoot();
    const branch = await findBranchForIssue(issue);

    return await withStageHooks(
      'pr-open',
      { issueNumber: issue, branchName: branch },
      async () =>
        await withWorktree(
          { repoRoot, branch, createBranch: false, issueNumber: issue, stage: 'pr-open' },
          async (wtPath) => {
            return await runPrompt('pr_open', { issueRef: issue, cwd: wtPath, baseBranch });
          }
        )
    );
  });

  process.exitCode = code;
}
