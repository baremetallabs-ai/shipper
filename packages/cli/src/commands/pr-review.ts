import {
  logger,
  autoSelectPrForStage,
  getBranchForPR,
  getRepoRoot,
  gh,
  parseDiffHunks,
  resolveRef,
} from '@dnsquared/shipper-core';
import type { AgentName, CommandMode } from '@dnsquared/shipper-core';
import {
  handleAgentCrash,
  processResult,
  retryOnInvalidOutput,
  scrubOutputDir,
  writeContextFile,
} from '@dnsquared/shipper-core';
import { withStageHooks } from '@dnsquared/shipper-core';
import { withIssueLock } from '@dnsquared/shipper-core';
import { withWorktree } from '@dnsquared/shipper-core';
import { runPrompt } from '@dnsquared/shipper-core';

export async function prReviewCommand(
  repo: string,
  pr?: string,
  mode?: CommandMode,
  agent?: AgentName,
  model?: string
): Promise<void> {
  let issueNumber: string;

  if (!pr) {
    const selected = await autoSelectPrForStage(
      repo,
      'shipper:pr-open',
      "No PRs ready for review. Run 'shipper pr open' first."
    );
    logger.error(
      `Auto-selected PR #${selected.pr} (issue #${selected.issue.number}: ${selected.issue.title})`
    );
    pr = selected.pr;
    issueNumber = String(selected.issue.number);
  } else {
    const resolved = await resolveRef(repo, pr, 'both');
    pr = resolved.prNumber;
    issueNumber = resolved.issueNumber;
  }

  await withIssueLock(repo, issueNumber, async () => {
    const repoRoot = await getRepoRoot();
    const branch = await getBranchForPR(repo, pr);

    await withStageHooks('pr-review', { issueNumber, branchName: branch }, async () => {
      await withWorktree(
        { repoRoot, branch, createBranch: false, issueNumber, stage: 'pr-review' },
        async (wtPath) => {
          await scrubOutputDir(wtPath);
          const { stdout: diff } = await gh(['pr', 'diff', pr, '-R', repo]);
          const diffHunks = parseDiffHunks(diff);
          await writeContextFile(wtPath, 'pr-diff.patch', diff);

          const { stdout: prFilesRaw } = await gh([
            'api',
            `repos/${repo}/pulls/${pr}/files`,
            '--paginate',
            '--slurp',
          ]);
          const parsedPrFiles = (
            JSON.parse(prFilesRaw) as Array<Array<{ filename: string }>>
          ).flat();
          const prFiles = JSON.stringify(parsedPrFiles);
          const prFileSet = new Set(parsedPrFiles.map((file) => file.filename));
          await writeContextFile(wtPath, 'pr-files.json', prFiles);

          const { stdout: prMetadata } = await gh([
            'pr',
            'view',
            pr,
            '-R',
            repo,
            '--json',
            'headRefOid,author,title,headRefName',
          ]);
          await writeContextFile(wtPath, 'pr-metadata.json', prMetadata);

          await runPrompt('pr_review', {
            repo,
            issueRef: issueNumber,
            prRef: pr,
            cwd: wtPath,
            mode,
            agent,
            model,
          });
          try {
            const result = await retryOnInvalidOutput({
              cwd: wtPath,
              stage: 'pr_review',
              prFiles: prFileSet,
              diffHunks,
              retry: (userInput) =>
                runPrompt('pr_review', {
                  repo,
                  issueRef: issueNumber,
                  prRef: pr,
                  cwd: wtPath,
                  mode,
                  agent,
                  model,
                  userInput,
                }),
            });
            await processResult({
              repo,
              issueNumber,
              stage: 'pr_review',
              cwd: wtPath,
              result,
              prNumber: pr,
            });
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            logger.error(detail);
            await handleAgentCrash(repo, issueNumber, 'pr_review', detail);
            process.exitCode = 1;
          }
        }
      );
    });
  });
}
