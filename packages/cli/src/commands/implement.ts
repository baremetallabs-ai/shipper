import { logger, generateBranchName, getRepoRoot } from '@dnsquared/shipper-core';
import { autoSelectIssue } from '@dnsquared/shipper-core';
import type { AgentName, CommandMode } from '@dnsquared/shipper-core';
import { formatConflictContext } from '@dnsquared/shipper-core';
import { getSettings, resolveBaseBranch } from '@dnsquared/shipper-core';
import { handleAgentCrash, processResult, scrubOutputDir } from '@dnsquared/shipper-core';
import { retryOnInvalidOutput } from '@dnsquared/shipper-core';
import { truncateLargeInput } from '@dnsquared/shipper-core';
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
      logger.error("No issues ready for implementation. Run 'shipper plan' first.");
      process.exit(1);
    }
    logger.error(`Auto-selected #${selected.number}: ${selected.title}`);
    issue = String(selected.number);
  }

  await withIssueLock(repo, issue, async () => {
    const repoRoot = await getRepoRoot();
    const branch = await generateBranchName(repo, issue);
    const settings = getSettings();
    const baseBranch = await resolveBaseBranch(repo, settings.defaultBaseBranch);

    await withStageHooks('implement', { issueNumber: issue, branchName: branch }, async () => {
      await withWorktree(
        {
          repoRoot,
          branch,
          createBranch: true,
          baseBranch,
          issueNumber: issue,
          stage: 'implement',
        },
        async (wtPath) => {
          await scrubOutputDir(wtPath);
          const getTransportUserInput = async (
            conflictContext?: Parameters<typeof formatConflictContext>[0],
            pushError?: string,
            installError?: string
          ): Promise<string | undefined> => {
            if (conflictContext) {
              return await truncateLargeInput(
                wtPath,
                formatConflictContext(conflictContext),
                'conflict-context.txt'
              );
            }
            if (pushError) {
              return await truncateLargeInput(wtPath, pushError, 'push-error.txt');
            }
            if (installError) {
              return await truncateLargeInput(wtPath, installError, 'install-error.txt');
            }
            return undefined;
          };
          const transportCode = await withGitTransport(
            { wtPath, repoRoot, baseBranch, pushMode: 'new-branch' },
            async (conflictContext, pushError, installError) => {
              return runPrompt('implement', {
                repo,
                issueRef: issue,
                cwd: wtPath,
                mode,
                agent,
                model,
                userInput: await getTransportUserInput(conflictContext, pushError, installError),
              });
            }
          );
          if (transportCode !== 0) {
            process.exitCode = transportCode;
            return;
          }
          try {
            const result = await retryOnInvalidOutput({
              cwd: wtPath,
              stage: 'implement',
              retry: async (userInput) =>
                withGitTransport(
                  { wtPath, repoRoot, baseBranch, pushMode: 'new-branch' },
                  async (conflictContext, pushError, installError) =>
                    runPrompt('implement', {
                      repo,
                      issueRef: issue,
                      cwd: wtPath,
                      mode,
                      agent,
                      model,
                      userInput:
                        (await getTransportUserInput(conflictContext, pushError, installError)) ??
                        userInput,
                    })
                ),
            });
            await processResult({
              repo,
              issueNumber: issue,
              stage: 'implement',
              cwd: wtPath,
              result,
            });
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            logger.error(detail);
            await handleAgentCrash(repo, issue, 'implement', detail);
            process.exitCode = 1;
            return;
          }
        }
      );
    });
  });
}
