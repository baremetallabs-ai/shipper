import {
  logger,
  autoSelectIssue,
  generateBranchName,
  getSettings,
  getRepoRoot,
  resolveBaseBranch,
  resolveMode,
} from '@dnsquared/shipper-core';
import type { AgentName, CommandMode } from '@dnsquared/shipper-core';
import { withStageHooks } from '@dnsquared/shipper-core';
import { withIssueLock } from '@dnsquared/shipper-core';
import { withWorktree } from '@dnsquared/shipper-core';
import { runPrompt } from '@dnsquared/shipper-core';
import { printAutoSummary, type AutoResult } from './ship.js';

export interface GroomOptions {
  auto: boolean;
  mode?: CommandMode;
  agent?: AgentName;
  model?: string;
}

async function groomOneIssue(
  repo: string,
  issueStr: string,
  mode?: CommandMode,
  agent?: AgentName,
  model?: string
): Promise<{ success: boolean; error?: string }> {
  const code = await withIssueLock(repo, issueStr, async () => {
    const repoRoot = await getRepoRoot();
    const branch = await generateBranchName(repo, issueStr);
    const settings = getSettings();
    const baseBranch = await resolveBaseBranch(repo, settings.defaultBaseBranch);

    return await withStageHooks(
      'groom',
      { issueNumber: issueStr, branchName: branch },
      async () =>
        await withWorktree(
          {
            repoRoot,
            branch,
            createBranch: true,
            baseBranch,
            issueNumber: issueStr,
            stage: 'groom',
          },
          async (wtPath) =>
            await runPrompt('groom', { repo, issueRef: issueStr, cwd: wtPath, mode, agent, model })
        )
    );
  });
  return code === 0
    ? { success: true }
    : { success: false, error: 'agent exited with non-zero status' };
}

export async function groomCommand(
  repo: string,
  issue?: string,
  options: GroomOptions = { auto: false }
): Promise<void> {
  const effectiveMode = resolveMode('groom', options.mode);
  if (effectiveMode === 'headless') {
    throw new Error(
      'Error: groom does not support headless mode. Grooming requires interactive input.'
    );
  }

  if (options.auto) {
    const results: AutoResult[] = [];

    for (;;) {
      const candidate = await autoSelectIssue(repo, 'shipper:new');
      if (!candidate) break;

      logger.log(`\nAuto: grooming issue #${candidate.number} — ${candidate.title}`);
      const result = await groomOneIssue(
        repo,
        String(candidate.number),
        options.mode,
        options.agent,
        options.model
      );

      results.push({
        issue: candidate.number,
        title: candidate.title,
        outcome: result.success ? 'pass' : 'fail',
        error: result.error,
      });

      if (!result.success) break;
    }

    printAutoSummary(results);
    process.exitCode = results.some((r) => r.outcome === 'fail') ? 1 : 0;
    return;
  }

  if (!issue) {
    const selected = await autoSelectIssue(repo, 'shipper:new');
    if (!selected) {
      throw new Error("No issues ready for grooming. Create one with 'shipper new'.");
    }
    logger.error(`Auto-selected #${selected.number}: ${selected.title}`);
    issue = String(selected.number);
  }

  process.exitCode = (await groomOneIssue(repo, issue, options.mode, options.agent, options.model))
    .success
    ? 0
    : 1;
}
