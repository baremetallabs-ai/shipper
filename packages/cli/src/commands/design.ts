import { autoSelectIssue } from '@dnsquared/shipper-core';
import type { AgentName, CommandMode } from '@dnsquared/shipper-core';
import { handleAgentCrash, processResult, scrubOutputDir } from '@dnsquared/shipper-core';
import { withStageHooks } from '@dnsquared/shipper-core';
import { withIssueLock } from '@dnsquared/shipper-core';
import { runPrompt } from '@dnsquared/shipper-core';

export async function designCommand(
  repo: string,
  issue?: string,
  mode?: CommandMode,
  agent?: AgentName,
  model?: string
): Promise<void> {
  if (!issue) {
    const selected = await autoSelectIssue(repo, 'shipper:groomed');
    if (!selected) {
      console.error("No issues ready for design. Run 'shipper groom' first.");
      process.exit(1);
    }
    console.error(`Auto-selected #${selected.number}: ${selected.title}`);
    issue = String(selected.number);
  }

  await withIssueLock(
    repo,
    issue,
    async () =>
      await withStageHooks('design', { issueNumber: issue }, async () => {
        const cwd = process.cwd();
        await scrubOutputDir(cwd);
        await runPrompt('design', { repo, issueRef: issue, mode, agent, model });
        try {
          await processResult({ repo, issueNumber: issue, stage: 'design', cwd });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          await handleAgentCrash(repo, issue, 'design', detail);
          process.exitCode = 1;
          return;
        }
      })
  );
}
