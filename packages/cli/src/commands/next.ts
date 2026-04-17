import {
  BLOCKED_LABEL,
  CONTROL_LABEL_NAMES,
  DESIGNED_LABEL,
  FAILED_LABEL,
  GROOMED_LABEL,
  IMPLEMENTED_LABEL,
  NEW_LABEL,
  PLANNED_LABEL,
  PRIORITY_LABEL_NAMES,
  PR_OPEN_LABEL,
  PR_REVIEWED_LABEL,
  READY_LABEL,
  gh,
  logger,
  parseIssueNumberLabels,
  resolveRef,
  tryResolvePrForIssue,
  withIssueLock,
} from '@dnsquared/shipper-core';
import type { AgentName, CommandMode } from '@dnsquared/shipper-core';
import { groomCommand } from './groom.js';
import { designCommand } from './design.js';
import { planCommand } from './plan.js';
import { implementCommand } from './implement.js';
import { prOpenCommand } from './pr-open.js';
import { prReviewCommand } from './pr-review.js';
import { prRemediateCommand } from './pr-remediate.js';

async function resolvePrForIssue(repo: string, issueNumber: number): Promise<string> {
  const pr = await tryResolvePrForIssue(repo, issueNumber);
  if (!pr) {
    throw new Error(
      `No open PR found for issue #${issueNumber}. Run \`shipper pr open ${issueNumber}\` first.`
    );
  }
  return pr;
}

export async function nextCommand(
  repo: string,
  ref: string,
  mode?: CommandMode,
  agent?: AgentName,
  model?: string
): Promise<void> {
  if (!ref) {
    logger.error('Usage: shipper next <issue-or-pr>');
    throw new Error('Error: Please provide an issue or PR number.');
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
  const issueData = parseIssueNumberLabels(stdout.trim());
  const issueNumber = issueData.number;
  const allLabels = issueData.labels
    .map((l) => l.name)
    .filter((name) => name.startsWith('shipper:'));
  const isBlocked = allLabels.includes(BLOCKED_LABEL);
  const isFailed = allLabels.includes(FAILED_LABEL);

  if (isFailed) {
    throw new Error(`Issue #${issueNumber} has the shipper:failed label.`);
  }

  const shipperLabels = allLabels.filter(
    (name) => !CONTROL_LABEL_NAMES.includes(name) && !PRIORITY_LABEL_NAMES.includes(name)
  );

  // Validate labels
  if (shipperLabels.length === 0) {
    throw new Error(
      `No shipper label found on issue #${issueNumber}. Use \`shipper new\` to start the workflow.`
    );
  }

  if (shipperLabels.length > 1) {
    throw new Error(
      `Multiple shipper labels found on issue #${issueNumber}. Please resolve manually.`
    );
  }

  const label = shipperLabels[0];
  if (!label) {
    throw new Error(
      `No shipper label found on issue #${issueNumber}. Use \`shipper new\` to start the workflow.`
    );
  }

  if (isBlocked && label !== NEW_LABEL) {
    throw new Error(
      `Issue #${issueNumber} is blocked. Run 'shipper unblock ${issueNumber}' to check if it can proceed.`
    );
  }

  const issueStr = String(issueNumber);

  // Dispatch (wrapped in lock so inner commands become passthroughs)
  await withIssueLock(repo, issueStr, async () => {
    switch (label) {
      case NEW_LABEL:
        logger.log(`Running: shipper groom ${issueStr}`);
        await groomCommand(repo, issueStr, { auto: false, mode, agent, model });
        break;
      case GROOMED_LABEL:
        logger.log(`Running: shipper design ${issueStr}`);
        await designCommand(repo, issueStr, mode, agent, model);
        break;
      case DESIGNED_LABEL:
        logger.log(`Running: shipper plan ${issueStr}`);
        await planCommand(repo, issueStr, mode, agent, model);
        break;
      case PLANNED_LABEL:
        logger.log(`Running: shipper implement ${issueStr}`);
        await implementCommand(repo, issueStr, mode, agent, model);
        break;
      case IMPLEMENTED_LABEL:
        logger.log(`Running: shipper pr open ${issueStr}`);
        await prOpenCommand(repo, issueStr, mode, agent, model);
        break;
      case PR_OPEN_LABEL: {
        const prNum = await resolvePrForIssue(repo, issueNumber);
        logger.log(`Running: shipper pr review ${prNum}`);
        await prReviewCommand(repo, prNum, mode, agent, model);
        break;
      }
      case PR_REVIEWED_LABEL: {
        const prNum = await resolvePrForIssue(repo, issueNumber);
        logger.log(`Running: shipper pr remediate ${prNum}`);
        await prRemediateCommand(repo, prNum, mode, agent, model);
        break;
      }
      case READY_LABEL:
        logger.log(`Issue #${issueNumber} is ready — no remaining workflow steps.`);
        break;
      default:
        throw new Error(`Unrecognized shipper label "${label}" on issue #${issueNumber}.`);
    }
  });
}
