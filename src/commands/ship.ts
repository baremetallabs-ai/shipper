import { execFileSync, spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { clearStaleLockIfNeeded, selectIssuesForStage } from '../lib/github.js';
import { getRepoNwo } from '../lib/repo.js';
import { withStageHooks } from '../lib/hooks.js';
import { releaseIssueLock, withIssueLock } from '../lib/lock.js';
import { runPrompt } from '../lib/prompt-runner.js';
import { postMerge } from './merge.js';
import type { QueuedPR } from './merge.js';

const MAX_REVIEW_CYCLES = 3;

export const STAGE_NAME: Record<string, string> = {
  'shipper:new': 'groom',
  'shipper:groomed': 'design',
  'shipper:designed': 'plan',
  'shipper:planned': 'implement',
  'shipper:implemented': 'pr open',
  'shipper:pr-open': 'pr review',
  'shipper:pr-reviewed': 'pr remediate',
};

export const AUTO_PRIORITY_LABELS: string[] = [
  'shipper:ready',
  'shipper:pr-reviewed',
  'shipper:pr-open',
  'shipper:implemented',
  'shipper:planned',
  'shipper:designed',
  'shipper:groomed',
];

interface StageResult {
  stage: string;
  status: 'pass' | 'fail';
}

export interface AutoResult {
  issue: number;
  title: string;
  outcome: 'pass' | 'fail';
  error?: string;
}

export interface UnblockAttempt {
  issue: number;
  title: string;
  outcome: 'unblocked' | 'still blocked';
}

export interface ShipOptions {
  merge: boolean;
  auto: boolean;
  parallel?: number;
}

interface AsyncIssueRun {
  child: ChildProcess;
  result: Promise<{ success: boolean; error?: string }>;
}

interface ActiveIssueRun {
  issue: { number: number; title: string };
  child: ChildProcess;
  completion: Promise<{
    issue: { number: number; title: string };
    result: { success: boolean; error?: string };
  }>;
}

type ShipSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL';

function getCurrentLabel(issueStr: string): string | undefined {
  let output: string;
  try {
    output = execFileSync(
      'gh',
      ['issue', 'view', issueStr, '--json', 'labels', '--jq', '.labels[].name'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
  } catch {
    return undefined;
  }

  if (!output) return undefined;

  const shipperLabels = output
    .split(/\r?\n/)
    .filter(
      (name) =>
        name.startsWith('shipper:') && name !== 'shipper:blocked' && name !== 'shipper:locked'
    );

  if (shipperLabels.length !== 1) return undefined;

  return shipperLabels[0];
}

function printSummary(results: StageResult[]): void {
  console.log('\nStage summary:');
  for (const r of results) {
    const icon = r.status === 'pass' ? '✓' : '✗';
    const suffix = r.status === 'fail' ? ' — failed' : '';
    console.log(`  ${icon} ${r.stage}${suffix}`);
  }
}

export function printAutoSummary(results: AutoResult[]): void {
  if (results.length === 0) {
    console.log('\nAuto run complete. No eligible issues found.');
    return;
  }
  console.log('\nAuto run complete.\n');
  console.log('  #    Issue                                          Outcome');
  for (const r of results) {
    const num = String(r.issue).padEnd(5);
    const titleChars = Array.from(r.title);
    const title =
      titleChars.length > 45 ? titleChars.slice(0, 42).join('') + '...' : r.title.padEnd(45);
    const outcome = r.outcome === 'pass' ? '✓ pass' : `✗ fail — ${r.error ?? 'unknown error'}`;
    console.log(`  ${num}${title} ${outcome}`);
  }
}

function resolvePrForIssue(issueNumber: number, nwo: string): QueuedPR {
  let output: string;
  try {
    output = execFileSync(
      'gh',
      [
        'pr',
        'list',
        '-R',
        nwo,
        '--state',
        'open',
        '--json',
        'number,title,headRefName,baseRefName',
      ],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch {
    throw new Error(`Failed to look up PRs for issue #${issueNumber}.`);
  }

  let allPrs: QueuedPR[];
  try {
    allPrs = JSON.parse(output) as QueuedPR[];
  } catch {
    throw new Error(
      `Failed to parse GitHub CLI output while looking up PR for issue #${issueNumber}.`
    );
  }

  const prs = (allPrs ?? []).filter(
    (pr) =>
      pr.headRefName === `shipper/${issueNumber}` ||
      pr.headRefName.startsWith(`shipper/${issueNumber}-`)
  );

  if (prs.length === 0) {
    throw new Error(`No open PR found for issue #${issueNumber}.`);
  }

  if (prs.length > 1) {
    const prNumbers = prs.map((pr) => `#${pr.number}`).join(', ');
    throw new Error(
      `Multiple open PRs found for issue #${issueNumber}: ${prNumbers}. Please ensure only one is open.`
    );
  }

  return { ...prs[0]!, labeledAt: '' };
}

function mergePr(pr: QueuedPR, issueNumber: number, nwo: string): boolean {
  try {
    execFileSync(
      'gh',
      ['pr', 'merge', String(pr.number), '-R', nwo, '--rebase', '--delete-branch'],
      { stdio: 'inherit' }
    );
    console.log(`PR #${pr.number} merged successfully.`);
    postMerge(pr, issueNumber, nwo, false);
    return true;
  } catch (err) {
    console.error(`\nMerge failed for PR #${pr.number}. See command output above for details.`);

    try {
      execFileSync(
        'gh',
        ['pr', 'edit', String(pr.number), '-R', nwo, '--remove-label', 'shipper:ready'],
        { stdio: 'ignore' }
      );
    } catch {
      console.error(`Warning: Failed to remove shipper:ready label from PR #${pr.number}`);
    }

    try {
      execFileSync(
        'gh',
        ['pr', 'edit', String(pr.number), '-R', nwo, '--add-label', 'shipper:pr-reviewed'],
        { stdio: 'ignore' }
      );
    } catch {
      console.error(`Warning: Failed to add shipper:pr-reviewed label to PR #${pr.number}`);
    }

    try {
      execFileSync(
        'gh',
        ['issue', 'edit', String(issueNumber), '-R', nwo, '--remove-label', 'shipper:ready'],
        { stdio: 'ignore' }
      );
    } catch {
      console.error(`Warning: Failed to remove shipper:ready label from issue #${issueNumber}`);
    }

    try {
      execFileSync(
        'gh',
        ['issue', 'edit', String(issueNumber), '-R', nwo, '--add-label', 'shipper:pr-reviewed'],
        { stdio: 'ignore' }
      );
    } catch {
      console.error(`Warning: Failed to add shipper:pr-reviewed label to issue #${issueNumber}`);
    }

    const reason = err instanceof Error ? err.message : String(err);
    const comment = [
      `Merge failed for PR #${pr.number}.`,
      '',
      `**Reason:** ${reason}`,
      '',
      'The `shipper:pr-reviewed` label has been re-applied so the PR can be remediated and re-queued.',
    ].join('\n');

    try {
      execFileSync('gh', ['pr', 'comment', String(pr.number), '-R', nwo, '--body', comment], {
        stdio: 'ignore',
      });
    } catch {
      console.error(`Warning: Failed to post failure comment on PR #${pr.number}`);
    }

    return false;
  }
}

function shipOneIssue(issue: string, merge: boolean): { success: boolean; error?: string } {
  const issueStr = issue.replace(/^#/, '');

  return withIssueLock(issueStr, () => {
    let label = getCurrentLabel(issueStr);

    if (!label) {
      const msg = `Issue #${issueStr} has no shipper label. Run \`shipper next\` or add a label first.`;
      console.error(msg);
      return { success: false, error: msg };
    }

    if (label === 'shipper:ready') {
      if (!merge) {
        console.log(`Issue #${issueStr} is already at shipper:ready.`);
        return { success: true };
      }
      // Fall through to merge logic below the loop
    }

    if (label !== 'shipper:ready' && !(label in STAGE_NAME)) {
      const msg = `Unrecognized shipper label "${label}" on issue #${issueStr}.`;
      console.error(msg);
      return { success: false, error: msg };
    }

    const results: StageResult[] = [];

    if (label !== 'shipper:ready') {
      let reviewCycles = 0;
      let seenPrReviewed = false;

      for (;;) {
        const stageName = STAGE_NAME[label]!;
        const previousLabel: string | undefined = label;

        console.log(`Running stage: ${stageName}`);

        const result = spawnSync(process.execPath, [process.argv[1]!, 'next', issueStr], {
          stdio: 'inherit',
          env: process.env,
        });

        if (result.status !== 0) {
          results.push({ stage: stageName, status: 'fail' });
          printSummary(results);
          return { success: false, error: `stage "${stageName}" failed` };
        }

        results.push({ stage: stageName, status: 'pass' });

        label = getCurrentLabel(issueStr);

        if (label === 'shipper:ready') {
          break;
        }

        if (!label || !(label in STAGE_NAME)) {
          if (!label) {
            console.error(`Issue #${issueStr} has no shipper label after stage "${stageName}".`);
          } else {
            console.error(
              `Unrecognized shipper label "${label}" on issue #${issueStr} after stage "${stageName}".`
            );
          }
          printSummary(results);
          return { success: false, error: `unexpected label after stage "${stageName}"` };
        }

        if (label === previousLabel) {
          const msg = `Label did not advance after stage "${stageName}" (still "${label}"). Aborting to avoid infinite loop.`;
          console.error(msg);
          printSummary(results);
          return { success: false, error: msg };
        }

        if (label === 'shipper:pr-reviewed') {
          if (seenPrReviewed) {
            reviewCycles++;
            if (reviewCycles >= MAX_REVIEW_CYCLES) {
              const msg = `Review loop cap reached after ${MAX_REVIEW_CYCLES} cycles. Issue is at shipper:pr-reviewed. Continue manually.`;
              console.error(msg);
              results.push({ stage: 'pr remediate', status: 'fail' });
              printSummary(results);
              return { success: false, error: msg };
            }
          }
          seenPrReviewed = true;
        }
      }
    }

    if (merge) {
      console.log('Running stage: merge');
      const issueNumber = Number(issueStr);
      const nwo = getRepoNwo();

      let pr: QueuedPR;
      try {
        pr = resolvePrForIssue(issueNumber, nwo);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(msg);
        results.push({ stage: 'merge', status: 'fail' });
        printSummary(results);
        return { success: false, error: msg };
      }

      const merged = withStageHooks(
        'merge',
        { issueNumber: issueStr, branchName: pr.headRefName },
        () => mergePr(pr, issueNumber, nwo)
      );

      if (merged) {
        results.push({ stage: 'merge', status: 'pass' });
      } else {
        results.push({ stage: 'merge', status: 'fail' });
        printSummary(results);
        return { success: false, error: 'merge failed' };
      }
    }

    printSummary(results);
    return { success: true };
  });
}

function shipOneIssueAsync(issue: string): AsyncIssueRun {
  const stderr: string[] = [];
  const child = spawn(process.execPath, [process.argv[1]!, 'ship', issue, '--merge'], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: process.env,
  });

  if (child.stderr) {
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr.push(chunk.toString());
    });
  }

  const result = new Promise<{ success: boolean; error?: string }>((resolve) => {
    child.on('error', (error) => {
      resolve({ success: false, error: error.message });
    });

    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve({ success: true });
        return;
      }

      const stderrOutput = stderr.join('').trim();
      if (stderrOutput) {
        resolve({ success: false, error: stderrOutput });
        return;
      }

      if (signal) {
        resolve({ success: false, error: `child exited from signal ${signal}` });
        return;
      }

      resolve({ success: false, error: `child exited with code ${code ?? 'unknown'}` });
    });
  });

  return { child, result };
}

