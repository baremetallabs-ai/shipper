import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  NEW_ISSUE_MAX_IMAGE_BYTES,
  NEW_ISSUE_MAX_IMAGES,
  PROTOCOL_INPUT_DIR,
  SHIPPER_NEW_ISSUE_SCREENSHOT_DIR_ENV,
  getRepoRoot,
  getSettings,
  logger,
  persistNewResultForLatestSession,
  resolveAgent,
  resolveBaseBranch,
  resolveMode,
  runPrompt,
  scrubOutputDir,
  SHIPPER_SESSION_RUN_ID_ENV,
  supportsNewIssueImages,
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
const STAGED_SCREENSHOT_PATTERN = /^screenshot-(\d{2})\.(png|jpg|webp)$/;

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

interface StagedScreenshot {
  filename: string;
  sourcePath: string;
  index: number;
}

async function collectStagedScreenshots(): Promise<StagedScreenshot[]> {
  const stagingDir = process.env[SHIPPER_NEW_ISSUE_SCREENSHOT_DIR_ENV];
  if (!stagingDir) {
    return [];
  }

  const entries = await readdir(stagingDir, { withFileTypes: true });
  const screenshots = new Map<number, StagedScreenshot>();

  for (const entry of entries) {
    const match = STAGED_SCREENSHOT_PATTERN.exec(entry.name);
    if (!match?.[1]) {
      throw new Error(`Invalid New Issue screenshot staging file: ${entry.name}`);
    }
    if (!entry.isFile()) {
      throw new Error(`Invalid New Issue screenshot staging entry: ${entry.name} is not a file.`);
    }

    const index = Number(match[1]);
    if (index < 1 || index > NEW_ISSUE_MAX_IMAGES) {
      throw new Error(
        `Invalid New Issue screenshot staging file: ${entry.name} exceeds the ${NEW_ISSUE_MAX_IMAGES}-image limit.`
      );
    }
    if (screenshots.has(index)) {
      throw new Error(
        `Invalid New Issue screenshot staging files: duplicate screenshot ${match[1]}.`
      );
    }

    const sourcePath = path.join(stagingDir, entry.name);
    const fileStat = await stat(sourcePath);
    if (!fileStat.isFile()) {
      throw new Error(`Invalid New Issue screenshot staging entry: ${entry.name} is not a file.`);
    }
    if (fileStat.size > NEW_ISSUE_MAX_IMAGE_BYTES) {
      throw new Error(
        `Invalid New Issue screenshot staging file: ${entry.name} exceeds the 10 MB limit.`
      );
    }

    screenshots.set(index, { filename: entry.name, sourcePath, index });
  }

  const ordered = [...screenshots.values()].sort((a, b) => a.index - b.index);
  if (ordered.length === 0) {
    throw new Error('New Issue screenshot staging directory did not contain any screenshots.');
  }
  if (ordered.length > NEW_ISSUE_MAX_IMAGES) {
    throw new Error(
      `New Issue screenshot staging contains more than ${NEW_ISSUE_MAX_IMAGES} files.`
    );
  }

  for (let expected = 1; expected <= ordered.length; expected += 1) {
    if (ordered[expected - 1]?.index !== expected) {
      throw new Error('New Issue screenshot staging files must be numbered contiguously from 01.');
    }
  }

  return ordered;
}

async function copyScreenshotsToWorktreeInput(wtPath: string): Promise<string[]> {
  const stagedScreenshots = await collectStagedScreenshots();
  if (stagedScreenshots.length === 0) {
    return [];
  }

  const inputDir = path.join(wtPath, PROTOCOL_INPUT_DIR);
  await mkdir(inputDir, { recursive: true });

  const copiedPaths: string[] = [];
  for (const screenshot of stagedScreenshots) {
    const destinationPath = path.join(inputDir, screenshot.filename);
    await copyFile(screenshot.sourcePath, destinationPath);
    copiedPaths.push(destinationPath);
  }

  return copiedPaths;
}

function buildNewIssueUserInput(request: string, screenshotCount: number): string | undefined {
  if (screenshotCount === 0) {
    return request || undefined;
  }

  const screenshotInstructions = [
    `${screenshotCount} screenshot attachment${screenshotCount === 1 ? ' was' : 's were'} provided as image inputs for this New Issue run.`,
    'Inspect all screenshot attachments while drafting the issue.',
    'Describe relevant visual content inline in the Interpretation or Starting Point sections.',
    `Add a short factual line near the bottom saying ${screenshotCount} screenshot${screenshotCount === 1 ? ' was' : 's were'} attached and inspected while drafting the issue.`,
    'Do not include Markdown image tags, GitHub attachment links, or local screenshot path references in the issue body.',
  ].join(' ');

  return request ? `${request}\n\n---\n\n${screenshotInstructions}` : screenshotInstructions;
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
          let imageInputPaths: string[];
          try {
            imageInputPaths = await copyScreenshotsToWorktreeInput(wtPath);
          } catch (error) {
            logger.error(toErrorMessage(error));
            return 1;
          }

          if (imageInputPaths.length > 0) {
            const resolvedAgent = resolveAgent('new', options.agent);
            if (!supportsNewIssueImages(resolvedAgent)) {
              logger.error(
                `Image inputs are not supported for the "${resolvedAgent}" agent on New Issue runs.`
              );
              return 1;
            }
          }

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
              ...(imageInputPaths.length > 0 ? { imageInputPaths } : {}),
            });

          const initialExitCode = await runNewPrompt(
            buildNewIssueUserInput(request, imageInputPaths.length)
          );
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
            const runId = process.env[SHIPPER_SESSION_RUN_ID_ENV] || undefined;
            await persistNewResultForLatestSession({
              repo,
              cwd: wtPath,
              since: startedAt,
              runId,
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
