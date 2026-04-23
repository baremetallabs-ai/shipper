import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { toErrorMessage } from './errors.js';
import { getRepoRoot } from './branch.js';
import { classifyChecks, enrichFailedChecks, fetchChecks, type PRChecksLine } from './checks.js';
import { gh } from './gh.js';
import { resolveBaseBranch } from './github.js';
import { logger } from './logger.js';
import { runPrompt } from './prompt-runner.js';
import { getRepoNwo } from './repo.js';
import { getSettings, type AgentName, type CommandMode } from './settings.js';
import { sleepMs } from './sleep.js';
import { execAsync, formatCommandFailure } from './worktree/helpers.js';

const STATUS_ARGS = ['status', '--porcelain=v1', '-z', '--untracked-files=all'] as const;
const BRANCH_NAME = 'chore/shipper-setup';
const INITIAL_COMMIT_SUBJECT = 'chore: shipper setup';
const REMEDIATION_COMMIT_SUBJECT = 'fix: address setup PR feedback';
const ZERO_CHECKS_GRACE_MS = 30_000;
const POLL_INTERVAL_MS = 20_000;
const CI_WAIT_TIMEOUT_MS = 30 * 60_000;
const MAX_CONSECUTIVE_FETCH_FAILURES = 3;

export interface GitStatusEntry {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  originalPath?: string;
}

export interface GitStatusSnapshot {
  repoRoot: string;
  entries: GitStatusEntry[];
  byPath: Map<string, GitStatusEntry>;
  contentSignatureByPath: Map<string, string>;
}

export interface SetupFinalizeOptions {
  before: GitStatusSnapshot;
  mode: CommandMode;
  agent?: AgentName;
  model?: string;
  disableMcp?: boolean;
  confirm: (message: string) => Promise<boolean>;
}

export interface SetupFinalizeResult {
  status:
    | 'no-changes'
    | 'headless'
    | 'declined'
    | 'completed'
    | 'blocked-existing-branch'
    | 'blocked-base-branch'
    | 'failed';
  prUrl?: string;
  error?: string;
}

interface CheckPollingResult {
  status: 'passed' | 'failed' | 'no-checks' | 'timed-out' | 'fetch-failed';
  failedChecks?: PRChecksLine[];
}

function buildEntryMap(entries: GitStatusEntry[]): Map<string, GitStatusEntry> {
  return new Map(entries.map((entry) => [entry.path, entry]));
}

function entrySignature(entry: GitStatusEntry): string {
  return `${entry.indexStatus}${entry.worktreeStatus}:${entry.originalPath ?? ''}`;
}

function hashContent(content: Buffer): string {
  return createHash('sha1').update(content).digest('hex');
}

function parseStatusSnapshot(raw: string): GitStatusEntry[] {
  const fields = raw.split('\0');
  const entries: GitStatusEntry[] = [];

  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (!record) {
      continue;
    }

    const status = record.slice(0, 2);
    const path = record.slice(3);
    const entry: GitStatusEntry = {
      path,
      indexStatus: status[0] ?? ' ',
      worktreeStatus: status[1] ?? ' ',
    };

    if (entry.indexStatus === 'R' || entry.indexStatus === 'C') {
      const originalPath = fields[index + 1];
      if (originalPath) {
        entry.originalPath = originalPath;
        index += 1;
      }
    }

    entries.push(entry);
  }

  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function runGit(
  repoRoot: string,
  args: string[],
  failurePrefix: string
): Promise<{ stdout: string; stderr: string; code: number }> {
  const result = await execAsync('git', args, { cwd: repoRoot });
  if (result.code !== 0) {
    throw new Error(
      `${failurePrefix}: ${formatCommandFailure('git', args, result).replace(/\n+/g, '\n')}`
    );
  }

  return result;
}

async function branchExistsLocally(repoRoot: string, branchName: string): Promise<boolean> {
  const result = await execAsync('git', ['rev-parse', '--verify', branchName], { cwd: repoRoot });
  return result.code === 0;
}

async function branchExistsRemotely(repoRoot: string, branchName: string): Promise<boolean> {
  const result = await execAsync(
    'git',
    ['ls-remote', '--exit-code', '--heads', 'origin', branchName],
    { cwd: repoRoot }
  );
  return result.code === 0;
}

function getComparisonSignature(snapshot: GitStatusSnapshot, entry: GitStatusEntry): string {
  return JSON.stringify({
    status: entrySignature(entry),
    content: snapshot.contentSignatureByPath.get(entry.path) ?? null,
  });
}

