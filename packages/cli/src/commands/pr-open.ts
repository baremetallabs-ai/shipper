import { findBranchForIssue, getRepoRoot } from '@dnsquared/shipper-core';
import { autoSelectIssue, resolveBaseBranch, resolveRef } from '@dnsquared/shipper-core';
import { withStageHooks } from '@dnsquared/shipper-core';
import { getSettings } from '@dnsquared/shipper-core';
import { withIssueLock } from '@dnsquared/shipper-core';
import { withWorktree } from '@dnsquared/shipper-core';
import { runPrompt } from '@dnsquared/shipper-core';

export function prOpenCommand(issue?: string) {
  if (!issue) {
    const selected = autoSelectIssue('shipper:implemented');
    if (!selected) {
      console.error("No issues ready for PR. Run 'shipper implement' first.");
      process.exit(1);
    }
    console.error(`Auto-selected #${selected.number}: ${selected.title}`);
    issue = String(selected.number);
  } else {
    const resolved = resolveRef(issue, 'issue');
    issue = resolved.issueNumber;
  }

  const settings = getSettings();
  const baseBranch = resolveBaseBranch(settings.defaultBaseBranch);

  withIssueLock(issue, () => {
    const repoRoot = getRepoRoot();
    const branch = findBranchForIssue(issue);

    const code = withStageHooks('pr-open', { issueNumber: issue, branchName: branch }, () =>
      withWorktree(
        { repoRoot, branch, createBranch: false, issueNumber: issue, stage: 'pr-open' },
        (wtPath) => {
          return runPrompt('pr_open', { issueRef: issue, cwd: wtPath, baseBranch });
        }
      )
    );

    process.exit(code);
  });
}
