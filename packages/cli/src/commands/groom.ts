import { autoSelectIssue } from '../lib/github.js';
import { withStageHooks } from '../lib/hooks.js';
import { withIssueLock } from '../lib/lock.js';
import { runPrompt } from '../lib/prompt-runner.js';
import { printAutoSummary, type AutoResult } from './ship.js';

export interface GroomOptions {
  auto: boolean;
}

function groomOneIssue(issueStr: string): { success: boolean; error?: string } {
  const code = withIssueLock(issueStr, () =>
    withStageHooks('groom', { issueNumber: issueStr }, () =>
      runPrompt('groom', { issueRef: issueStr })
    )
  );
  return code === 0
    ? { success: true }
    : { success: false, error: 'agent exited with non-zero status' };
}

export function groomCommand(issue?: string, options: GroomOptions = { auto: false }) {
  if (options.auto) {
    const results: AutoResult[] = [];

    for (;;) {
      const candidate = autoSelectIssue('shipper:new');
      if (!candidate) break;

      console.log(`\nAuto: grooming issue #${candidate.number} — ${candidate.title}`);
      const result = groomOneIssue(String(candidate.number));

      results.push({
        issue: candidate.number,
        title: candidate.title,
        outcome: result.success ? 'pass' : 'fail',
        error: result.error,
      });

      if (!result.success) break;
    }

    printAutoSummary(results);
    process.exit(results.some((r) => r.outcome === 'fail') ? 1 : 0);
  }

  if (!issue) {
    const selected = autoSelectIssue('shipper:new');
    if (!selected) {
      console.error("No issues ready for grooming. Create one with 'shipper new'.");
      process.exit(1);
    }
    console.error(`Auto-selected #${selected.number}: ${selected.title}`);
    issue = String(selected.number);
  }

  process.exit(groomOneIssue(issue).success ? 0 : 1);
}
