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

export async function runPlanStage(
  repo: string,
  issue: string,
  mode?: CommandMode,
  agent?: AgentName,
  model?: string
): Promise<StageRunResult> {
  return await runStageScaffold({
    repo,
    issueNumber: issue,
    stage: 'plan',
    resultStage: 'plan',
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
      promptName: 'plan',
      baseRunPromptOpts: { repo, issueRef: issue, mode, agent, model },
    }),
  });
}

export async function planCommand(
  repo: string,
  issue?: string,
  mode?: CommandMode,
  agent?: AgentName,
  model?: string
): Promise<void> {
  if (!issue) {
    const selected = await autoSelectIssue(repo, 'shipper:designed');
    if (!selected) {
      throw new Error("No issues ready for planning. Run 'shipper design' first.");
    }
    logger.error(`Auto-selected #${selected.number}: ${selected.title}`);
    issue = String(selected.number);
  }

  process.exitCode = (await runPlanStage(repo, issue, mode, agent, model)).exitCode;
}