function getDeltaEntries(before: GitStatusSnapshot, after: GitStatusSnapshot): GitStatusEntry[] {
  return after.entries.filter((entry) => {
    const previous = before.byPath.get(entry.path);
    return (
      previous === undefined ||
      getComparisonSignature(before, previous) !== getComparisonSignature(after, entry)
    );
  });
}

function formatPathList(paths: string[]): string[] {
  return paths.map((filePath) => `  - ${filePath}`);
}

function logChangedFileSummary(
  changedDuringSetup: string[],
  preExistingDirty: string[],
  totalPaths: string[]
): void {
  logger.log('Setup left file changes in the working tree.');
  logger.log('Changes introduced or updated during setup:');
  for (const line of formatPathList(changedDuringSetup)) {
    logger.log(line);
  }

  if (preExistingDirty.length > 0) {
    logger.log('These files were already dirty before setup and will also be committed:');
    for (const line of formatPathList(preExistingDirty)) {
      logger.log(line);
    }
  }

  logger.log('Accepting the finalize offer commits the full current working tree.');
  logger.log(`Total paths that would be committed: ${totalPaths.length}`);
}

function buildCommitBody(paths: string[], heading: string): string {
  return [heading, ...paths.map((filePath) => `- ${filePath}`)].join('\n');
}

function buildPrBody(paths: string[]): string {
  return [
    '## Summary',
    '',
    'Capture the repository changes made during `shipper setup`.',
    '',
    '## Files',
    '',
    ...paths.map((filePath) => `- ${filePath}`),
  ].join('\n');
}

function buildFailureContext(failedChecks: PRChecksLine[]): string {
  const lines = [
    'The setup PR has failing checks. Make the smallest scoped fix you can, then stop.',
    '',
    'Failing checks:',
  ];

  for (const check of failedChecks) {
    lines.push(`- ${check.name}`);
    if (check.failedSteps && check.failedSteps.length > 0) {
      for (const step of check.failedSteps) {
        lines.push(`  - failed step: ${step.name}`);
      }
    }
    if (check.link) {
      lines.push(`  - link: ${check.link}`);
    }
  }

  return lines.join('\n');
}

function reportFailedChecks(failedChecks: PRChecksLine[]): void {
  logger.error('Setup PR checks failed.');
  for (const check of failedChecks) {
    logger.error(`- ${check.name}`);
    if (check.failedSteps && check.failedSteps.length > 0) {
      for (const step of check.failedSteps) {
        logger.error(`  failed step: ${step.name}`);
      }
    }
    if (check.link) {
      logger.error(`  details: ${check.link}`);
    }
  }
}

async function pollChecks(repo: string, prRef: string): Promise<CheckPollingResult> {
  const deadline = Date.now() + CI_WAIT_TIMEOUT_MS;
  let previousCompleted = -1;
  let consecutiveFailures = 0;
  let zeroChecksSince: number | undefined;

  for (;;) {
    if (Date.now() >= deadline) {
      logger.warn('Setup PR check polling timed out. Review the PR checks manually.');
      return { status: 'timed-out' };
    }

    let checks: PRChecksLine[];
    try {
      checks = await fetchChecks(repo, prRef);
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      logger.warn(`Warning: Failed to fetch setup PR checks: ${toErrorMessage(error)}`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FETCH_FAILURES) {
        logger.warn('Stopping setup PR check polling after repeated fetch failures.');
        return { status: 'fetch-failed' };
      }

      await sleepMs(POLL_INTERVAL_MS);
      continue;
    }

    if (checks.length === 0) {
      zeroChecksSince ??= Date.now();
      if (Date.now() - zeroChecksSince >= ZERO_CHECKS_GRACE_MS) {
        logger.log('No PR checks were reported after the setup grace period.');
        return { status: 'no-checks' };
      }

      logger.log('Waiting for PR checks to appear...');
      await sleepMs(Math.min(POLL_INTERVAL_MS, ZERO_CHECKS_GRACE_MS));
      continue;
    }

    zeroChecksSince = undefined;
    const classified = classifyChecks(checks);
    const completed = classified.total - classified.pending.length;

    if (classified.pending.length === 0) {
      if (classified.failed.length > 0) {
        await enrichFailedChecks(repo, classified.failed);
        return { status: 'failed', failedChecks: classified.failed };
      }

      logger.log(`All setup PR checks passed. (${completed}/${classified.total})`);
      return { status: 'passed' };
    }

    if (completed !== previousCompleted) {
      logger.log(`Waiting for setup PR checks... ${completed}/${classified.total} complete`);
      previousCompleted = completed;
    }

    await sleepMs(POLL_INTERVAL_MS);
  }
}

