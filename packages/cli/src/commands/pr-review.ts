import { autoSelectPrForStage, gh, resolveRef } from '@dnsquared/shipper-core';
import type { AgentName, CommandMode } from '@dnsquared/shipper-core';
import {
  handleAgentCrash,
  processResult,
  scrubOutputDir,
  writeContextFile,
} from '@dnsquared/shipper-core';
import { withStageHooks } from '@dnsquared/shipper-core';
import { withIssueLock } from '@dnsquared/shipper-core';
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
    console.error(
      `Auto-selected PR #${selected.pr} (issue #${selected.issue.number}: ${selected.issue.title})`
    );
    pr = selected.pr;
    issueNumber = String(selected.issue.number);
  } else {
    const resolved = await resolveRef(repo, pr, 'both');
    pr = resolved.prNumber;
    issueNumber = resolved.issueNumber;
  }

  await withIssueLock(
    repo,
    issueNumber,
    async () =>
      await withStageHooks('pr-review', { issueNumber }, async () => {
        const cwd = process.cwd();
        await scrubOutputDir(cwd);

        const { stdout: diff } = await gh(['pr', 'diff', pr, '-R', repo]);
        await writeContextFile(cwd, 'pr-diff.patch', diff);

        const { stdout: prFiles } = await gh([
          'api',
          `repos/${repo}/pulls/${pr}/files`,
          '--paginate',
        ]);
        await writeContextFile(cwd, 'pr-files.json', prFiles);

        const { stdout: prMetadata } = await gh([
          'pr',
          'view',
          pr,
          '-R',
          repo,
          '--json',
          'headRefOid,author,title,headRefName',
        ]);
        await writeContextFile(cwd, 'pr-metadata.json', prMetadata);

        await runPrompt('pr_review', {
          repo,
          issueRef: issueNumber,
          prRef: pr,
          mode,
          agent,
          model,
        });

        try {
          await processResult({
            repo,
            issueNumber,
            stage: 'pr_review',
            cwd,
            prNumber: pr,
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          await handleAgentCrash(repo, issueNumber, 'pr_review', detail);
          process.exitCode = 1;
        }
      })
  );
}
