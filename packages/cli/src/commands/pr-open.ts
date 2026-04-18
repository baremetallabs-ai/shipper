import {
  autoSelectIssue,
  findBranchForIssue,
  getRepoRoot,
  getSettings,
  logger,
  resolveBaseBranch,
  resolveRef,
  tryResolvePrForIssue,
  runStageScaffold,
  transportInvoker,
} from '@dnsquared/shipper-core';
import type { AgentName, CommandMode } from '@dnsquared/shipper-core';
import type { StageRunResult } from './stage-result.js';

export async function runPrOpenStage(
  repo: string,
  issue: string,
  mode?: CommandMode,
  agent?: AgentName,
  model?: string
): Promise<StageRunResult> {
  const existingPrNumber = await tryResolvePrForIssue(repo, Number(issue));

  const settings = getSettings();
  const baseBranch = await resolveBaseBranch(repo, settings.defaultBaseBranch);

  return (await runStageScaffold({
    repo,
    issueNumber: issue,
    stage: 'pr-open',
    resultStage: 'pr_open',
    createBranch: false,
    initialFailure: 'propagate',
    prNumber: { value: existingPrNumber },
    resolveLocked: async () => {
      const repoRoot = await getRepoRoot();
      const branch = await findBranchForIssue(issue);
      return { repoRoot, branch, baseBranch };
    },
    invoker: transportInvoker({
      promptName: 'pr_open',
      pushMode: 'force-with-lease',
      baseRunPromptOpts: { repo, issueRef: issue, baseBranch, mode, agent, model },
    }),
  })) as unknown as StageRunResult;
}

export async function prOpenCommand(
  repo: string,
  issue?: string,
  mode?: CommandMode,
  agent?: AgentName,
  model?: string
): Promise<void> {
  if (!issue) {
    const selected = await autoSelectIssue(repo, 'shipper:implemented');
    if (!selected) {
      throw new Error("No issues ready for PR. Run 'shipper implement' first.");
    }
    logger.error(`Auto-selected #${selected.number}: ${selected.title}`);
    issue = String(selected.number);
  } else {
    const resolved = await resolveRef(repo, issue, 'issue');
    issue = resolved.issueNumber;
  }

  process.exitCode = (await runPrOpenStage(repo, issue, mode, agent, model)).exitCode;
}
