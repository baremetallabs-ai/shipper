import { autoSelectIssue } from '@dnsquared/shipper-core';
import type { CommandMode } from '@dnsquared/shipper-core';
import { withStageHooks } from '@dnsquared/shipper-core';
import { withIssueLock } from '@dnsquared/shipper-core';
import { runPrompt } from '@dnsquared/shipper-core';
import { printAutoSummary, type AutoResult } from './ship.js';

export interface GroomOptions {
  auto: boolean;
  mode?: CommandMode;
}

async function groomOneIssue(
  repo: string,
  issueStr: string,
  mode?: CommandMode
): Promise<{ success: boolean; error?: string }> {
  const code = await withIssueLock(repo, issueStr, () =>
    withStageHooks(
      'groom',
      { issueNumber: issueStr },
      async () => await runPrompt('groom', { repo, issueRef: issueStr, mode })
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
      const result = await groomOneIssue(repo, String(candidate.number), options.mode);

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

  process.exitCode = (await groomOneIssue(repo, issue, options.mode)).success ? 0 : 1;
}
