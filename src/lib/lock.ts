import { execFileSync } from 'node:child_process';
import { getRepoNwo } from './github.js';
import { getSettings } from './settings.js';

interface TimelineEvent {
  event: string;
  label: { name: string };
  created_at: string;
}

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
        '.[] | select(.event == "labeled") | {event, label, created_at}',
      ],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
  } catch {
    // If we can't fetch timeline, treat as stale (defensive)
    return true;
  }

  if (!output) return true;

  const events: TimelineEvent[] = output
    .split('\n')
    .map((line) => JSON.parse(line) as TimelineEvent);

  const lockEvents = events.filter(
    (e) => e.event === 'labeled' && e.label?.name === 'shipper:locked'
  );

  if (lockEvents.length === 0) return true;

  const lastEvent = lockEvents[lockEvents.length - 1]!;
  const labeledAt = new Date(lastEvent.created_at).getTime();
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

  execFileSync('gh', ['issue', 'edit', issueNumber, '--add-label', 'shipper:locked'], {
    stdio: 'ignore',
  });
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

  const onSignal = () => {
    releaseIssueLock(issueNumber);
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    return fn();
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    releaseIssueLock(issueNumber);
    delete process.env.SHIPPER_LOCK_HELD;
  }
}
