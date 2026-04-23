import { homedir } from 'node:os';
import {
  clearStaleLockIfNeeded,
  fetchIssueTimelines,
  gh,
  handleAgentCrash,
  logger,
  parseIssueTitleLabelsList,
  processResult,
  retryOnInvalidOutput,
  runPrompt,
  scrubOutputDir,
  selectIssuesForStage,
  sortIssuesByLabelTime,
  toErrorMessage,
  withIssueLock,
  STAGE_LABEL_NAMES,
  NEW_LABEL,
  BLOCKED_LABEL,
  LOCKED_LABEL,
} from '@dnsquared/shipper-core';
import type { AgentName } from '@dnsquared/shipper-core';
import { prepareUnblockContext } from './unblock.js';
import { formatLogDisplayPath } from './ship-execute.js';

export const AUTO_PRIORITY_LABELS: string[] = STAGE_LABEL_NAMES.filter(
  (label) => label !== NEW_LABEL
).reverse();

export interface UnblockAttempt {
  issue: number;
  title: string;
  outcome: 'unblocked' | 'still blocked';
  logFile?: string;
}

export async function selectNextCandidate(
  repo: string,
  skippedIssues: Set<number>,
  activeIssues: ReadonlySet<number> = new Set<number>()
): Promise<{ number: number; title: string } | null> {
  const stageData: Array<{
    label: string;
    stageIndex: number;
    staleLocked: Set<number>;
    candidates: Array<{ number: number; title: string; priority: 0 | 1 | 2 }>;
  }> = [];

  for (let stageIndex = 0; stageIndex < AUTO_PRIORITY_LABELS.length; stageIndex++) {
    const label = AUTO_PRIORITY_LABELS[stageIndex];
    if (!label) {
      continue;
    }
    const staleLocked = new Set<number>();
    const issues = await selectIssuesForStage(repo, label, staleLocked, { skipTimeline: true });
    const candidates = issues.filter(
      (issue) => !skippedIssues.has(issue.number) && !activeIssues.has(issue.number)
    );

    stageData.push({ label, stageIndex, staleLocked, candidates });
  }

  let winningStage:
    | {
        label: string;
        stageIndex: number;
        staleLocked: Set<number>;
        candidates: Array<{ number: number; title: string; priority: 0 | 1 | 2 }>;
      }
    | undefined;
  let winningPriority: 0 | 1 | 2 | undefined;

  for (const stage of stageData) {
    const stageCandidate = stage.candidates[0];
    if (!stageCandidate) {
      continue;
    }

    if (
      !winningStage ||
      winningPriority === undefined ||
      stageCandidate.priority < winningPriority ||
      (stageCandidate.priority === winningPriority && stage.stageIndex < winningStage.stageIndex)
    ) {
      winningStage = stage;
      winningPriority = stageCandidate.priority;
    }
  }

  if (!winningStage || winningPriority === undefined) {
    return null;
  }

  const bucketCandidates = winningStage.candidates.filter(
    (candidate) => candidate.priority === winningPriority
  );
  const bucketWinner = bucketCandidates[0];
  if (!bucketWinner) {
    return null;
  }

  let winner = bucketWinner;
  if (bucketCandidates.length >= 2) {
    const timelinesByIssue = await fetchIssueTimelines(
      repo,
      bucketCandidates.map((candidate) => candidate.number)
    );
    const sortedCandidates = sortIssuesByLabelTime(
      bucketCandidates,
      timelinesByIssue,
      winningStage.label
    );
    winner = sortedCandidates[0] ?? bucketWinner;
  }

  await clearStaleLockIfNeeded(repo, winner.number, winningStage.staleLocked);

  return { number: winner.number, title: winner.title };
}

