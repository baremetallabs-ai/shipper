import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import {
  getRepoRoot,
  getSettings,
  logger,
  persistNewResultForLatestSession,
  resolveBaseBranch,
  resolveMode,
  runPrompt,
  scrubOutputDir,
  SHIPPER_SESSION_RUN_ID_ENV,
  createIssueFromDraft,
  retryOnInvalidNewIssueDraft,
  toErrorMessage,
  withStageHooks,
  withWorktree,
  writeCreatedIssueResult,
  type AgentName,
  type CommandMode,
} from '@baremetallabs-ai/shipper-core';

const execFileAsync = promisify(execFile);
const MAX_BRANCH_GENERATION_ATTEMPTS = 10;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function generateNewBranch(): string {
  const now = new Date();
  const stamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `shipper/new-${stamp}-${randomBytes(3).toString('hex')}`;
}

async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--verify', `refs/heads/${branch}`], {
      cwd: repoRoot,
    });
    return true;
  } catch {
    return false;
  }
}

async function generateUniqueNewBranch(repoRoot: string): Promise<string> {
  for (let attempt = 0; attempt < MAX_BRANCH_GENERATION_ATTEMPTS; attempt += 1) {
    const branch = generateNewBranch();
    if (!(await branchExists(repoRoot, branch))) {
      return branch;
    }
  }

  throw new Error('Failed to generate a unique ephemeral branch name for shipper new.');
}

export async function newCommand(
  repo: string,
  requestWords: string[],
  options: {
    mode?: CommandMode;
    agent?: AgentName;
    model?: string;
    disableMcp?: boolean;
    logFile?: string;
  } = {}
): Promise<void> {
  const request = requestWords.join(' ').trim();
  if (!request) {
    const effectiveMode = resolveMode('new', options.mode);
    if (effectiveMode === 'headless') {
      logger.error('Usage: shipper new <request...> --mode headless');
      throw new Error('Error: A request is required when running in headless mode.');
    }
  }

  const repoRoot = await getRepoRoot();
  const branch = await generateUniqueNewBranch(repoRoot);
  const baseBranch = await resolveBaseBranch(repo, getSettings().defaultBaseBranch);

  let exitCode = 1;
  try {
    exitCode = await withStageHooks('new', { branchName: branch }, async () => {
      return await withWorktree(
        {
          repoRoot,
          branch,
          createBranch: true,
          baseBranch,
          stage: 'new',
        },
        async (wtPath) => {
          const startedAt = new Date();
          await scrubOutputDir(wtPath);

          const runNewPrompt = async (userInput?: string): Promise<number> =>
            await runPrompt('new', {
              userInput,
              repo,
              cwd: wtPath,
              baseBranch,
              mode: options.mode,
              agent: options.agent,
              model: options.model,
              disableMcp: options.disableMcp,
              logFile: options.logFile,
            });

          const initialExitCode = await runNewPrompt(request || undefined);
          if (initialExitCode !== 0) {
            return initialExitCode;
          }

          let draft: Awaited<ReturnType<typeof retryOnInvalidNewIssueDraft>>;
          try {
            draft = await retryOnInvalidNewIssueDraft({
              cwd: wtPath,
              retry: async (userInput) => await runNewPrompt(userInput),
            });
          } catch (error) {
            logger.error(`Invalid new issue draft: ${toErrorMessage(error)}`);
            return 1;
          }

          let createdIssue: Awaited<ReturnType<typeof createIssueFromDraft>>;
          try {
            createdIssue = await createIssueFromDraft(repo, draft);
          } catch (error) {
            logger.error(toErrorMessage(error));
            return 1;
          }

          let result: Awaited<ReturnType<typeof writeCreatedIssueResult>>;
          try {
            result = await writeCreatedIssueResult(wtPath, createdIssue);
            await persistNewResultForLatestSession({
              repo,
              cwd: wtPath,
              since: startedAt,
              runId: process.env[SHIPPER_SESSION_RUN_ID_ENV],
              result,
            });
          } catch (error) {
            logger.error(toErrorMessage(error));
            return 1;
          }

          logger.log(
            `Created issue: #${createdIssue.number} ${createdIssue.title}\nURL: ${createdIssue.url}`
          );
          return 0;
        }
      );
    });
  } finally {
    try {
      await execFileAsync('git', ['branch', '-d', branch], { cwd: repoRoot });
    } catch {
      // The branch might not exist if worktree setup failed before creation.
    }
  }

  process.exitCode = exitCode;
}
