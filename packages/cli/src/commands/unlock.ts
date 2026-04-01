import { isLockStale, listIssues, logger, releaseIssueLock } from '@dnsquared/shipper-core';

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
    logger.error('Error: --stale cannot be used with an issue number.');
    printUsage();
    process.exit(1);
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
    logger.error('Error: Please provide an issue number or use --stale.');
    printUsage();
    process.exit(1);
  }

  await releaseIssueLock(repo, issue.replace(/^#/, ''));
}
