import path from 'node:path';
import { toErrorMessage } from './errors.js';
import { withStageHooks } from './hooks.js';
import { withBufferedLockRenewalOutput, withIssueLock } from './lock.js';
import { logger } from './logger.js';
import {
  handleAgentCrash,
  postComment,
  processResult,
  retryPrReviewOutputAndSubmission,
  retryOnInvalidOutput,
  scrubOutputDir,
  submitReviewPayload,
  truncateLargeInput,
  validateStageOutput,
} from './output-protocol/index.js';
import type { DiffFileHunks } from './output-protocol/diff-parse.js';
import { runPrompt, type RunPromptOpts } from './prompt-runner.js';
import type { ResultJson } from './result-schema.js';
import { resolveAgent, resolveDisableMcp, resolveModel } from './settings.js';
import { formatConflictContext, withGitTransport, withWorktree } from './worktree.js';
import { execAsync, formatCommandFailure } from './worktree/helpers.js';

export type ScaffoldStage = 'design' | 'plan' | 'implement' | 'pr-open' | 'pr-review';
export type ScaffoldResultStage = 'design' | 'plan' | 'implement' | 'pr_open' | 'pr_review';

interface StageSetupResult {
  prFiles?: Set<string>;
  diffHunks?: Map<string, DiffFileHunks>;
}

export interface StageInvocation {
  setup?: () => Promise<StageSetupResult | undefined>;
  initial: () => Promise<number>;
  retry: (userInput: string) => Promise<number>;
}

export type StageInvokerFactory = (ctx: {
  wtPath: string;
  repoRoot: string;
  branch: string;
  baseBranch: string | undefined;
}) => StageInvocation;

export interface StageScaffoldOpts {
  repo: string;
  issueNumber: string;
  stage: ScaffoldStage;
  resultStage: ScaffoldResultStage;
  createBranch: boolean;
  initialFailure: 'crash' | 'propagate';
  prNumber?: { value: string | undefined };
  bufferLockRenewalOutput?: boolean;
  resolveLocked: () => Promise<{ repoRoot: string; branch: string; baseBranch?: string }>;
  invoker: StageInvokerFactory;
}

export interface StageRunResult {
  success: boolean;
  exitCode: number;
  error?: string;
  verdict?: ResultJson['verdict'];
}

type SimplePromptName = 'design' | 'plan' | 'pr_review';
type TransportPromptName = 'implement' | 'pr_open';
type StageRunPromptOpts = Omit<RunPromptOpts, 'cwd' | 'userInput'>;

export function simpleInvoker(args: {
  promptName: SimplePromptName;
  baseRunPromptOpts: StageRunPromptOpts;
  setup?: (wtPath: string) => Promise<StageSetupResult | undefined>;
}): StageInvokerFactory {
  return ({ wtPath }) => {
    const setup = args.setup;

    return {
      setup: setup ? () => setup(wtPath) : undefined,
      initial: async () =>
        await runPrompt(args.promptName, {
          ...args.baseRunPromptOpts,
          cwd: wtPath,
        }),
      retry: async (userInput) =>
        await runPrompt(args.promptName, {
          ...args.baseRunPromptOpts,
          cwd: wtPath,
          userInput,
        }),
    };
  };
}

type AdversarialPrimaryName = 'design';
type AdversarialAdversaryName = 'design_adversary';

/**
 * Runs an alternating designer/adversary loop within a single stage worktree.
 *
 * Sequence with rounds=N (N >= 0):
 *   primary, then for each round k in 1..N:
 *     post primary's comment, scrub output, reset worktree, run adversary,
 *     post adversary's comment, scrub output, reset worktree, run primary.
 *
 * The final primary call's output is left in `.shipper/output/` for the scaffold's
 * `retryOnInvalidOutput` + `processResult` to consume — that's what produces the
 * stage's final comment + label transition.
 *
 * If the round-1 designer call rejects (verdict !== 'accept'), the loop bails
 * immediately so the scaffold processes the rejection naturally.
 *
 * Retry: re-runs only the final designer with the correction message. Intermediate
 * comments are already on the issue thread and visible via `append-issue: true`.
 */
