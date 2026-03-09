import { generateBranchName, getRepoRoot } from '@dnsquared/shipper-core';
import { autoSelectIssue } from '@dnsquared/shipper-core';
import { withStageHooks } from '@dnsquared/shipper-core';
import { withIssueLock } from '@dnsquared/shipper-core';
import { withWorktree } from '@dnsquared/shipper-core';
import { runPrompt } from '@dnsquared/shipper-core';

export function implementCommand(issue?: string) {
  if (!issue) {
    const selected = autoSelectIssue('shipper:planned');
    if (!selected) {
      console.error("No issues ready for implementation. Run 'shipper plan' first.");
      process.exit(1);
    }
    console.error(`Auto-selected #${selected.number}: ${selected.title}`);
    issue = String(selected.number);
  }

  withIssueLock(issue, () => {
    const repoRoot = getRepoRoot();
    const branch = generateBranchName(issue);

    const code = withStageHooks('implement', { issueNumber: issue, branchName: branch }, () =>
      withWorktree(
        { repoRoot, branch, createBranch: true, issueNumber: issue, stage: 'implement' },
        (wtPath) => {
          return runPrompt('implement', { issueRef: issue, cwd: wtPath });
        }
      )
    );

    process.exit(code);
  });
}
