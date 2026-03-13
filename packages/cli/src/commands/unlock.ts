import { isLockStale, listIssues, releaseIssueLock } from '@dnsquared/shipper-core';

function printUsage(): void {
  console.error('Usage: shipper unlock <issue>');
  console.error('   or: shipper unlock --stale');
}

export async function unlockCommand(
  repo: string,
  issue: string | undefined,
  options: { stale?: boolean } = {}
): Promise<void> {
  if (options.stale && issue) {
    console.error('Error: --stale cannot be used with an issue number.');
    printUsage();
    process.exit(1);
  }

  if (options.stale) {
    const lockedIssues = await listIssues(repo, { label: 'shipper:locked' });

    if (lockedIssues.length === 0) {
      console.error('No stale locks found.');
      return;
    }

    let released = 0;
    let skipped = 0;

    for (const lockedIssue of lockedIssues) {
      const issueNumber = String(lockedIssue.number);
      const stale = await isLockStale(repo, issueNumber);

      if (stale) {
        await releaseIssueLock(repo, issueNumber);
        console.error(`#${issueNumber}: stale — released`);
        released += 1;
        continue;
      }

      console.error(`#${issueNumber}: active — skipped`);
      skipped += 1;
    }

    if (released === 0) {
      console.error('No stale locks found.');
      return;
    }

    console.error(`Released ${released} stale lock(s) (${skipped} active lock(s) skipped).`);
    return;
  }

  if (!issue) {
    console.error('Error: Please provide an issue number or use --stale.');
    printUsage();
    process.exit(1);
  }

  await releaseIssueLock(repo, issue.replace(/^#/, ''));
}
