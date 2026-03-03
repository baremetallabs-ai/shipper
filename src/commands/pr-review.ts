import { autoSelectPrForStage } from '../lib/github.js';
import { runPrompt } from '../lib/prompt-runner.js';

export function prReviewCommand(pr?: string) {
  if (!pr) {
    const selected = autoSelectPrForStage(
      'shipper:pr-open',
      "No PRs ready for review. Run 'shipper pr open' first."
    );
    console.error(
      `Auto-selected PR #${selected.pr} (issue #${selected.issue.number}: ${selected.issue.title})`
    );
    pr = selected.pr;
  }

  process.exit(runPrompt('pr_review', { prRef: pr }));
}