export function adversarialInvoker(args: {
  primary: AdversarialPrimaryName;
  adversary: AdversarialAdversaryName;
  rounds: number;
  baseRunPromptOpts: StageRunPromptOpts;
  repo: string;
  issueNumber: string;
}): StageInvokerFactory {
  return ({ wtPath, baseBranch }) => {
    if (baseBranch === undefined) {
      throw new Error('baseBranch is required for adversarialInvoker');
    }
    const resetTarget = `origin/${baseBranch}`;

    // Resolve once using the primary step name so the adversary inherits the same
    // settings (agent, model, disableMcp) when the user has set commands.design.* —
    // otherwise resolveAgent('design_adversary', ...) would fall back to defaults.
    const resolved = {
      agent: resolveAgent(args.primary, args.baseRunPromptOpts.agent),
      model: resolveModel(args.primary, args.baseRunPromptOpts.model),
      disableMcp: resolveDisableMcp(args.primary, args.baseRunPromptOpts.disableMcp),
    };
    const sharedOpts: StageRunPromptOpts = {
      ...args.baseRunPromptOpts,
      ...resolved,
    };

    const runPrimary = (userInput?: string): Promise<number> =>
      runPrompt(args.primary, {
        ...sharedOpts,
        cwd: wtPath,
        ...(userInput !== undefined ? { userInput } : {}),
      });
    const runAdversary = (): Promise<number> =>
      runPrompt(args.adversary, { ...sharedOpts, cwd: wtPath });

    const resetWorktree = async (): Promise<void> => {
      await scrubOutputDir(wtPath);
      const result = await execAsync('git', ['reset', '--hard', resetTarget], { cwd: wtPath });
      if (result.code !== 0) {
        throw new Error(
          `Failed to reset worktree to ${resetTarget}: ${formatCommandFailure('git', ['reset', '--hard', resetTarget], result)}`
        );
      }
    };

    type IntermediateOutcome =
      | { kind: 'accept'; commentPath: string }
      | { kind: 'reject' }
      | { kind: 'invalid' };

    const inspectIntermediate = async (): Promise<IntermediateOutcome> => {
      try {
        const result = await validateStageOutput(wtPath, 'design');
        if (result.verdict !== 'accept') {
          return { kind: 'reject' };
        }
        return { kind: 'accept', commentPath: path.resolve(wtPath, result.comment) };
      } catch (error) {
        logger.error(`Intermediate adversarial-loop output invalid: ${toErrorMessage(error)}`);
        return { kind: 'invalid' };
      }
    };

    const inspectAdversary = async (): Promise<IntermediateOutcome> => {
      try {
        const result = await validateStageOutput(wtPath, 'design');
        if (result.verdict !== 'accept') {
          logger.error(
            `Adversary returned verdict "${result.verdict}"; adversary must always return accept.`
          );
          return { kind: 'invalid' };
        }
        return { kind: 'accept', commentPath: path.resolve(wtPath, result.comment) };
      } catch (error) {
        logger.error(`Adversary output invalid: ${toErrorMessage(error)}`);
        return { kind: 'invalid' };
      }
    };

    return {
      initial: async (): Promise<number> => {
        const code1 = await runPrimary();
        if (code1 !== 0) return code1;
        if (args.rounds <= 0) return 0;

        for (let round = 1; round <= args.rounds; round++) {
          // Validate the current designer output (round 1 designer on first iter,
          // revise output on subsequent iters).
          const designOutcome = await inspectIntermediate();
          if (designOutcome.kind === 'invalid') return 1;
          if (designOutcome.kind === 'reject') return 0;

          await postComment(args.repo, args.issueNumber, designOutcome.commentPath);
          await resetWorktree();

          const codeAdv = await runAdversary();
          if (codeAdv !== 0) return codeAdv;

          const advOutcome = await inspectAdversary();
          if (advOutcome.kind !== 'accept') return 1;

          await postComment(args.repo, args.issueNumber, advOutcome.commentPath);
          await resetWorktree();

          const codeRevise = await runPrimary();
          if (codeRevise !== 0) return codeRevise;
        }

        return 0;
      },
      retry: async (userInput) => await runPrimary(userInput),
    };
  };
}

export function transportInvoker(args: {
  promptName: TransportPromptName;
  pushMode: 'new-branch' | 'force-with-lease';
  baseRunPromptOpts: StageRunPromptOpts;
}): StageInvokerFactory {
  return ({ wtPath, repoRoot, baseBranch }) => {
    if (baseBranch === undefined) {
      throw new Error('baseBranch is required for transport invocations');
    }

    const getTransportUserInput = async (
      conflictContext?: Parameters<typeof formatConflictContext>[0],
      pushError?: string,
      installError?: string
    ): Promise<string | undefined> => {
      if (conflictContext) {
        return await truncateLargeInput(
          wtPath,
          formatConflictContext(conflictContext),
          'conflict-context.txt'
        );
      }
      if (pushError) {
        return await truncateLargeInput(wtPath, pushError, 'push-error.txt');
      }
      if (installError) {
        return await truncateLargeInput(wtPath, installError, 'install-error.txt');
      }
      return undefined;
    };

    return {
      initial: async () =>
        await withGitTransport(
          { wtPath, repoRoot, baseBranch, pushMode: args.pushMode },
          async (conflictContext, pushError, installError) =>
            await runPrompt(args.promptName, {
              ...args.baseRunPromptOpts,
              cwd: wtPath,
              userInput: await getTransportUserInput(conflictContext, pushError, installError),
            })
        ),
      retry: async (userInput) =>
        await withGitTransport(
          { wtPath, repoRoot, baseBranch, pushMode: args.pushMode },
          async (conflictContext, pushError, installError) =>
            await runPrompt(args.promptName, {
              ...args.baseRunPromptOpts,
              cwd: wtPath,
              userInput:
                (await getTransportUserInput(conflictContext, pushError, installError)) ??
                userInput,
            })
        ),
    };
  };
}

