import {
  autoSelectPrForStage,
  getBranchForPR,
  getRepoRoot,
  gh,
  logger,
  parsePrFilesPages,
  parseDiffHunks,
  resolveRef,
  runStageScaffold,
  simpleInvoker,
  writeContextFile,
} from '@dnsquared/shipper-core';
import type { AgentName, CommandMode } from '@dnsquared/shipper-core';

export async function prReviewCommand(
  repo: string,
  pr?: string,
  mode?: CommandMode,
  agent?: AgentName,
  model?: string
): Promise<void> {
  let issueNumber: string;

  if (!pr) {
    const selected = await autoSelectPrForStage(
      repo,
      'shipper:pr-open',
      "No PRs ready for review. Run 'shipper pr open' first."
    );
    logger.error(
      `Auto-selected PR #${selected.pr} (issue #${selected.issue.number}: ${selected.issue.title})`
    );
    pr = selected.pr;
    issueNumber = String(selected.issue.number);
  } else {
    const resolved = await resolveRef(repo, pr, 'both');
    pr = resolved.prNumber;
    issueNumber = resolved.issueNumber;
  }

  await runStageScaffold({
    repo,
    issueNumber,
    stage: 'pr-review',
    resultStage: 'pr_review',
    createBranch: false,
    initialFailure: 'crash',
    prNumber: { value: pr },
    resolveLocked: async () => {
      const repoRoot = await getRepoRoot();
      const branch = await getBranchForPR(repo, pr);
      return { repoRoot, branch };
    },
    invoker: simpleInvoker({
      promptName: 'pr_review',
      baseRunPromptOpts: { repo, issueRef: issueNumber, prRef: pr, mode, agent, model },
      setup: async (wtPath) => {
        const { stdout: diff } = await gh(['pr', 'diff', pr, '-R', repo]);
        const diffHunks = parseDiffHunks(diff);
        await writeContextFile(wtPath, 'pr-diff.patch', diff);

        const { stdout: prFilesRaw } = await gh([
          'api',
          `repos/${repo}/pulls/${pr}/files`,
          '--paginate',
          '--slurp',
        ]);
        const parsedPrFiles = parsePrFilesPages(prFilesRaw).flat();
        const prFiles = JSON.stringify(parsedPrFiles);
        const prFileSet = new Set(parsedPrFiles.map((file) => file.filename));
        await writeContextFile(wtPath, 'pr-files.json', prFiles);

        const { stdout: prMetadata } = await gh([
          'pr',
          'view',
          pr,
          '-R',
          repo,
          '--json',
          'headRefOid,author,title,headRefName',
        ]);
        await writeContextFile(wtPath, 'pr-metadata.json', prMetadata);

        return { prFiles: prFileSet, diffHunks };
      },
    }),
  });
}
