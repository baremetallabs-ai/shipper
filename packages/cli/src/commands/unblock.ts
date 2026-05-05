import type { AgentName, CommandMode } from '@baremetallabs-ai/shipper-core';
import {
  logger,
  parseIssueStateTitle,
  parsePrStateMergedTitle,
  fetchIssue,
  gh,
  handleAgentCrash,
  processResult,
  retryOnInvalidOutput,
  runPrompt,
  scrubOutputDir,
  setupProtocolDirs,
  toErrorMessage,
  withIssueLock,
  writeContextFile,
} from '@baremetallabs-ai/shipper-core';

function extractIssueRefs(issueXml: string, issueStr: string): string[] {
  const refs = new Set<string>();
  for (const match of issueXml.matchAll(/\B#(\d+)\b/g)) {
    const ref = match[1];
    if (!ref || ref === issueStr) {
      continue;
    }
    refs.add(ref);
  }

  return [...refs];
}

async function fetchDependencyStates(repo: string, refs: string[]): Promise<string> {
  const sections = await Promise.all(
    refs.map(async (ref) => {
      let issueStdout = '';
      try {
        const issueResult = await gh(['issue', 'view', ref, '-R', repo, '--json', 'state,title']);
        issueStdout = issueResult.stdout;
      } catch (error) {
        return [
          `## #${ref}`,
          '- **Type**: Unknown',
          '- **Title**: Unable to fetch dependency',
          `- **Detail**: ${toErrorMessage(error)}`,
        ].join('\n');
      }
      const issue = parseIssueStateTitle(issueStdout);

      let prStdout = '';
      try {
        const prResult = await gh([
          'pr',
          'view',
          ref,
          '-R',
          repo,
          '--json',
          'state,mergedAt,title',
        ]);
        prStdout = prResult.stdout;
      } catch {
        // Not a PR — render as issue instead.
        return [
          `## #${ref}`,
          '- **Type**: Issue',
          `- **Title**: ${issue.title}`,
          `- **State**: ${issue.state}`,
        ].join('\n');
      }

      const pr = parsePrStateMergedTitle(prStdout);
      const state = pr.mergedAt ? `MERGED (merged ${pr.mergedAt.slice(0, 10)})` : pr.state;

      return [
        `## #${ref}`,
        '- **Type**: PR',
        `- **Title**: ${pr.title}`,
        `- **State**: ${state}`,
      ].join('\n');
    })
  );

  return ['# Dependency Status', '', ...sections.flatMap((section) => [section, ''])].join('\n');
}

export async function prepareUnblockContext(
  repo: string,
  issueStr: string,
  cwd: string
): Promise<void> {
  const issueXml = await fetchIssue(repo, issueStr);
  const refs = extractIssueRefs(issueXml, issueStr);
  const depInfo = await fetchDependencyStates(repo, refs);
  await setupProtocolDirs(cwd);
  await writeContextFile(cwd, 'dependencies.md', depInfo);
}

export async function unblockCommand(
  repo: string,
  issue: string,
  mode?: CommandMode,
  agent?: AgentName,
  model?: string,
  disableMcp?: boolean
): Promise<void> {
  if (!issue) {
    logger.error('Usage: shipper unblock <issue>');
    throw new Error('Error: Please provide an issue number.');
  }

  await withIssueLock(repo, issue, async () => {
    const cwd = process.cwd();
    await scrubOutputDir(cwd);
    await prepareUnblockContext(repo, issue, cwd);
    const exitCode = await runPrompt('unblock', {
      repo,
      issueRef: issue,
      cwd,
      mode,
      agent,
      model,
      disableMcp,
    });
    if (exitCode !== 0) {
      const detail = `Agent exited with code ${exitCode}`;
      logger.error(detail);
      await handleAgentCrash(
        repo,
        issue,
        'unblock',
        detail,
        `The \`unblock\` agent run exited with code ${exitCode}.`
      );
      process.exitCode = 1;
      return;
    }
    try {
      const result = await retryOnInvalidOutput({
        cwd,
        stage: 'unblock',
        retry: (userInput) =>
          runPrompt('unblock', {
            repo,
            issueRef: issue,
            cwd,
            mode,
            agent,
            model,
            disableMcp,
            userInput,
          }),
      });
      await processResult({ repo, issueNumber: issue, stage: 'unblock', cwd, result });
    } catch (error) {
      const detail = toErrorMessage(error);
      logger.error(detail);
      await handleAgentCrash(repo, issue, 'unblock', detail);
      process.exitCode = 1;
      return;
    }
  });
}
