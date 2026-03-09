import { autoSelectIssue } from '@dnsquared/shipper-core';
import { withStageHooks } from '@dnsquared/shipper-core';
import { withIssueLock } from '@dnsquared/shipper-core';
import { runPrompt } from '@dnsquared/shipper-core';
import { printAutoSummary, type AutoResult } from './ship.js';

export interface GroomOptions {
  auto: boolean;
}

async function groomOneIssue(issueStr: string): Promise<{ success: boolean; error?: string }> {
  const code = await withIssueLock(issueStr, () =>
    withStageHooks(
      'groom',
      { issueNumber: issueStr },
      async () => await runPrompt('groom', { issueRef: issueStr })
    )
  );
  return code === 0
    ? { success: true }
    : { success: false, error: 'agent exited with non-zero status' };
}

export async function groomCommand(
  issue?: string,
  options: GroomOptions = { auto: false }
): Promise<void> {
  if (options.auto) {
    const results: AutoResult[] = [];

    for (;;) {
      const candidate = await autoSelectIssue('shipper:new');
      if (!candidate) break;

      console.log(`\nAuto: grooming issue #${candidate.number} — ${candidate.title}`);
      const result = await groomOneIssue(String(candidate.number));

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
    const selected = await autoSelectIssue('shipper:new');
    if (!selected) {
      console.error("No issues ready for grooming. Create one with 'shipper new'.");
      process.exit(1);
    }
    console.error(`Auto-selected #${selected.number}: ${selected.title}`);
    issue = String(selected.number);
  }

  process.exitCode = (await groomOneIssue(issue)).success ? 0 : 1;
}
