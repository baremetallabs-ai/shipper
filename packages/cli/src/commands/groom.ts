import path from 'node:path';
import type { ReadStream } from 'node:tty';
import {
  PROTOCOL_OUTPUT_DIR,
  autoSelectIssue,
  generateBranchName,
  getRepoRoot,
  getSettings,
  GroomPostFlightError,
  handleAgentCrash,
  isDesktopFinalizeRequested,
  isMcpGroomingEnabled,
  logger,
  processGroomResult,
  resolveDesktopControlDir,
  resolveBaseBranch,
  resolveMode,
  retryOnInvalidOutput,
  runPrompt,
  scrubOutputDir,
  toErrorMessage,
  validateStageOutput,
  withIssueLock,
  withStageHooks,
  withWorktree,
  writeDesktopControlState,
} from '@dnsquared/shipper-core';
import type { AgentName, CommandMode } from '@dnsquared/shipper-core';
import type { StageRunResult } from './stage-result.js';
import { printAutoSummary, type AutoResult } from './ship-auto.js';

export interface GroomOptions {
  auto: boolean;
  mode?: CommandMode;
  agent?: AgentName;
  model?: string;
  disableMcp?: boolean;
}

export async function runGroomStage(
  repo: string,
  issueStr: string,
  mode?: CommandMode,
  agent?: AgentName,
  model?: string,
  disableMcp?: boolean
): Promise<StageRunResult> {
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
          async (wtPath) => {
            await scrubOutputDir(wtPath);
            const desktopControlDir = resolveDesktopControlDir();
            if (desktopControlDir) {
              await writeDesktopControlState(desktopControlDir, {
                stage: 'groom',
                worktreePath: wtPath,
                outputDir: path.resolve(wtPath, PROTOCOL_OUTPUT_DIR),
              });
            }

            const processGroomOutput = async (allowRetry: boolean): Promise<number> => {
              try {
                const result = allowRetry
                  ? await retryOnInvalidOutput({
                      cwd: wtPath,
                      stage: 'groom',
                      retry: (userInput) =>
                        runPrompt('groom', {
                          repo,
                          issueRef: issueStr,
                          cwd: wtPath,
                          mode,
                          agent,
                          model,
                          disableMcp,
                          userInput,
                        }),
                    })
                  : await validateStageOutput(wtPath, 'groom');

                await processGroomResult({ repo, issueNumber: issueStr, cwd: wtPath, result });
                return 0;
              } catch (error) {
                const detail = toErrorMessage(error);
                logger.error(detail);
                if (!(error instanceof GroomPostFlightError) || !error.failureCommentPosted) {
                  await handleAgentCrash(repo, issueStr, 'groom', detail);
                }
                return 1;
              }
            };

            const exitCode = await runPrompt('groom', {
              repo,
              issueRef: issueStr,
              cwd: wtPath,
              mode,
              agent,
              model,
              disableMcp,
            });

            if (exitCode !== 0) {
              const desktopFinalizeRequested =
                desktopControlDir !== null && (await isDesktopFinalizeRequested(desktopControlDir));
              if (desktopFinalizeRequested) {
                return await processGroomOutput(false);
              }

              const detail = `Agent exited with code ${exitCode}`;
              logger.error(detail);
              await handleAgentCrash(
                repo,
                issueStr,
                'groom',
                detail,
                `The \`groom\` agent run exited with code ${exitCode}.`
              );
              return 1;
            }

            return await processGroomOutput(true);
          }
        )
    );
  });
  return code === 0
    ? { success: true, exitCode: 0 }
    : {
        success: false,
        exitCode: code,
        error: `Agent exited with code ${code}`,
      };
}

export async function groomCommand(
  repo: string,
  issue?: string,
  options: GroomOptions = { auto: false }
): Promise<void> {
  const effectiveMode = resolveMode('groom', options.mode);
  const mcpGroomingEnabled = isMcpGroomingEnabled();
  if (effectiveMode === 'headless' && !mcpGroomingEnabled) {
    throw new Error(
      'Error: groom does not support headless mode. Grooming requires interactive input.'
    );
  }
  if (effectiveMode !== 'headless') {
    const stdin = Reflect.get(process, 'stdin') as ReadStream | undefined;
    if (!stdin?.isTTY) {
      throw new Error('Error: shipper groom requires an interactive terminal. stdin is not a TTY.');
    }
  }

  if (options.auto) {
    const results: AutoResult[] = [];

    for (;;) {
      const candidate = await autoSelectIssue(repo, 'shipper:new');
      if (!candidate) break;

      logger.log(`\nAuto: grooming issue #${candidate.number} — ${candidate.title}`);
      const result = await runGroomStage(
        repo,
        String(candidate.number),
        options.mode,
        options.agent,
        options.model,
        options.disableMcp
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

  process.exitCode = (
    await runGroomStage(repo, issue, options.mode, options.agent, options.model, options.disableMcp)
  ).exitCode;
}
