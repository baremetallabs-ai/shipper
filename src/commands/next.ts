import { execFileSync } from 'node:child_process';
import { resolveRef, tryResolvePrForIssue } from '../lib/github.js';
import { withIssueLock } from '../lib/lock.js';
import { groomCommand } from './groom.js';
import { designCommand } from './design.js';
import { planCommand } from './plan.js';
import { implementCommand } from './implement.js';
import { prOpenCommand } from './pr-open.js';
import { prReviewCommand } from './pr-review.js';
import { prRemediateCommand } from './pr-remediate.js';

interface IssueLabel {
  name: string;
}

interface IssueData {
  number: number;
  labels: IssueLabel[];
}

function ghJson<T>(args: string[]): T {
  const output = execFileSync('gh', args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  return JSON.parse(output) as T;
}

function resolvePrForIssue(issueNumber: number): string {
  const pr = tryResolvePrForIssue(issueNumber);
  if (!pr) {
    console.error(
      `No open PR found for issue #${issueNumber}. Run \`shipper pr open ${issueNumber}\` first.`
    );
    process.exit(1);
  }
  return pr;
}

export function nextCommand(ref: string) {
  if (!ref) {
    console.error('Error: Please provide an issue or PR number.');
    console.error('Usage: shipper next <issue-or-pr>');
    process.exit(1);
  }

  // Strip leading # if present
  const cleanRef = ref.replace(/^#/, '');

  const resolved = resolveRef(cleanRef, 'issue');
  const issueData = ghJson<IssueData>([
    'issue',
    'view',
    resolved.issueNumber,
    '--json',
    'number,labels',
  ]);
  const issueNumber = issueData.number;
  const allLabels = issueData.labels
    .map((l) => l.name)
    .filter((name) => name.startsWith('shipper:'));
  const isBlocked = allLabels.includes('shipper:blocked');
  const shipperLabels = allLabels.filter(
    (name) => name !== 'shipper:blocked' && name !== 'shipper:locked'
  );

  // Validate labels
  if (shipperLabels.length === 0) {
    console.error(
      `No shipper label found on issue #${issueNumber}. Use \`shipper new\` to start the workflow.`
    );
    process.exit(1);
  }

  if (shipperLabels.length > 1) {
    console.error(
      `Multiple shipper labels found on issue #${issueNumber}. Please resolve manually.`
    );
    process.exit(1);
  }

  if (isBlocked) {
    console.error(
      `Issue #${issueNumber} is blocked. Run 'shipper unblock ${issueNumber}' to check if it can proceed.`
    );
    process.exit(1);
  }

  const label = shipperLabels[0]!;
  const issueStr = String(issueNumber);

  // Dispatch (wrapped in lock so inner commands become passthroughs)
  withIssueLock(issueStr, () => {
    switch (label) {
      case 'shipper:new':
        console.log(`Running: shipper groom ${issueStr}`);
        groomCommand(issueStr);
        break;
      case 'shipper:groomed':
        console.log(`Running: shipper design ${issueStr}`);
        designCommand(issueStr);
        break;
      case 'shipper:designed':
        console.log(`Running: shipper plan ${issueStr}`);
        planCommand(issueStr);
        break;
      case 'shipper:planned':
        console.log(`Running: shipper implement ${issueStr}`);
        implementCommand(issueStr);
        break;
      case 'shipper:implemented':
        console.log(`Running: shipper pr open ${issueStr}`);
        prOpenCommand(issueStr);
        break;
      case 'shipper:pr-open': {
        const prNum = resolvePrForIssue(issueNumber);
        console.log(`Running: shipper pr review ${prNum}`);
        prReviewCommand(prNum);
        break;
      }
      case 'shipper:pr-reviewed': {
        const prNum = resolvePrForIssue(issueNumber);
        console.log(`Running: shipper pr remediate ${prNum}`);
        prRemediateCommand(prNum);
        break;
      }
      case 'shipper:ready':
        console.log(`Issue #${issueNumber} is ready — no remaining workflow steps.`);
        break;
      default:
        console.error(`Unrecognized shipper label "${label}" on issue #${issueNumber}.`);
        process.exit(1);
    }
  });
}
