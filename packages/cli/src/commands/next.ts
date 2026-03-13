import {
  gh,
  resolveRef,
  tryResolvePrForIssue,
  BLOCKED_LABEL,
  FAILED_LABEL,
  LOCKED_LABEL,
  NEW_LABEL,
  GROOMED_LABEL,
  DESIGNED_LABEL,
  PLANNED_LABEL,
  IMPLEMENTED_LABEL,
  PR_OPEN_LABEL,
  PR_REVIEWED_LABEL,
  READY_LABEL,
} from '@dnsquared/shipper-core';
import type { AgentName } from '@dnsquared/shipper-core';
import { withIssueLock } from '@dnsquared/shipper-core';
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

const CONTROL_LABELS = [BLOCKED_LABEL, LOCKED_LABEL, FAILED_LABEL];

async function resolvePrForIssue(repo: string, issueNumber: number): Promise<string> {
  const pr = await tryResolvePrForIssue(repo, issueNumber);
  if (!pr) {
    console.error(
      `No open PR found for issue #${issueNumber}. Run \`shipper pr open ${issueNumber}\` first.`
    );
    process.exit(1);
  }
  return pr;
}

export async function nextCommand(repo: string, ref: string, agent?: AgentName): Promise<void> {
  if (!ref) {
    console.error('Error: Please provide an issue or PR number.');
    console.error('Usage: shipper next <issue-or-pr>');
    process.exit(1);
  }

  // Strip leading # if present
  const cleanRef = ref.replace(/^#/, '');

  const resolved = await resolveRef(repo, cleanRef, 'issue');
  const { stdout } = await gh([
    'issue',
    'view',
    resolved.issueNumber,
    '-R',
    repo,
    '--json',
    'number,labels',
  ]);
  const issueData = JSON.parse(stdout.trim()) as IssueData;
  const issueNumber = issueData.number;
  const allLabels = issueData.labels
    .map((l) => l.name)
    .filter((name) => name.startsWith('shipper:'));
  const isBlocked = allLabels.includes(BLOCKED_LABEL);
  const isFailed = allLabels.includes(FAILED_LABEL);

  if (isFailed) {
    console.error(`Issue #${issueNumber} has the shipper:failed label.`);
    process.exit(1);
  }

  const shipperLabels = allLabels.filter((name) => !CONTROL_LABELS.includes(name));

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

  const label = shipperLabels[0];
  if (!label) {
    console.error(
      `No shipper label found on issue #${issueNumber}. Use \`shipper new\` to start the workflow.`
    );
    process.exit(1);
  }

  if (isBlocked && label !== NEW_LABEL) {
    console.error(
      `Issue #${issueNumber} is blocked. Run 'shipper unblock ${issueNumber}' to check if it can proceed.`
    );
    process.exit(1);
  }

  const issueStr = String(issueNumber);

  // Dispatch (wrapped in lock so inner commands become passthroughs)
  await withIssueLock(repo, issueStr, async () => {
    switch (label) {
      case NEW_LABEL:
        console.log(`Running: shipper groom ${issueStr}`);
        await groomCommand(repo, issueStr, { auto: false, agent });
        break;
      case GROOMED_LABEL:
        console.log(`Running: shipper design ${issueStr}`);
        await designCommand(repo, issueStr, undefined, agent);
        break;
      case DESIGNED_LABEL:
        console.log(`Running: shipper plan ${issueStr}`);
        await planCommand(repo, issueStr, undefined, agent);
        break;
      case PLANNED_LABEL:
        console.log(`Running: shipper implement ${issueStr}`);
        await implementCommand(repo, issueStr, undefined, agent);
        break;
      case IMPLEMENTED_LABEL:
        console.log(`Running: shipper pr open ${issueStr}`);
        await prOpenCommand(repo, issueStr, undefined, agent);
        break;
      case PR_OPEN_LABEL: {
        const prNum = await resolvePrForIssue(repo, issueNumber);
        console.log(`Running: shipper pr review ${prNum}`);
        await prReviewCommand(repo, prNum, undefined, agent);
        break;
      }
      case PR_REVIEWED_LABEL: {
        const prNum = await resolvePrForIssue(repo, issueNumber);
        console.log(`Running: shipper pr remediate ${prNum}`);
        await prRemediateCommand(repo, prNum, undefined, agent);
        break;
      }
      case READY_LABEL:
        console.log(`Issue #${issueNumber} is ready — no remaining workflow steps.`);
        break;
      default:
        console.error(`Unrecognized shipper label "${label}" on issue #${issueNumber}.`);
        process.exit(1);
    }
  });
}
