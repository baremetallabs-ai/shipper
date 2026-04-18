import {
  BLOCKED_LABEL,
  CONTROL_LABEL_NAMES,
  FAILED_LABEL,
  NEW_LABEL,
  PRIORITY_LABEL_NAMES,
  gh,
  logger,
  parseIssueNumberLabels,
  resolveRef,
  withIssueLock,
} from '@dnsquared/shipper-core';
import type { AgentName, CommandMode } from '@dnsquared/shipper-core';
import { runStageForLabel } from './stage-dispatch.js';

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
  const result = await withIssueLock(
    repo,
    issueStr,
    async () => await runStageForLabel(repo, issueStr, label, { mode, agent, model })
  );
  process.exitCode = result.exitCode;
}