export async function runStageScaffold(opts: StageScaffoldOpts): Promise<StageRunResult> {
  return await withIssueLock(opts.repo, opts.issueNumber, async () => {
    const { repoRoot, branch, baseBranch } = await opts.resolveLocked();
    return await withStageHooks(
      opts.stage,
      { issueNumber: opts.issueNumber, branchName: branch },
      async () => {
        const runStageBody = async (): Promise<StageRunResult> =>
          await withWorktree(
            {
              repoRoot,
              branch,
              createBranch: opts.createBranch,
              ...(baseBranch !== undefined ? { baseBranch } : {}),
              issueNumber: opts.issueNumber,
              stage: opts.stage,
            },
            async (wtPath) => {
              await scrubOutputDir(wtPath);
              const invocation = opts.invoker({ wtPath, repoRoot, branch, baseBranch });
              const crashOptions = {
                cwd: wtPath,
                detailFilename: `${opts.resultStage}-failure-detail.txt`,
              };
              let setupCtx: StageSetupResult | undefined;
              try {
                setupCtx = (await invocation.setup?.()) ?? undefined;
              } catch (error) {
                const detail = toErrorMessage(error);
                logger.error(detail);
                await handleAgentCrash(
                  opts.repo,
                  opts.issueNumber,
                  opts.resultStage,
                  detail,
                  undefined,
                  crashOptions
                );
                return { success: false, exitCode: 1, error: detail } satisfies StageRunResult;
              }

              const initialCode = await invocation.initial();
              if (initialCode !== 0) {
                const detail = `Agent exited with code ${initialCode}`;
                if (opts.initialFailure === 'crash') {
                  logger.error(detail);
                  await handleAgentCrash(
                    opts.repo,
                    opts.issueNumber,
                    opts.resultStage,
                    detail,
                    `The \`${opts.resultStage}\` agent run exited with code ${initialCode}.`,
                    crashOptions
                  );
                  return { success: false, exitCode: 1, error: detail } satisfies StageRunResult;
                }
                return {
                  success: false,
                  exitCode: initialCode,
                  error: detail,
                } satisfies StageRunResult;
              }

              try {
                let result: ResultJson;
                let reviewSubmitted = false;
                if (opts.resultStage === 'pr_review') {
                  const prNumber = opts.prNumber?.value;
                  if (!prNumber) {
                    throw new Error('pr_review submission requires a PR number');
                  }

                  const retryResult = await retryPrReviewOutputAndSubmission({
                    cwd: wtPath,
                    ...(setupCtx ?? {}),
                    retry: (userInput) => invocation.retry(userInput),
                    submitReviewPayload: async (payloadPath) => {
                      await submitReviewPayload(opts.repo, prNumber, wtPath, payloadPath);
                    },
                    refreshContext: async () => (await invocation.setup?.()) ?? undefined,
                  });
                  result = retryResult.result;
                  reviewSubmitted = retryResult.reviewSubmitted;
                } else {
                  result = await retryOnInvalidOutput({
                    cwd: wtPath,
                    stage: opts.resultStage,
                    ...(setupCtx ?? {}),
                    retry: (userInput) => invocation.retry(userInput),
                  });
                }

                await processResult({
                  repo: opts.repo,
                  issueNumber: opts.issueNumber,
                  stage: opts.resultStage,
                  cwd: wtPath,
                  result,
                  ...(opts.prNumber !== undefined ? { prNumber: opts.prNumber.value } : {}),
                  ...(opts.resultStage === 'pr_review'
                    ? { reviewPayloadAlreadySubmitted: reviewSubmitted }
                    : {}),
                });
                return result.verdict === 'accept'
                  ? ({
                      success: true,
                      exitCode: 0,
                      verdict: result.verdict,
                    } satisfies StageRunResult)
                  : ({
                      success: false,
                      exitCode: 1,
                      error: `Stage returned verdict "${result.verdict}".`,
                      verdict: result.verdict,
                    } satisfies StageRunResult);
              } catch (error) {
                const detail = toErrorMessage(error);
                logger.error(detail);
                await handleAgentCrash(
                  opts.repo,
                  opts.issueNumber,
                  opts.resultStage,
                  detail,
                  undefined,
                  crashOptions
                );
                return { success: false, exitCode: 1, error: detail } satisfies StageRunResult;
              }
            }
          );

        return opts.bufferLockRenewalOutput === true
          ? await withBufferedLockRenewalOutput(runStageBody)
          : await runStageBody();
      }
    );
  });
}
