import { autoSelectIssue } from '../lib/github.js';
import { withIssueLock } from '../lib/lock.js';
import { runPrompt } from '../lib/prompt-runner.js';

export function groomCommand(issue?: string) {
  if (!issue) {
    const selected = autoSelectIssue('shipper:new');
    if (!selected) {
      console.error("No issues ready for grooming. Create one with 'shipper new'.");
      process.exit(1);
    }
    console.error(`Auto-selected #${selected.number}: ${selected.title}`);
    issue = String(selected.number);
  }

  process.exit(withIssueLock(issue, () => runPrompt('groom', { issueRef: issue })));
}
