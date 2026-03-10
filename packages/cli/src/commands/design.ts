import { autoSelectIssue } from '@dnsquared/shipper-core';
import type { AgentName, CommandMode } from '@dnsquared/shipper-core';
import { withStageHooks } from '@dnsquared/shipper-core';
import { withIssueLock } from '@dnsquared/shipper-core';
import { runPrompt } from '@dnsquared/shipper-core';

export async function designCommand(
  repo: string,
  issue?: string,
  mode?: CommandMode,
  agent?: AgentName
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

  const code = await withIssueLock(
    repo,
    issue,
    async () =>
      await withStageHooks(
        'design',
        { issueNumber: issue },
        async () => await runPrompt('design', { repo, issueRef: issue, mode, agent })
      )
  );

  process.exitCode = code;
}