export function selectNextCandidate(
  skippedIssues: Set<number>,
  activeIssues: ReadonlySet<number> = new Set<number>()
): { number: number; title: string } | null {
  for (const label of AUTO_PRIORITY_LABELS) {
    const staleLocked = new Set<number>();
    const issues = selectIssuesForStage(label, staleLocked);
    const candidate = issues.find(
      (i) => !skippedIssues.has(i.number) && !activeIssues.has(i.number)
    );
    if (candidate) {
      clearStaleLockIfNeeded(candidate.number, staleLocked);
      return candidate;
    }
  }
  return null;
}

export function selectBlockedIssues(): { number: number; title: string }[] {
  let output: string;
  try {
    output = execFileSync(
      'gh',
      [
        'issue',
        'list',
        '--label',
        'shipper:blocked',
        '--state',
        'open',
        '--search',
        '-label:shipper:locked',
        '--json',
        'number,title,labels',
        '--limit',
        '1000',
      ],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
  } catch {
    return [];
  }

  if (!output) return [];

  let issues: { number: number; title: string; labels: { name: string }[] }[];
  try {
    issues = JSON.parse(output) as { number: number; title: string; labels: { name: string }[] }[];
  } catch {
    return [];
  }

  // Sort by stage priority — issues with higher-priority stage labels come first
  issues.sort((a, b) => {
    const aLabels = new Set(a.labels.map((l) => l.name));
    const bLabels = new Set(b.labels.map((l) => l.name));
    let aIdx = AUTO_PRIORITY_LABELS.length;
    let bIdx = AUTO_PRIORITY_LABELS.length;
    for (let i = 0; i < AUTO_PRIORITY_LABELS.length; i++) {
      if (aLabels.has(AUTO_PRIORITY_LABELS[i]!) && aIdx === AUTO_PRIORITY_LABELS.length) aIdx = i;
      if (bLabels.has(AUTO_PRIORITY_LABELS[i]!) && bIdx === AUTO_PRIORITY_LABELS.length) bIdx = i;
    }
    return aIdx - bIdx;
  });

  return issues.map((i) => ({ number: i.number, title: i.title }));
}

function attemptUnblock(issueStr: string): boolean {
  withIssueLock(issueStr, () => runPrompt('unblock', { issueRef: issueStr }));

  // Check whether shipper:blocked was removed — this is the only reliable signal
  let output: string;
  try {
    output = execFileSync(
      'gh',
      ['issue', 'view', issueStr, '--json', 'labels', '--jq', '.labels[].name'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
  } catch {
    return false;
  }

  const labels = output.split(/\r?\n/).filter(Boolean);
  return !labels.includes('shipper:blocked');
}

export function printUnblockSummary(attempts: UnblockAttempt[]): void {
  console.log('\n  Unblock attempts:\n');
  console.log('  #    Issue                                          Outcome');
  for (const a of attempts) {
    const num = String(a.issue).padEnd(5);
    const titleChars = Array.from(a.title);
    const title =
      titleChars.length > 45 ? titleChars.slice(0, 42).join('') + '...' : a.title.padEnd(45);
    const outcome = a.outcome === 'unblocked' ? '✓ unblocked' : '— still blocked';
    console.log(`  ${num}${title} ${outcome}`);
  }
}

function shipAutoSequential(): void {
  const skippedIssues = new Set<number>();
  const results: AutoResult[] = [];
  const allUnblockAttempts: UnblockAttempt[] = [];

  for (;;) {
    // Inner loop: process all available candidates
    for (;;) {
      const candidate = selectNextCandidate(skippedIssues);
      if (!candidate) break;

      console.log(`\nAuto: advancing issue #${candidate.number} — ${candidate.title}`);
      const result = shipOneIssue(String(candidate.number), true);

      if (result.success) {
        results.push({ issue: candidate.number, title: candidate.title, outcome: 'pass' });
      } else {
        skippedIssues.add(candidate.number);
        results.push({
          issue: candidate.number,
          title: candidate.title,
          outcome: 'fail',
          error: result.error,
        });
      }
    }

    // Unblock pass
    const blocked = selectBlockedIssues();
    if (blocked.length === 0) break;

    let progress = false;
    for (const issue of blocked) {
      console.log(`\nAuto: attempting unblock of #${issue.number} — ${issue.title}`);
      const unblocked = attemptUnblock(String(issue.number));
      allUnblockAttempts.push({
        issue: issue.number,
        title: issue.title,
        outcome: unblocked ? 'unblocked' : 'still blocked',
      });
      if (unblocked) progress = true;
    }

    if (!progress) break;
    // Loop back — newly unblocked issues are now eligible candidates
  }

  printAutoSummary(results);
  if (allUnblockAttempts.length > 0) {
    printUnblockSummary(allUnblockAttempts);
  }
  process.exit(0);
}

async function shipAutoParallel(parallel: number): Promise<void> {
  const skippedIssues = new Set<number>();
  const results: AutoResult[] = [];
  const allUnblockAttempts: UnblockAttempt[] = [];
  const activeRuns = new Map<number, ActiveIssueRun>();

  let shuttingDown = false;

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });

  const onSignal = (signal: ShipSignal) => {
    if (shuttingDown) return;
    shuttingDown = true;

    void (async () => {
      for (const run of activeRuns.values()) {
        run.child.kill(signal);
      }

      await wait(3000);

      for (const [issueNumber, run] of activeRuns) {
        if (run.child.exitCode === null && run.child.signalCode === null) {
          run.child.kill('SIGKILL');
        }
        releaseIssueLock(String(issueNumber));
      }

      process.exit(1);
    })();
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    for (;;) {
      if (shuttingDown) break;

      while (!shuttingDown && activeRuns.size < parallel) {
        const candidate = selectNextCandidate(skippedIssues, new Set(activeRuns.keys()));
        if (!candidate) break;

        console.log(`\nAuto: advancing issue #${candidate.number} — ${candidate.title}`);
        const run = shipOneIssueAsync(String(candidate.number));
        activeRuns.set(candidate.number, {
          issue: candidate,
          child: run.child,
          completion: run.result.then((result) => ({ issue: candidate, result })),
        });
      }

      if (shuttingDown) break;

      if (activeRuns.size === 0) {
        const blocked = selectBlockedIssues();
        if (blocked.length === 0) break;

        let progress = false;
        for (const issue of blocked) {
          console.log(`\nAuto: attempting unblock of #${issue.number} — ${issue.title}`);
          const unblocked = attemptUnblock(String(issue.number));
          allUnblockAttempts.push({
            issue: issue.number,
            title: issue.title,
            outcome: unblocked ? 'unblocked' : 'still blocked',
          });
          if (unblocked) progress = true;
        }

        if (!progress) break;
        continue;
      }

      const completed = await Promise.race(
        Array.from(activeRuns.values(), (run) => run.completion)
      );
      activeRuns.delete(completed.issue.number);

      if (completed.result.success) {
        results.push({
          issue: completed.issue.number,
          title: completed.issue.title,
          outcome: 'pass',
        });
      } else {
        skippedIssues.add(completed.issue.number);
        results.push({
          issue: completed.issue.number,
          title: completed.issue.title,
          outcome: 'fail',
          error: completed.result.error,
        });
      }
    }
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }

  printAutoSummary(results);
  if (allUnblockAttempts.length > 0) {
    printUnblockSummary(allUnblockAttempts);
  }
  process.exit(0);
}

export async function shipCommand(
  issue: string | undefined,
  options: ShipOptions = { merge: false, auto: false }
): Promise<void> {
  if (options.auto) {
    if (options.parallel) {
      await shipAutoParallel(options.parallel);
      return;
    }

    shipAutoSequential();
    return;
  }

  // Non-auto path: issue is required (validated in index.ts)
  const result = shipOneIssue(issue!, options.merge);
  process.exit(result.success ? 0 : 1);
}