async function commitCurrentChanges(
  repoRoot: string,
  subject: string,
  body: string,
  failurePrefix: string
): Promise<void> {
  await runGit(repoRoot, ['add', '-A'], `${failurePrefix} while staging changes`);
  await runGit(
    repoRoot,
    ['commit', '-m', subject, '-m', body],
    `${failurePrefix} while committing`
  );
}

async function pushBranch(repoRoot: string, branchName: string): Promise<void> {
  await runGit(
    repoRoot,
    ['push', '-u', 'origin', branchName],
    `Failed to push setup branch "${branchName}"`
  );
}

async function openPullRequest(
  repoRoot: string,
  repo: string,
  baseBranch: string,
  body: string
): Promise<{ prRef: string; prUrl: string }> {
  const args = ['pr', 'create', '-R', repo, '--title', INITIAL_COMMIT_SUBJECT, '--body', body];
  args.push('--base', baseBranch);

  const { stdout } = await gh(args, { cwd: repoRoot });
  const prUrl = stdout.trim();
  if (!prUrl) {
    throw new Error('Failed to open setup PR: gh pr create returned an empty URL.');
  }

  return {
    prRef: String(parsePrNumberFromUrl(prUrl)),
    prUrl,
  };
}

function parsePrNumberFromUrl(url: string): number {
  const pathname = new URL(url).pathname;
  const match = /\/pull\/(\d+)\/?$/.exec(pathname);
  const prNumber = Number(match?.[1]);

  if (!match?.[1] || !Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(`Failed to parse PR number from URL: ${url}`);
  }

  return prNumber;
}

async function buildContentSignatureMap(
  repoRoot: string,
  entries: GitStatusEntry[]
): Promise<Map<string, string>> {
  const signatures = await Promise.all(
    entries.map(async (entry) => {
      try {
        const content = await readFile(path.resolve(repoRoot, entry.path));
        return [entry.path, hashContent(content)] as const;
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ENOENT'
        ) {
          return undefined;
        }
        throw error;
      }
    })
  );

  return new Map(
    signatures.filter(
      (signature): signature is readonly [string, string] => signature !== undefined
    )
  );
}

async function getCurrentBranchName(repoRoot: string): Promise<string> {
  return (
    await runGit(repoRoot, ['branch', '--show-current'], 'Failed to determine the current branch')
  ).stdout.trim();
}

async function ensureBaseBranchSafe(repoRoot: string, repo: string): Promise<string | undefined> {
  const baseBranch = await resolveBaseBranch(repo, getSettings().defaultBaseBranch);
  const currentBranch = await getCurrentBranchName(repoRoot);

  if (currentBranch && currentBranch !== baseBranch) {
    logger.warn(
      `Setup finalization only runs from "${baseBranch}". You are on "${currentBranch}". Switch to ${baseBranch} and rerun shipper setup, or publish the setup changes manually.`
    );
    return undefined;
  }

  return baseBranch;
}

async function runRemediationPass(args: {
  repoRoot: string;
  repo: string;
  prRef: string;
  mode: CommandMode;
  agent?: AgentName;
  model?: string;
  disableMcp?: boolean;
  failureContext: string;
}): Promise<SetupFinalizeResult | 'committed'> {
  const exitCode = await runPrompt('setup_remediate', {
    repo: args.repo,
    prRef: args.prRef,
    cwd: args.repoRoot,
    mode: args.mode,
    agent: args.agent,
    model: args.model,
    disableMcp: args.disableMcp,
    userInput: args.failureContext,
  });

  if (exitCode !== 0) {
    return {
      status: 'failed',
      error: `setup_remediate exited with code ${exitCode}`,
    };
  }

  const beforeCommit = await readGitStatusSnapshot(args.repoRoot);
  if (beforeCommit.entries.length === 0) {
    logger.warn('The remediation pass completed but did not produce any new file changes.');
    return { status: 'completed' };
  }

  await commitCurrentChanges(
    args.repoRoot,
    REMEDIATION_COMMIT_SUBJECT,
    buildCommitBody(
      beforeCommit.entries.map((entry) => entry.path),
      'Files changed while fixing setup PR feedback:'
    ),
    'Failed to finalize setup remediation changes'
  );
  await pushBranch(args.repoRoot, BRANCH_NAME);
  logger.log(`Pushed remediation commit to ${BRANCH_NAME}.`);
  return 'committed';
}

