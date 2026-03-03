import { execFileSync } from 'node:child_process';
import { tryResolvePrForIssue } from '../lib/github.js';
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

interface PrData {
  number: number;
  body: string;
}

function ghJson<T>(args: string[]): T {
  const output = execFileSync('gh', args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  return JSON.parse(output) as T;
}

function resolveIssueFromPrBody(body: string): string | undefined {
  const match = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i.exec(body);
  return match?.[1];
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

  let issueNumber: number;
  let isBlocked = false;
  let shipperLabels: string[];

  // Try as issue first
  try {
    const issueData = ghJson<IssueData>(['issue', 'view', cleanRef, '--json', 'number,labels']);
    issueNumber = issueData.number;
    const allLabels = issueData.labels
      .map((l) => l.name)
      .filter((name) => name.startsWith('shipper:'));
    isBlocked = allLabels.includes('shipper:blocked');
    shipperLabels = allLabels.filter((name) => name !== 'shipper:blocked');
  } catch {
    // Not an issue — try as PR
    let prData: PrData;
    try {
      prData = ghJson<PrData>(['pr', 'view', cleanRef, '--json', 'number,body']);
    } catch {
      console.error(`Could not find issue or PR matching '${cleanRef}'.`);
      process.exit(1);
    }

    const linkedIssue = resolveIssueFromPrBody(prData.body);
    if (!linkedIssue) {
      console.error(
        `Could not find a linked issue for PR #${prData.number}. Ensure the PR body references an issue (e.g., 'Closes #42').`
      );
      process.exit(1);
    }

    let issueData: IssueData;
    try {
      issueData = ghJson<IssueData>(['issue', 'view', linkedIssue, '--json', 'number,labels']);
    } catch {
      console.error(`Could not find issue #${linkedIssue} linked from PR #${prData.number}.`);
      process.exit(1);
    }
    issueNumber = issueData.number;
    const allLabels = issueData.labels
      .map((l) => l.name)
      .filter((name) => name.startsWith('shipper:'));
    isBlocked = allLabels.includes('shipper:blocked');
    shipperLabels = allLabels.filter((name) => name !== 'shipper:blocked');
  }

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

  // Dispatch
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
}
