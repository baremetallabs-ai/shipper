import { autoSelectPrForStage, resolveRef } from '../lib/github.js';
import { withIssueLock } from '../lib/lock.js';
import { runPrompt } from '../lib/prompt-runner.js';

export function prReviewCommand(pr?: string) {
  let issueNumber: string;

  if (!pr) {
    const selected = autoSelectPrForStage(
      'shipper:pr-open',
      "No PRs ready for review. Run 'shipper pr open' first."
    );
    console.error(
      `Auto-selected PR #${selected.pr} (issue #${selected.issue.number}: ${selected.issue.title})`
    );
    pr = selected.pr;
    issueNumber = String(selected.issue.number);
  } else {
    const resolved = resolveRef(pr, 'both');
    pr = resolved.prNumber!;
    issueNumber = resolved.issueNumber;
  }

  process.exit(withIssueLock(issueNumber, () => runPrompt('pr_review', { prRef: pr })));
}
