import { generateBranchName, getRepoRoot } from '@dnsquared/shipper-core';
import { autoSelectIssue } from '@dnsquared/shipper-core';
import { withStageHooks } from '@dnsquared/shipper-core';
import { withIssueLock } from '@dnsquared/shipper-core';
import { withWorktree } from '@dnsquared/shipper-core';
import { runPrompt } from '@dnsquared/shipper-core';

export async function implementCommand(issue?: string): Promise<void> {
  if (!issue) {
    const selected = await autoSelectIssue('shipper:planned');
    if (!selected) {
      console.error("No issues ready for implementation. Run 'shipper plan' first.");
      process.exit(1);
    }
    console.error(`Auto-selected #${selected.number}: ${selected.title}`);
    issue = String(selected.number);
  }

  const code = await withIssueLock(issue, async () => {
    const repoRoot = await getRepoRoot();
    const branch = await generateBranchName(issue);

    return await withStageHooks(
      'implement',
      { issueNumber: issue, branchName: branch },
      async () =>
        await withWorktree(
          { repoRoot, branch, createBranch: true, issueNumber: issue, stage: 'implement' },
          async (wtPath) => {
            return await runPrompt('implement', { issueRef: issue, cwd: wtPath });
          }
        )
    );
  });

  process.exitCode = code;
}
