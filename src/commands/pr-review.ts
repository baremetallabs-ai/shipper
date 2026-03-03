import { selectIssuesForStage, tryResolvePrForIssue } from '../lib/github.js';
import { runPrompt } from '../lib/prompt-runner.js';

export function prReviewCommand(pr?: string) {
  if (!pr) {
    const issues = selectIssuesForStage('shipper:pr-open');
    let resolved: string | undefined;
    let resolvedIssue: { number: number; title: string } | undefined;
    for (const issue of issues) {
      resolved = tryResolvePrForIssue(issue.number);
      if (resolved) {
        resolvedIssue = issue;
        break;
      }
    }
    if (!resolved || !resolvedIssue) {
      console.error("No PRs ready for review. Run 'shipper pr open' first.");
      process.exit(1);
    }
    console.error(
      `Auto-selected PR #${resolved} (issue #${resolvedIssue.number}: ${resolvedIssue.title})`
    );
    pr = resolved;
  }

  process.exit(runPrompt('pr_review', { prRef: pr }));
}
