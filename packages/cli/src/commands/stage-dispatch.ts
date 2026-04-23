import {
  DESIGNED_LABEL,
  GROOMED_LABEL,
  IMPLEMENTED_LABEL,
  NEW_LABEL,
  PLANNED_LABEL,
  PR_OPEN_LABEL,
  PR_REVIEWED_LABEL,
  READY_LABEL,
  logger,
  tryResolvePrForIssue,
} from '@dnsquared/shipper-core';
import type { AgentName, CommandMode } from '@dnsquared/shipper-core';
import { runDesignStage } from './design.js';
import { runGroomStage } from './groom.js';
import { runImplementStage } from './implement.js';
import { runPlanStage } from './plan.js';
import { runPrOpenStage } from './pr-open.js';
import { runPrRemediateStage } from './pr-remediate.js';
import { runPrReviewStage } from './pr-review.js';
import type { StageRunResult } from './stage-result.js';

export interface StageDispatchOptions {
  mode?: CommandMode;
  agent?: AgentName;
  model?: string;
  disableMcp?: boolean;
  skipInitialPrRemediateWait?: boolean;
}

async function resolvePrForIssue(repo: string, issueNumber: number): Promise<string> {
  const pr = await tryResolvePrForIssue(repo, issueNumber);
  if (!pr) {
    throw new Error(
      `No open PR found for issue #${issueNumber}. Run \`shipper pr open ${issueNumber}\` first.`
    );
  }
  return pr;
}

// Callers must already hold the issue lock before dispatching.
export async function runStageForLabel(
  repo: string,
  issueNumber: string,
  label: string,
  options: StageDispatchOptions = {}
): Promise<StageRunResult> {
  switch (label) {
    case NEW_LABEL:
      logger.log(`Running: shipper groom ${issueNumber}`);
      return await runGroomStage(
        repo,
        issueNumber,
        options.mode,
        options.agent,
        options.model,
        options.disableMcp
      );
    case GROOMED_LABEL:
      logger.log(`Running: shipper design ${issueNumber}`);
      return await runDesignStage(
        repo,
        issueNumber,
        options.mode,
        options.agent,
        options.model,
        options.disableMcp
      );
    case DESIGNED_LABEL:
      logger.log(`Running: shipper plan ${issueNumber}`);
      return await runPlanStage(
        repo,
        issueNumber,
        options.mode,
        options.agent,
        options.model,
        options.disableMcp
      );
    case PLANNED_LABEL:
      logger.log(`Running: shipper implement ${issueNumber}`);
      return await runImplementStage(
        repo,
        issueNumber,
        options.mode,
        options.agent,
        options.model,
        options.disableMcp
      );
    case IMPLEMENTED_LABEL:
      logger.log(`Running: shipper pr open ${issueNumber}`);
      return await runPrOpenStage(
        repo,
        issueNumber,
        options.mode,
        options.agent,
        options.model,
        options.disableMcp
      );
    case PR_OPEN_LABEL: {
      const prNumber = await resolvePrForIssue(repo, Number(issueNumber));
      logger.log(`Running: shipper pr review ${prNumber}`);
      return await runPrReviewStage(
        repo,
        issueNumber,
        prNumber,
        options.mode,
        options.agent,
        options.model,
        options.disableMcp
      );
    }
    case PR_REVIEWED_LABEL: {
      const prNumber = await resolvePrForIssue(repo, Number(issueNumber));
      logger.log(`Running: shipper pr remediate ${prNumber}`);
      return await runPrRemediateStage(repo, issueNumber, prNumber, {
        mode: options.mode,
        agent: options.agent,
        model: options.model,
        disableMcp: options.disableMcp,
        skipInitialWait: options.skipInitialPrRemediateWait,
      });
    }
    case READY_LABEL:
      logger.log(`Issue #${issueNumber} is ready — no remaining workflow steps.`);
      return { success: true, exitCode: 0 };
    default:
      throw new Error(`Unrecognized shipper label "${label}" on issue #${issueNumber}.`);
  }
}
