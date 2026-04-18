import {
  autoSelectIssue,
  generateBranchName,
  getRepoRoot,
  getSettings,
  logger,
  resolveBaseBranch,
  runStageScaffold,
  simpleInvoker,
} from '@dnsquared/shipper-core';
import type { AgentName, CommandMode } from '@dnsquared/shipper-core';
import type { StageRunResult } from './stage-result.js';

export async function runDesignStage(
  repo: string,
  issue: string,
  mode?: CommandMode,
  agent?: AgentName,
  model?: string
): Promise<StageRunResult> {
  return await runStageScaffold({
    repo,
    issueNumber: issue,
    stage: 'design',
    resultStage: 'design',
    createBranch: true,
    initialFailure: 'crash',
    resolveLocked: async () => {
      const repoRoot = await getRepoRoot();
      const branch = await generateBranchName(repo, issue);
      const settings = getSettings();
      const baseBranch = await resolveBaseBranch(repo, settings.defaultBaseBranch);
      return { repoRoot, branch, baseBranch };
    },
    invoker: simpleInvoker({
      promptName: 'design',
      baseRunPromptOpts: { repo, issueRef: issue, mode, agent, model },
    }),
  });
}

export async function designCommand(
  repo: string,
  issue?: string,
  mode?: CommandMode,
  agent?: AgentName,
  model?: string
): Promise<void> {
  if (!issue) {
    const selected = await autoSelectIssue(repo, 'shipper:groomed');
    if (!selected) {
      throw new Error("No issues ready for design. Run 'shipper groom' first.");
    }
    logger.error(`Auto-selected #${selected.number}: ${selected.title}`);
    issue = String(selected.number);
  }

  process.exitCode = (await runDesignStage(repo, issue, mode, agent, model)).exitCode;
}
