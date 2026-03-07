import { execFileSync } from 'node:child_process';
import { getRepoNwo } from './repo.js';
import { getSettings } from './settings.js';

export function isLockStale(issueNumber: string): boolean {
  const nwo = getRepoNwo();
  let output: string;
  try {
    output = execFileSync(
      'gh',
      [
        'api',
        `repos/${nwo}/issues/${issueNumber}/timeline`,
        '--paginate',
        '--jq',
        '.[] | select(.event == "labeled" and .label.name? == "shipper:locked") | .created_at',
      ],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
  } catch {
    // If we can't fetch timeline, fail closed — treat as NOT stale to preserve the lock
    return false;
  }

  if (!output) return true;

  const timestamps = output.split('\n').filter((line) => line.trim());

  if (timestamps.length === 0) return true;

  const lastTimestamp = timestamps[timestamps.length - 1]!;
  const labeledAt = new Date(lastTimestamp).getTime();

  if (isNaN(labeledAt)) {
    // Malformed timestamp — fail closed
    return false;
  }

  const timeoutMs = getSettings().lockTimeoutMinutes * 60_000;

  return Date.now() - labeledAt > timeoutMs;
}

export function acquireIssueLock(issueNumber: string): void {
  let output: string;
  try {
    output = execFileSync(
      'gh',
      ['issue', 'view', issueNumber, '--json', 'labels', '--jq', '.labels[].name'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: Failed to fetch issue #${issueNumber}: ${msg}`);
    process.exit(1);
  }

  const labels = output ? output.split(/\r?\n/) : [];

  if (labels.includes('shipper:locked')) {
    if (isLockStale(issueNumber)) {
      console.error(`Issue #${issueNumber} lock is stale — clearing.`);
      releaseIssueLock(issueNumber);
    } else {
      console.error(
        `Issue #${issueNumber} is locked by another shipper instance. Use 'shipper unlock ${issueNumber}' to force-release.`
      );
      process.exit(1);
    }
  }

  try {
    execFileSync('gh', ['issue', 'edit', issueNumber, '--add-label', 'shipper:locked'], {
      stdio: 'ignore',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: Failed to acquire lock on issue #${issueNumber}: ${msg}`);
    process.exit(1);
  }
}

export function releaseIssueLock(issueNumber: string): void {
  try {
    execFileSync('gh', ['issue', 'edit', issueNumber, '--remove-label', 'shipper:locked'], {
      stdio: 'ignore',
    });
  } catch {
    // Idempotent — ignore errors if label already removed
  }
}

export function withIssueLock<T>(issueNumber: string, fn: () => T): T {
  if (process.env.SHIPPER_LOCK_HELD === issueNumber) {
    return fn();
  }

  acquireIssueLock(issueNumber);
  process.env.SHIPPER_LOCK_HELD = issueNumber;

  const cleanup = () => {
    releaseIssueLock(issueNumber);
    delete process.env.SHIPPER_LOCK_HELD;
  };

  const onSignal = () => {
    cleanup();
  };

  // process.exit() bypasses finally blocks, so register an exit handler
  // to ensure the lock is always released (e.g. when inner code calls process.exit).
  const onExit = () => {
    cleanup();
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('exit', onExit);

  try {
    return fn();
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('exit', onExit);
    cleanup();
  }
}