export async function selectBlockedIssues(
  repo: string
): Promise<{ number: number; title: string }[]> {
  let output: string;
  try {
    const result = await gh([
      'issue',
      'list',
      '-R',
      repo,
      '--label',
      BLOCKED_LABEL,
      '--state',
      'open',
      '--search',
      `-label:${LOCKED_LABEL}`,
      '--json',
      'number,title,labels',
      '--limit',
      '1000',
    ]);
    output = result.stdout.trim();
  } catch {
    logger.warn('Failed to fetch blocked issues');
    return [];
  }

  if (!output) return [];

  let issues = parseIssueTitleLabelsList(output);

  issues = issues.filter((issue) => !issue.labels.some((label) => label.name === NEW_LABEL));

  // Sort by stage priority — issues with higher-priority stage labels come first
  issues.sort((a, b) => {
    const aLabels = new Set(a.labels.map((l) => l.name));
    const bLabels = new Set(b.labels.map((l) => l.name));
    let aIdx = AUTO_PRIORITY_LABELS.length;
    let bIdx = AUTO_PRIORITY_LABELS.length;
    for (let i = 0; i < AUTO_PRIORITY_LABELS.length; i++) {
      const label = AUTO_PRIORITY_LABELS[i];
      if (!label) continue;
      if (aLabels.has(label) && aIdx === AUTO_PRIORITY_LABELS.length) aIdx = i;
      if (bLabels.has(label) && bIdx === AUTO_PRIORITY_LABELS.length) bIdx = i;
    }
    return aIdx - bIdx;
  });

  return issues.map((i) => ({ number: i.number, title: i.title }));
}

export async function attemptUnblock(
  repo: string,
  issueStr: string,
  agent?: AgentName,
  model?: string,
  disableMcp?: boolean,
  logFile?: string
): Promise<boolean> {
  const cwd = process.cwd();

  return await withIssueLock(repo, issueStr, async () => {
    await scrubOutputDir(cwd);
    await prepareUnblockContext(repo, issueStr, cwd);
    const exitCode = await runPrompt('unblock', {
      repo,
      issueRef: issueStr,
      agent,
      model,
      disableMcp,
      logFile,
    });
    if (exitCode !== 0) {
      const detail = `Agent exited with code ${exitCode}`;
      logger.error(detail);
      await handleAgentCrash(
        repo,
        issueStr,
        'unblock',
        detail,
        `The \`unblock\` agent run exited with code ${exitCode}.`
      );
      return false;
    }
    try {
      const validatedResult = await retryOnInvalidOutput({
        cwd,
        stage: 'unblock',
        retry: (userInput) =>
          runPrompt('unblock', {
            repo,
            issueRef: issueStr,
            agent,
            model,
            disableMcp,
            logFile,
            userInput,
          }),
      });
      const result = await processResult({
        repo,
        issueNumber: issueStr,
        stage: 'unblock',
        cwd,
        result: validatedResult,
      });
      return result.verdict === 'accept';
    } catch (error) {
      const detail = toErrorMessage(error);
      logger.error(detail);
      await handleAgentCrash(repo, issueStr, 'unblock', detail);
      return false;
    }
  });
}

export function printUnblockSummary(attempts: UnblockAttempt[], homeDir = homedir()): void {
  logger.log('\n  Unblock attempts:\n');
  logger.log('  Ref              Issue                                          Outcome');
  const finalByIssue = new Map<number, UnblockAttempt>();
  for (const a of attempts) {
    // Preserve final-attempt order when an issue is retried later in the list.
    finalByIssue.delete(a.issue);
    finalByIssue.set(a.issue, a);
  }

  for (const a of finalByIssue.values()) {
    const ref = `unblock #${a.issue}`;
    const num = ref.padEnd(17);
    const titleChars = Array.from(a.title);
    const title =
      titleChars.length > 45 ? titleChars.slice(0, 42).join('') + '...' : a.title.padEnd(45);
    const outcome = a.outcome === 'unblocked' ? '✓ unblocked' : '— still blocked';
    logger.log(`  ${num}${title} ${outcome}`);
  }

  const withLogFiles = attempts.filter(
    (a): a is UnblockAttempt & { logFile: string } => !!a.logFile
  );
  if (withLogFiles.length > 0) {
    logger.log('\n  Unblock log files:');
    for (const a of withLogFiles) {
      logger.log(`  unblock #${a.issue}   ${formatLogDisplayPath(a.logFile, homeDir)}`);
    }
  }
}
