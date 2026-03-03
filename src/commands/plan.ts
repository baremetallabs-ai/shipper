import { autoSelectIssue } from '../lib/github.js';
import { runPrompt } from '../lib/prompt-runner.js';

export function planCommand(issue?: string) {
  if (!issue) {
    const selected = autoSelectIssue('shipper:designed');
    if (!selected) {
      console.error("No issues ready for planning. Run 'shipper design' first.");
      process.exit(1);
    }
    console.error(`Auto-selected #${selected.number}: ${selected.title}`);
    issue = String(selected.number);
  }

  process.exit(runPrompt('plan', { issueRef: issue }));
}
