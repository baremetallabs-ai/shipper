import {
  BLOCKED_LABEL,
  FAILED_LABEL,
  LOCKED_LABEL,
  PRIORITY_LABEL_NAMES,
  gh,
  logger,
} from '@dnsquared/shipper-core';

export async function getCurrentWorkflowLabel(
  repo: string,
  issueStr: string
): Promise<string | undefined> {
  let output: string;
  try {
    const result = await gh([
      'issue',
      'view',
      issueStr,
      '-R',
      repo,
      '--json',
      'labels',
      '--jq',
      '.labels[].name',
    ]);
    output = result.stdout.trim();
  } catch {
    logger.warn(`Failed to fetch labels for issue #${issueStr}`);
    return undefined;
  }

  if (!output) return undefined;

  const shipperLabels = output
    .split(/\r?\n/)
    .filter(
      (name) =>
        name.startsWith('shipper:') &&
        name !== BLOCKED_LABEL &&
        name !== LOCKED_LABEL &&
        !PRIORITY_LABEL_NAMES.includes(name)
    );

  if (shipperLabels.includes(FAILED_LABEL)) {
    return FAILED_LABEL;
  }

  const stageLabels = shipperLabels.filter((name) => name !== FAILED_LABEL);

  if (stageLabels.length !== 1) return undefined;

  return stageLabels[0];
}
