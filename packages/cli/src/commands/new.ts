import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import {
  getRepoRoot,
  getSettings,
  logger,
  resolveBaseBranch,
  resolveMode,
  runPrompt,
  withStageHooks,
  withWorktree,
  type AgentName,
  type CommandMode,
} from '@dnsquared/shipper-core';

const execFileAsync = promisify(execFile);

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

export async function newCommand(
  repo: string,
  requestWords: string[],
  options: { mode?: CommandMode; agent?: AgentName; model?: string; logFile?: string } = {}
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
  const branch = generateNewBranch();
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
        async (wtPath) =>
          await runPrompt('new', {
            userInput: request || undefined,
            cwd: wtPath,
            mode: options.mode,
            agent: options.agent,
            model: options.model,
            logFile: options.logFile,
          })
      );
    });
  } finally {
    try {
      await execFileAsync('git', ['branch', '-D', branch], { cwd: repoRoot });
    } catch {
      // The branch might not exist if worktree setup failed before creation.
    }
  }

  process.exitCode = exitCode;
}
