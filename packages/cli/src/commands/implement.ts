import { generateBranchName, getRepoRoot } from '@dnsquared/shipper-core';
import { autoSelectIssue } from '@dnsquared/shipper-core';
import type { AgentName, CommandMode } from '@dnsquared/shipper-core';
import { formatConflictContext } from '@dnsquared/shipper-core';
import { getSettings, resolveBaseBranch } from '@dnsquared/shipper-core';
import { handleAgentCrash, processResult, scrubOutputDir } from '@dnsquared/shipper-core';
import { retryOnInvalidOutput } from '@dnsquared/shipper-core';
import { withStageHooks } from '@dnsquared/shipper-core';
import { withIssueLock } from '@dnsquared/shipper-core';
import { withGitTransport } from '@dnsquared/shipper-core';
import { withWorktree } from '@dnsquared/shipper-core';
import { runPrompt } from '@dnsquared/shipper-core';

export async function implementCommand(
  repo: string,
  issue?: string,
  mode?: CommandMode,
  agent?: AgentName,
  model?: string
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

  await withIssueLock(repo, issue, async () => {
    const repoRoot = await getRepoRoot();
    const branch = await generateBranchName(repo, issue);
    const settings = getSettings();
    const baseBranch = await resolveBaseBranch(repo, settings.defaultBaseBranch);

    await withStageHooks('implement', { issueNumber: issue, branchName: branch }, async () => {
      await withWorktree(
        { repoRoot, branch, createBranch: true, issueNumber: issue, stage: 'implement' },
        async (wtPath) => {
          await scrubOutputDir(wtPath);
          const transportCode = await withGitTransport(
            { wtPath, repoRoot, baseBranch, pushMode: 'new-branch' },
            (conflictContext, pushError) => {
              return runPrompt('implement', {
                repo,
                issueRef: issue,
                cwd: wtPath,
                mode,
                agent,
                model,
                userInput: conflictContext
                  ? formatConflictContext(conflictContext)
                  : (pushError ?? undefined),
              });
            }
          );
          if (transportCode !== 0) {
            process.exitCode = transportCode;
            return;
          }
          await retryOnInvalidOutput({
            cwd: wtPath,
            retry: (userInput) =>
              withGitTransport(
                { wtPath, repoRoot, baseBranch, pushMode: 'new-branch' },
                (conflictContext, pushError) =>
                  runPrompt('implement', {
                    repo,
                    issueRef: issue,
                    cwd: wtPath,
                    mode,
                    agent,
                    model,
                    userInput: conflictContext
                      ? formatConflictContext(conflictContext)
                      : (pushError ?? userInput),
                  })
              ),
          });
          try {
            await processResult({ repo, issueNumber: issue, stage: 'implement', cwd: wtPath });
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            await handleAgentCrash(repo, issue, 'implement', detail);
            process.exitCode = 1;
            return;
          }
        }
      );
    });
  });
}
