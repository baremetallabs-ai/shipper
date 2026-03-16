import { findBranchForIssue, getRepoRoot } from '@dnsquared/shipper-core';
import { autoSelectIssue, resolveBaseBranch, resolveRef } from '@dnsquared/shipper-core';
import type { AgentName, CommandMode } from '@dnsquared/shipper-core';
import { formatConflictContext } from '@dnsquared/shipper-core';
import { handleAgentCrash, processResult, scrubOutputDir } from '@dnsquared/shipper-core';
import { retryOnInvalidOutput } from '@dnsquared/shipper-core';
import { withStageHooks } from '@dnsquared/shipper-core';
import { getSettings } from '@dnsquared/shipper-core';
import { withIssueLock } from '@dnsquared/shipper-core';
import { withGitTransport } from '@dnsquared/shipper-core';
import { withWorktree } from '@dnsquared/shipper-core';
import { runPrompt } from '@dnsquared/shipper-core';

export async function prOpenCommand(
  repo: string,
  issue?: string,
  mode?: CommandMode,
  agent?: AgentName,
  model?: string
): Promise<void> {
  if (!issue) {
    const selected = await autoSelectIssue(repo, 'shipper:implemented');
    if (!selected) {
      console.error("No issues ready for PR. Run 'shipper implement' first.");
      process.exit(1);
    }
    console.error(`Auto-selected #${selected.number}: ${selected.title}`);
    issue = String(selected.number);
  } else {
    const resolved = await resolveRef(repo, issue, 'issue');
    issue = resolved.issueNumber;
  }

  const settings = getSettings();
  const baseBranch = await resolveBaseBranch(repo, settings.defaultBaseBranch);

  await withIssueLock(repo, issue, async () => {
    const repoRoot = await getRepoRoot();
    const branch = await findBranchForIssue(issue);

    await withStageHooks('pr-open', { issueNumber: issue, branchName: branch }, async () => {
      await withWorktree(
        { repoRoot, branch, createBranch: false, issueNumber: issue, stage: 'pr-open' },
        async (wtPath) => {
          await scrubOutputDir(wtPath);
          const transportCode = await withGitTransport(
            { wtPath, repoRoot, baseBranch, pushMode: 'force-with-lease' },
            (conflictContext, pushError) => {
              return runPrompt('pr_open', {
                repo,
                issueRef: issue,
                cwd: wtPath,
                baseBranch,
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
                { wtPath, repoRoot, baseBranch, pushMode: 'force-with-lease' },
                (conflictContext, pushError) =>
                  runPrompt('pr_open', {
                    repo,
                    issueRef: issue,
                    cwd: wtPath,
                    baseBranch,
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
            await processResult({ repo, issueNumber: issue, stage: 'pr_open', cwd: wtPath });
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            await handleAgentCrash(repo, issue, 'pr_open', detail);
            process.exitCode = 1;
            return;
          }
        }
      );
    });
  });
}
