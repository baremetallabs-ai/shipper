import {
  autoSelectIssue,
  findBranchForIssue,
  formatConflictContext,
  getRepoRoot,
  getSettings,
  handleAgentCrash,
  logger,
  processResult,
  resolveBaseBranch,
  resolveRef,
  retryOnInvalidOutput,
  runPrompt,
  scrubOutputDir,
  toErrorMessage,
  tryResolvePrForIssue,
  truncateLargeInput,
  withGitTransport,
  withIssueLock,
  withStageHooks,
  withWorktree,
} from '@dnsquared/shipper-core';
import type { AgentName, CommandMode } from '@dnsquared/shipper-core';

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
      throw new Error("No issues ready for PR. Run 'shipper implement' first.");
    }
    logger.error(`Auto-selected #${selected.number}: ${selected.title}`);
    issue = String(selected.number);
  } else {
    const resolved = await resolveRef(repo, issue, 'issue');
    issue = resolved.issueNumber;
  }
  const existingPrNumber = await tryResolvePrForIssue(repo, Number(issue));

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
            { wtPath, repoRoot, baseBranch, pushMode: 'force-with-lease' },
            async (conflictContext, pushError, installError) => {
              return runPrompt('pr_open', {
                repo,
                issueRef: issue,
                cwd: wtPath,
                baseBranch,
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
              stage: 'pr_open',
              retry: async (userInput) =>
                withGitTransport(
                  { wtPath, repoRoot, baseBranch, pushMode: 'force-with-lease' },
                  async (conflictContext, pushError, installError) =>
                    runPrompt('pr_open', {
                      repo,
                      issueRef: issue,
                      cwd: wtPath,
                      baseBranch,
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
              stage: 'pr_open',
              cwd: wtPath,
              result,
              prNumber: existingPrNumber,
            });
          } catch (error) {
            const detail = toErrorMessage(error);
            logger.error(detail);
            await handleAgentCrash(repo, issue, 'pr_open', detail);
            process.exitCode = 1;
            return;
          }
        }
      );
    });
  });
}
