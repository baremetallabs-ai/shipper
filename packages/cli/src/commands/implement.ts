import { generateBranchName, getRepoRoot } from '@dnsquared/shipper-core';
import { autoSelectIssue } from '@dnsquared/shipper-core';
import type { AgentName, CommandMode } from '@dnsquared/shipper-core';
import { formatConflictContext } from '@dnsquared/shipper-core';
import { getSettings, resolveBaseBranch } from '@dnsquared/shipper-core';
import { withStageHooks } from '@dnsquared/shipper-core';
import { withIssueLock } from '@dnsquared/shipper-core';
import { withGitTransport } from '@dnsquared/shipper-core';
import { withWorktree } from '@dnsquared/shipper-core';
import { runPrompt } from '@dnsquared/shipper-core';

export async function implementCommand(
  repo: string,
  issue?: string,
  mode?: CommandMode,
  agent?: AgentName
): Promise<void> {
  if (!issue) {
    const selected = await autoSelectIssue(repo, 'shipper:planned');
    if (!selected) {
      console.error("No issues ready for implementation. Run 'shipper plan' first.");
      process.exit(1);
    }
    console.error(`Auto-selected #${selected.number}: ${selected.title}`);
    issue = String(selected.number);
  }

  const code = await withIssueLock(repo, issue, async () => {
    const repoRoot = await getRepoRoot();
    const branch = await generateBranchName(repo, issue);
    const settings = getSettings();
    const baseBranch = await resolveBaseBranch(repo, settings.defaultBaseBranch);

    return await withStageHooks(
      'implement',
      { issueNumber: issue, branchName: branch },
      async () =>
        await withWorktree(
          { repoRoot, branch, createBranch: true, issueNumber: issue, stage: 'implement' },
          async (wtPath) => {
            return await withGitTransport(
              { wtPath, repoRoot, baseBranch, pushMode: 'new-branch' },
              async (conflictContext) =>
                await runPrompt('implement', {
                  repo,
                  issueRef: issue,
                  cwd: wtPath,
                  mode,
                  agent,
                  userInput: conflictContext ? formatConflictContext(conflictContext) : undefined,
                })
            );
          }
        )
    );
  });

  process.exitCode = code;
}
