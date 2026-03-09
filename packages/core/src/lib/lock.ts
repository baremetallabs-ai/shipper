import { execFile } from 'node:child_process';
import { gh } from './gh.js';
import { getSettings } from './settings.js';

export async function isLockStale(repo: string, issueNumber: string): Promise<boolean> {
  let output: string;
  try {
    const result = await gh([
      'api',
      '-R',
      repo,
      `repos/${repo}/issues/${issueNumber}/timeline`,
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

export async function acquireIssueLock(repo: string, issueNumber: string): Promise<void> {
  let output: string;
  try {
    const result = await gh([
      'issue',
      'view',
      issueNumber,
      '-R',
      repo,
      '--json',
      'labels',
      '--jq',
      '.labels[].name',
    ]);
    output = result.stdout.trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to fetch issue #${issueNumber}: ${msg}`);
  }

  const labels = output ? output.split(/\r?\n/) : [];

  if (labels.includes('shipper:locked')) {
    if (await isLockStale(repo, issueNumber)) {
      console.error(`Issue #${issueNumber} lock is stale — clearing.`);
      await releaseIssueLock(repo, issueNumber);
    } else {
      throw new Error(
        `Issue #${issueNumber} is locked by another shipper instance. Use 'shipper unlock ${issueNumber}' to force-release.`
      );
    }
  }

  try {
    await gh(['issue', 'edit', issueNumber, '-R', repo, '--add-label', 'shipper:locked']);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to acquire lock on issue #${issueNumber}: ${msg}`);
  }
}

export async function releaseIssueLock(repo: string, issueNumber: string): Promise<void> {
  try {
    await gh(['issue', 'edit', issueNumber, '-R', repo, '--remove-label', 'shipper:locked']);
  } catch {
    // Idempotent — ignore errors if label already removed
  }
}

function releaseIssueLockWithoutAwait(repo: string, issueNumber: string): void {
  execFile(
    'gh',
    ['issue', 'edit', issueNumber, '-R', repo, '--remove-label', 'shipper:locked'],
    () => {
      // Idempotent — ignore errors if label already removed
    }
  );
}

// Renew the lock by removing and re-adding the shipper:locked label.
// This creates a fresh "labeled" timeline event that isLockStale reads.
// Note: there is a brief sub-second window between remove and add where the label is absent.
// This is acceptable — the window is <1s vs a 10-minute heartbeat interval, and the lock
// system already has an inherent race in acquireIssueLock between checking and adding.
async function renewIssueLock(
  repo: string,
  issueNumber: string,
  cancelled: { value: boolean }
): Promise<void> {
  // Remove the existing label. If this fails, the label is still present — safe to bail.
  try {
    await gh(['issue', 'edit', issueNumber, '-R', repo, '--remove-label', 'shipper:locked']);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Warning: lock renewal failed for issue #${issueNumber}: ${msg}`);
    return;
  }

  // If cleanup started while the remove was in flight, do not re-add the label —
  // the lock is being released and re-adding would leave the issue permanently locked.
  if (cancelled.value) return;

  // Re-add the label to create a fresh timeline event.
  try {
    await gh(['issue', 'edit', issueNumber, '-R', repo, '--add-label', 'shipper:locked']);
    console.error(`Lock renewed for issue #${issueNumber}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `Warning: lock re-add failed for issue #${issueNumber} — lock is absent until next heartbeat: ${msg}`
    );
  }
}

export async function withIssueLock<T>(
  repo: string,
  issueNumber: string,
  fn: () => Promise<T>
): Promise<T> {
  if (process.env.SHIPPER_LOCK_HELD === issueNumber) {
    return await fn();
  }

  await acquireIssueLock(repo, issueNumber);
  process.env.SHIPPER_LOCK_HELD = issueNumber;

  const heartbeatMs = (getSettings().lockTimeoutMinutes / 3) * 60_000;
  const heartbeatCancelled = { value: false };
  const heartbeatTimer = setInterval(() => {
    void renewIssueLock(repo, issueNumber, heartbeatCancelled);
  }, heartbeatMs);
  heartbeatTimer.unref();

  const stopHeartbeat = () => {
    clearInterval(heartbeatTimer);
    heartbeatCancelled.value = true;
  };

  const cleanup = async () => {
    await releaseIssueLock(repo, issueNumber);
    delete process.env.SHIPPER_LOCK_HELD;
  };

  const cleanupWithoutAwait = () => {
    releaseIssueLockWithoutAwait(repo, issueNumber);
    delete process.env.SHIPPER_LOCK_HELD;
  };

  const onSignal = () => {
    stopHeartbeat();
    cleanupWithoutAwait();
  };

  // CLI-boundary exits and signal-driven shutdown still bypass finally blocks,
  // so keep a best-effort fallback that fires off the gh subprocess first.
  const onExit = () => {
    stopHeartbeat();
    cleanupWithoutAwait();
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('exit', onExit);

  try {
    return await fn();
  } finally {
    stopHeartbeat();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('exit', onExit);
    await cleanup();
  }
}
