import {
  autoSelectIssue,
  generateBranchName,
  getRepoRoot,
  getSettings,
  logger,
  resolveBaseBranch,
  resolveMode,
  runStageScaffold,
  simpleInvoker,
} from '@baremetallabs-ai/shipper-core';
import type { AgentName, CommandMode } from '@baremetallabs-ai/shipper-core';
import type { StageRunResult } from './stage-result.js';

export async function runDesignStage(
  repo: string,
  issue: string,
  mode?: CommandMode,
  agent?: AgentName,
  model?: string,
  disableMcp?: boolean
): Promise<StageRunResult> {
  const effectiveMode = resolveMode('design', mode);
  return await runStageScaffold({
    repo,
    issueNumber: issue,
    stage: 'design',
    resultStage: 'design',
    createBranch: true,
    initialFailure: 'crash',
    bufferLockRenewalOutput: effectiveMode === 'interactive',
    resolveLocked: async () => {
      const repoRoot = await getRepoRoot();
      const branch = await generateBranchName(repo, issue);
      const settings = getSettings();
      const baseBranch = await resolveBaseBranch(repo, settings.defaultBaseBranch);
      return { repoRoot, branch, baseBranch };
    },
    invoker: simpleInvoker({
      promptName: 'design',
      baseRunPromptOpts: { repo, issueRef: issue, mode, agent, model, disableMcp },
    }),
  });
}

export async function designCommand(
  repo: string,
  issue?: string,
  mode?: CommandMode,
  agent?: AgentName,
  model?: string,
  disableMcp?: boolean
): Promise<void> {
  if (!issue) {
    const selected = await autoSelectIssue(repo, 'shipper:groomed');
    if (!selected) {
      throw new Error("No issues ready for design. Run 'shipper groom' first.");
    }
    logger.error(`Auto-selected #${selected.number}: ${selected.title}`);
    issue = String(selected.number);
  }

  process.exitCode = (await runDesignStage(repo, issue, mode, agent, model, disableMcp)).exitCode;
}
