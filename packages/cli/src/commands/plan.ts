import { autoSelectIssue, generateBranchName, getRepoRoot } from '@dnsquared/shipper-core';
import type { AgentName, CommandMode } from '@dnsquared/shipper-core';
import { handleAgentCrash, processResult, scrubOutputDir } from '@dnsquared/shipper-core';
import { withStageHooks } from '@dnsquared/shipper-core';
import { withIssueLock } from '@dnsquared/shipper-core';
import { withWorktree } from '@dnsquared/shipper-core';
import { runPrompt } from '@dnsquared/shipper-core';

export async function planCommand(
  repo: string,
  issue?: string,
  mode?: CommandMode,
  agent?: AgentName,
  model?: string
): Promise<void> {
  if (!issue) {
    const selected = await autoSelectIssue(repo, 'shipper:designed');
    if (!selected) {
      console.error("No issues ready for planning. Run 'shipper design' first.");
      process.exit(1);
    }
    console.error(`Auto-selected #${selected.number}: ${selected.title}`);
    issue = String(selected.number);
  }

  await withIssueLock(repo, issue, async () => {
    const repoRoot = await getRepoRoot();
    const branch = await generateBranchName(repo, issue);

    return await withStageHooks(
      'plan',
      { issueNumber: issue, branchName: branch },
      async () =>
        await withWorktree(
          { repoRoot, branch, createBranch: true, issueNumber: issue, stage: 'plan' },
          async (wtPath) => {
            await scrubOutputDir(wtPath);
            await runPrompt('plan', { repo, issueRef: issue, cwd: wtPath, mode, agent, model });
            try {
              await processResult({ repo, issueNumber: issue, stage: 'plan', cwd: wtPath });
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error);
              await handleAgentCrash(repo, issue, 'plan', detail);
              process.exitCode = 1;
              return;
            }
          }
        )
    );
  });
}