export async function readGitStatusSnapshot(cwd: string): Promise<GitStatusSnapshot> {
  const repoRoot =
    cwd === process.cwd()
      ? await getRepoRoot()
      : (
          await runGit(
            cwd,
            ['rev-parse', '--show-toplevel'],
            'Failed to determine the repository root for setup finalization'
          )
        ).stdout.trim();
  const result = await execAsync('git', [...STATUS_ARGS], { cwd: repoRoot });
  if (result.code !== 0) {
    throw new Error(
      `Failed to read git status: ${formatCommandFailure('git', [...STATUS_ARGS], result)}`
    );
  }

  const entries = parseStatusSnapshot(result.stdout);
  return {
    repoRoot,
    entries,
    byPath: buildEntryMap(entries),
    contentSignatureByPath: await buildContentSignatureMap(repoRoot, entries),
  };
}

export async function offerSetupFinalize(
  options: SetupFinalizeOptions
): Promise<SetupFinalizeResult> {
  if (options.mode === 'headless') {
    return { status: 'headless' };
  }

  const after = await readGitStatusSnapshot(options.before.repoRoot);
  const deltaEntries = getDeltaEntries(options.before, after);
  if (deltaEntries.length === 0) {
    return { status: 'no-changes' };
  }

  const afterPaths = after.entries.map((entry) => entry.path);
  const changedDuringSetup = deltaEntries.map((entry) => entry.path);
  const changedDuringSetupSet = new Set(changedDuringSetup);
  const preExistingDirty = after.entries
    .filter((entry) => !changedDuringSetupSet.has(entry.path))
    .map((entry) => entry.path);

  logChangedFileSummary(changedDuringSetup, preExistingDirty, afterPaths);

  const accepted = await options.confirm('Finalize these setup changes in a PR? [y/N] ');
  if (!accepted) {
    logger.log('Leaving setup changes in the working tree without creating a branch or PR.');
    return { status: 'declined' };
  }

  const repoRoot = after.repoRoot;
  const repo = await getRepoNwo();
  const baseBranch = await ensureBaseBranchSafe(repoRoot, repo);
  if (!baseBranch) {
    return { status: 'blocked-base-branch' };
  }

  const commitBody = buildCommitBody(afterPaths, 'Files captured from shipper setup:');
  const prBody = buildPrBody(afterPaths);

  if (await branchExistsLocally(repoRoot, BRANCH_NAME)) {
    logger.warn(
      `Local branch "${BRANCH_NAME}" already exists. Rename or remove it, then rerun shipper setup.`
    );
    return { status: 'blocked-existing-branch' };
  }

  if (await branchExistsRemotely(repoRoot, BRANCH_NAME)) {
    logger.warn(
      `Remote branch "${BRANCH_NAME}" already exists on origin. Clean it up manually, then rerun shipper setup.`
    );
    return { status: 'blocked-existing-branch' };
  }

  try {
    await runGit(repoRoot, ['checkout', '-b', BRANCH_NAME], 'Failed to create setup branch');
    await commitCurrentChanges(
      repoRoot,
      INITIAL_COMMIT_SUBJECT,
      commitBody,
      'Failed to finalize setup changes'
    );
    await pushBranch(repoRoot, BRANCH_NAME);

    const { prRef, prUrl } = await openPullRequest(repoRoot, repo, baseBranch, prBody);
    logger.log(`Opened setup PR: ${prUrl}`);

    for (;;) {
      const checkResult = await pollChecks(repo, prRef);
      if (
        checkResult.status === 'passed' ||
        checkResult.status === 'no-checks' ||
        checkResult.status === 'timed-out' ||
        checkResult.status === 'fetch-failed'
      ) {
        logger.log(`Review and merge the setup PR manually: ${prUrl}`);
        return { status: 'completed', prUrl };
      }

      const failedChecks = checkResult.failedChecks ?? [];
      reportFailedChecks(failedChecks);
      const shouldRemediate = await options.confirm(
        'Attempt one remediation pass for the failing setup PR checks? [y/N] '
      );
      if (!shouldRemediate) {
        logger.log(`Leaving the failing setup PR for manual follow-up: ${prUrl}`);
        return { status: 'completed', prUrl };
      }

      const remediationResult = await runRemediationPass({
        repoRoot,
        repo,
        prRef,
        mode: options.mode,
        agent: options.agent,
        model: options.model,
        disableMcp: options.disableMcp,
        failureContext: buildFailureContext(failedChecks),
      });

      if (remediationResult !== 'committed') {
        return { ...remediationResult, prUrl };
      }

      logger.log('Re-polling setup PR checks after remediation push.');
    }
  } catch (error) {
    return {
      status: 'failed',
      error: toErrorMessage(error),
    };
  }
}
