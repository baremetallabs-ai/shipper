import { autoSelectIssue } from '../lib/github.js';
import { withIssueLock } from '../lib/lock.js';
import { runPrompt } from '../lib/prompt-runner.js';

export function designCommand(issue?: string) {
  if (!issue) {
    const selected = autoSelectIssue('shipper:groomed');
    if (!selected) {
      console.error("No issues ready for design. Run 'shipper groom' first.");
      process.exit(1);
    }
    console.error(`Auto-selected #${selected.number}: ${selected.title}`);
    issue = String(selected.number);
  }

  process.exit(withIssueLock(issue, () => runPrompt('design', { issueRef: issue })));
}
