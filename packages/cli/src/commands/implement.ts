import {
  autoSelectIssue,
  generateBranchName,
  getRepoRoot,
  getSettings,
  logger,
  resolveBaseBranch,
  runStageScaffold,
  transportInvoker,
} from '@dnsquared/shipper-core';
import type { AgentName, CommandMode } from '@dnsquared/shipper-core';
import type { StageRunResult } from './stage-result.js';

export async function runImplementStage(
  repo: string,
  issue: string,
  mode?: CommandMode,
  agent?: AgentName,
  model?: string
): Promise<StageRunResult> {
  return await runStageScaffold({
    repo,
    issueNumber: issue,
    stage: 'implement',
    resultStage: 'implement',
    createBranch: true,
    initialFailure: 'propagate',
    resolveLocked: async () => {
      const repoRoot = await getRepoRoot();
      const branch = await generateBranchName(repo, issue);
      const settings = getSettings();
      const baseBranch = await resolveBaseBranch(repo, settings.defaultBaseBranch);
      return { repoRoot, branch, baseBranch };
    },
    invoker: transportInvoker({
      promptName: 'implement',
      pushMode: 'new-branch',
      baseRunPromptOpts: { repo, issueRef: issue, mode, agent, model },
    }),
  });
}

export async function implementCommand(
  repo: string,
  issue?: string,
  mode?: CommandMode,
  agent?: AgentName,
  model?: string
): Promise<void> {
  if (!issue) {
    const selected = await autoSelectIssue(repo, 'shipper:planned');
    if (!selected) {
      throw new Error("No issues ready for implementation. Run 'shipper plan' first.");
    }
    logger.error(`Auto-selected #${selected.number}: ${selected.title}`);
    issue = String(selected.number);
  }

  process.exitCode = (await runImplementStage(repo, issue, mode, agent, model)).exitCode;
}
