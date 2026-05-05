import { isLockStale, listIssues, logger, releaseIssueLock } from '@baremetallabs-ai/shipper-core';

function printUsage(): void {
  logger.error('Usage: shipper unlock <issue>');
  logger.error('   or: shipper unlock --stale');
}

export async function unlockCommand(
  repo: string,
  issue: string | undefined,
  options: { stale?: boolean } = {}
): Promise<void> {
  if (options.stale && issue) {
    printUsage();
    throw new Error('Error: --stale cannot be used with an issue number.');
  }

  if (options.stale) {
    const lockedIssues = await listIssues(repo, { label: 'shipper:locked' });

    if (lockedIssues.length === 0) {
      logger.error('No stale locks found.');
      return;
    }

    let released = 0;
    let skipped = 0;

    for (const lockedIssue of lockedIssues) {
      const issueNumber = String(lockedIssue.number);
      const stale = await isLockStale(repo, issueNumber);

      if (stale) {
        await releaseIssueLock(repo, issueNumber);
        logger.error(`#${issueNumber}: stale — released`);
        released += 1;
        continue;
      }

      logger.error(`#${issueNumber}: active — skipped`);
      skipped += 1;
    }

    if (released === 0) {
      logger.error('No stale locks found.');
      return;
    }

    logger.error(`Released ${released} stale lock(s) (${skipped} active lock(s) skipped).`);
    return;
  }

  if (!issue) {
    printUsage();
    throw new Error('Error: Please provide an issue number or use --stale.');
  }

  await releaseIssueLock(repo, issue.replace(/^#/, ''));
}
