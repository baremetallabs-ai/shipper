import type { AgentName, CommandMode } from '@dnsquared/shipper-core';
import {
  fetchIssue,
  gh,
  handleAgentCrash,
  processResult,
  runPrompt,
  scrubOutputDir,
  setupProtocolDirs,
  withIssueLock,
  writeContextFile,
} from '@dnsquared/shipper-core';

interface DependencyIssueData {
  title: string;
  state: string;
}

interface DependencyPrData {
  title: string;
  state: string;
  mergedAt: string | null;
}

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
      let issue: DependencyIssueData;
      try {
        const issueResult = await gh(['issue', 'view', ref, '-R', repo, '--json', 'state,title']);
        issue = JSON.parse(issueResult.stdout) as DependencyIssueData;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return [
          `## #${ref}`,
          '- **Type**: Unknown',
          '- **Title**: Unable to fetch dependency',
          `- **Detail**: ${detail}`,
        ].join('\n');
      }

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
        const pr = JSON.parse(prResult.stdout) as DependencyPrData;
        const state = pr.mergedAt ? `MERGED (merged ${pr.mergedAt.slice(0, 10)})` : pr.state;

        return [
          `## #${ref}`,
          '- **Type**: PR',
          `- **Title**: ${pr.title}`,
          `- **State**: ${state}`,
        ].join('\n');
      } catch {
        return [
          `## #${ref}`,
          '- **Type**: Issue',
          `- **Title**: ${issue.title}`,
          `- **State**: ${issue.state}`,
        ].join('\n');
      }
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
  model?: string
): Promise<void> {
  if (!issue) {
    console.error('Error: Please provide an issue number.');
    console.error('Usage: shipper unblock <issue>');
    process.exit(1);
  }

  await withIssueLock(repo, issue, async () => {
    const cwd = process.cwd();
    await scrubOutputDir(cwd);
    await prepareUnblockContext(repo, issue, cwd);
    await runPrompt('unblock', { repo, issueRef: issue, mode, agent, model });
    try {
      await processResult({ repo, issueNumber: issue, stage: 'unblock', cwd });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await handleAgentCrash(repo, issue, 'unblock', detail);
      process.exitCode = 1;
      return;
    }
  });
}
