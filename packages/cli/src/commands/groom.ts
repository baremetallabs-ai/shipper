import { autoSelectIssue } from '@dnsquared/shipper-core';
import type { AgentName, CommandMode } from '@dnsquared/shipper-core';
import { withStageHooks } from '@dnsquared/shipper-core';
import { withIssueLock } from '@dnsquared/shipper-core';
import { runPrompt } from '@dnsquared/shipper-core';
import { printAutoSummary, type AutoResult } from './ship.js';

export interface GroomOptions {
  auto: boolean;
  mode?: CommandMode;
  agent?: AgentName;
}

async function groomOneIssue(
  repo: string,
  issueStr: string,
  mode?: CommandMode,
  agent?: AgentName
): Promise<{ success: boolean; error?: string }> {
  const code = await withIssueLock(repo, issueStr, () =>
    withStageHooks(
      'groom',
      { issueNumber: issueStr },
      async () => await runPrompt('groom', { repo, issueRef: issueStr, mode, agent })
    )
  );
  return code === 0
    ? { success: true }
    : { success: false, error: 'agent exited with non-zero status' };
}

export async function groomCommand(
  repo: string,
  issue?: string,
  options: GroomOptions = { auto: false }
): Promise<void> {
  if (options.auto) {
    const results: AutoResult[] = [];

    for (;;) {
      const candidate = await autoSelectIssue(repo, 'shipper:new');
      if (!candidate) break;

      console.log(`\nAuto: grooming issue #${candidate.number} — ${candidate.title}`);
      const result = await groomOneIssue(
        repo,
        String(candidate.number),
        options.mode,
        options.agent
      );

      results.push({
        issue: candidate.number,
        title: candidate.title,
        outcome: result.success ? 'pass' : 'fail',
        error: result.error,
      });

      if (!result.success) break;
    }

    printAutoSummary(results);
    process.exitCode = results.some((r) => r.outcome === 'fail') ? 1 : 0;
    return;
  }

  if (!issue) {
    const selected = await autoSelectIssue(repo, 'shipper:new');
    if (!selected) {
      console.error("No issues ready for grooming. Create one with 'shipper new'.");
      process.exit(1);
    }
    console.error(`Auto-selected #${selected.number}: ${selected.title}`);
    issue = String(selected.number);
  }

  process.exitCode = (await groomOneIssue(repo, issue, options.mode, options.agent)).success
    ? 0
    : 1;
}
