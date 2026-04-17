import { toErrorMessage } from './errors.js';
import { withStageHooks } from './hooks.js';
import { withIssueLock } from './lock.js';
import { logger } from './logger.js';
import {
  handleAgentCrash,
  processResult,
  retryOnInvalidOutput,
  scrubOutputDir,
  truncateLargeInput,
} from './output-protocol/index.js';
import type { DiffFileHunks } from './output-protocol/diff-parse.js';
import { runPrompt, type RunPromptOpts } from './prompt-runner.js';
import { formatConflictContext, withGitTransport } from './worktree.js';
import { withWorktree } from './worktree.js';

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
  resolveLocked: () => Promise<{ repoRoot: string; branch: string; baseBranch?: string }>;
  invoker: StageInvokerFactory;
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

export async function runStageScaffold(opts: StageScaffoldOpts): Promise<void> {
  await withIssueLock(opts.repo, opts.issueNumber, async () => {
    const { repoRoot, branch, baseBranch } = await opts.resolveLocked();
    await withStageHooks(
      opts.stage,
      { issueNumber: opts.issueNumber, branchName: branch },
      async () => {
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
            const setupCtx = (await invocation.setup?.()) ?? undefined;

            const initialCode = await invocation.initial();
            if (initialCode !== 0) {
              if (opts.initialFailure === 'crash') {
                const detail = `Agent exited with code ${initialCode}`;
                logger.error(detail);
                await handleAgentCrash(
                  opts.repo,
                  opts.issueNumber,
                  opts.resultStage,
                  detail,
                  `The \`${opts.resultStage}\` agent run exited with code ${initialCode}.`
                );
                process.exitCode = 1;
              } else {
                process.exitCode = initialCode;
              }
              return;
            }

            try {
              const result = await retryOnInvalidOutput({
                cwd: wtPath,
                stage: opts.resultStage,
                ...(setupCtx ?? {}),
                retry: (userInput) => invocation.retry(userInput),
              });
              await processResult({
                repo: opts.repo,
                issueNumber: opts.issueNumber,
                stage: opts.resultStage,
                cwd: wtPath,
                result,
                ...(opts.prNumber !== undefined ? { prNumber: opts.prNumber.value } : {}),
              });
            } catch (error) {
              const detail = toErrorMessage(error);
              logger.error(detail);
              await handleAgentCrash(opts.repo, opts.issueNumber, opts.resultStage, detail);
              process.exitCode = 1;
            }
          }
        );
      }
    );
  });
}
