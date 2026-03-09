import { execFile } from 'node:child_process';
import { gh } from './gh.js';
import { getRepoNwo } from './repo.js';
import { getSettings } from './settings.js';

export async function isLockStale(issueNumber: string): Promise<boolean> {
  const nwo = await getRepoNwo();
  let output: string;
  try {
    const result = await gh([
      'api',
      `repos/${nwo}/issues/${issueNumber}/timeline`,
      '--paginate',
      '--jq',
      '.[] | select(.event == "labeled" and .label.name? == "shipper:locked") | .created_at',
    ]);
    output = result.stdout.trim();
  } catch {
    // If we can't fetch timeline, fail closed — treat as NOT stale to preserve the lock
    return false;
  }

  if (!output) return true;

  const timestamps = output.split('\n').filter((line) => line.trim());

  if (timestamps.length === 0) return true;

  const lastTimestamp = timestamps[timestamps.length - 1];
  if (!lastTimestamp) {
    return true;
  }
  const labeledAt = new Date(lastTimestamp).getTime();

  if (isNaN(labeledAt)) {
    // Malformed timestamp — fail closed
    return false;
  }

  const timeoutMs = getSettings().lockTimeoutMinutes * 60_000;

  return Date.now() - labeledAt > timeoutMs;
}

export async function acquireIssueLock(issueNumber: string): Promise<void> {
  let output: string;
  try {
    const result = await gh([
      'issue',
      'view',
      issueNumber,
      '--json',
      'labels',
      '--jq',
      '.labels[].name',
    ]);
    output = result.stdout.trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: Failed to fetch issue #${issueNumber}: ${msg}`);
    process.exit(1);
  }

  const labels = output ? output.split(/\r?\n/) : [];

  if (labels.includes('shipper:locked')) {
    if (await isLockStale(issueNumber)) {
      console.error(`Issue #${issueNumber} lock is stale — clearing.`);
      await releaseIssueLock(issueNumber);
    } else {
      console.error(
        `Issue #${issueNumber} is locked by another shipper instance. Use 'shipper unlock ${issueNumber}' to force-release.`
      );
      process.exit(1);
    }
  }

  try {
    await gh(['issue', 'edit', issueNumber, '--add-label', 'shipper:locked']);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: Failed to acquire lock on issue #${issueNumber}: ${msg}`);
    process.exit(1);
  }
}

export async function releaseIssueLock(issueNumber: string): Promise<void> {
  try {
    await gh(['issue', 'edit', issueNumber, '--remove-label', 'shipper:locked']);
  } catch {
    // Idempotent — ignore errors if label already removed
  }
}

function releaseIssueLockWithoutAwait(issueNumber: string): void {
  execFile('gh', ['issue', 'edit', issueNumber, '--remove-label', 'shipper:locked'], () => {
    // Idempotent — ignore errors if label already removed
  });
}

export async function withIssueLock<T>(issueNumber: string, fn: () => Promise<T>): Promise<T> {
  if (process.env.SHIPPER_LOCK_HELD === issueNumber) {
    return await fn();
  }

  await acquireIssueLock(issueNumber);
  process.env.SHIPPER_LOCK_HELD = issueNumber;

  const cleanup = async () => {
    await releaseIssueLock(issueNumber);
    delete process.env.SHIPPER_LOCK_HELD;
  };

  const cleanupWithoutAwait = () => {
    releaseIssueLockWithoutAwait(issueNumber);
    delete process.env.SHIPPER_LOCK_HELD;
  };

  const onSignal = () => {
    cleanupWithoutAwait();
  };

  // process.exit() bypasses finally blocks, so keep a best-effort fallback
  // that fires off the gh subprocess before Node finishes exiting.
  const onExit = () => {
    cleanupWithoutAwait();
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('exit', onExit);

  try {
    return await fn();
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('exit', onExit);
    await cleanup();
  }
}
