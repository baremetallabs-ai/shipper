import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  BLOCKED_LABEL,
  DISPLAY_NAME_MAP,
  FAILED_LABEL,
  LOCKED_LABEL,
  NEW_LABEL,
  STAGE_LABEL_NAMES,
  classifyChecks,
  fetchChecks,
  fetchIssue,
  getSettings,
  gh,
  isLockStale,
  listIssues,
  parseIssueLabelsState,
  parseIssueTitleLabelsList,
  releaseIssueLock,
  tryResolvePrForIssue,
} from '@dnsquared/shipper-core';
import {
  formatSpawnResult,
  formatToolError,
  spawnShipper,
  type ToolTextResult,
} from './helpers.js';

const STAGE_SHORT_NAMES = STAGE_LABEL_NAMES.map((l) => l.replace(/^shipper:/, ''));
const STATUS_FILTER_VALUES = [...STAGE_SHORT_NAMES, 'blocked', 'failed'] as const;

const FIVE_MINUTES_MS = 5 * 60 * 1000;

function textOk(text: string): ToolTextResult {
  return { content: [{ type: 'text', text }] };
}

function issueSchema(): z.ZodNumber {
  return z.number().int().positive();
}

function agentTimeoutMs(): number {
  const minutes = getSettings().agentTimeoutMinutes;
  if (!minutes || minutes <= 0) {
    return 24 * 60 * 60 * 1000;
  }
  return minutes * 60 * 1000;
}

type GhIssueLabelsOnly = ReturnType<typeof parseIssueTitleLabelsList>[number];

async function listShipperIssuesRaw(repo: string): Promise<GhIssueLabelsOnly[]> {
  const searchLabels = [...STAGE_LABEL_NAMES, BLOCKED_LABEL, FAILED_LABEL].join(',');
  const { stdout } = await gh([
    'issue',
    'list',
    '-R',
    repo,
    '--state',
    'open',
    '--search',
    `label:${searchLabels}`,
    '--limit',
    '1000',
    '--json',
    'number,title,labels',
  ]);
  return parseIssueTitleLabelsList(stdout);
}

function renderIssueList(issues: GhIssueLabelsOnly[], statusFilter: string | undefined): string {
  const isControlFilter = statusFilter === 'blocked' || statusFilter === 'failed';
  const stageFilter = statusFilter && !isControlFilter ? `shipper:${statusFilter}` : undefined;

  const groups = new Map<string, GhIssueLabelsOnly[]>();
  for (const label of STAGE_LABEL_NAMES) {
    groups.set(label, []);
  }

  for (const issue of issues) {
    const labelNames = issue.labels.map((l) => l.name);
    const bestIndex = STAGE_LABEL_NAMES.findLastIndex((l) => labelNames.includes(l));
    if (bestIndex >= 0) {
      const label = STAGE_LABEL_NAMES[bestIndex];
      if (label) groups.get(label)?.push(issue);
    }
  }

  for (const group of groups.values()) {
    group.sort((a, b) => a.number - b.number);
  }

  const blocked: { issue: GhIssueLabelsOnly; stageLabel?: string }[] = [];
  const failed: { issue: GhIssueLabelsOnly; stageLabel?: string }[] = [];

  for (const [label, group] of groups) {
    for (let i = group.length - 1; i >= 0; i -= 1) {
      const issue = group[i];
      if (!issue) continue;
      const labelNames = issue.labels.map((l) => l.name);
      if (labelNames.includes(FAILED_LABEL)) {
        failed.push({ issue, stageLabel: label });
        group.splice(i, 1);
      } else if (labelNames.includes(BLOCKED_LABEL)) {
        blocked.push({ issue, stageLabel: label });
        group.splice(i, 1);
      }
    }
  }

  for (const issue of issues) {
    const labelNames = issue.labels.map((l) => l.name);
    const hasStage = STAGE_LABEL_NAMES.some((l) => labelNames.includes(l));
    if (hasStage) continue;
    if (labelNames.includes(FAILED_LABEL)) {
      failed.push({ issue });
    } else if (labelNames.includes(BLOCKED_LABEL)) {
      blocked.push({ issue });
    }
  }

  blocked.sort((a, b) => a.issue.number - b.issue.number);
  failed.sort((a, b) => a.issue.number - b.issue.number);

  const lines: string[] = [];

  if (!isControlFilter) {
    const labelsToShow = stageFilter ? [stageFilter] : [...STAGE_LABEL_NAMES];
    for (const label of labelsToShow) {
      const group = groups.get(label);
      if (!group || group.length === 0) continue;
      lines.push(`\n${DISPLAY_NAME_MAP[label] ?? label} (${group.length})`);
      for (const issue of group) {
        const lockedSuffix = issue.labels.some((l) => l.name === LOCKED_LABEL) ? ' [locked]' : '';
        lines.push(`  #${issue.number} ${issue.title}${lockedSuffix}`);
      }
    }
  }

  function renderControl(heading: string, items: typeof blocked): void {
    const filtered = stageFilter ? items.filter((i) => i.stageLabel === stageFilter) : items;
    if (filtered.length === 0) return;
    lines.push(`\n${heading} (${filtered.length})`);
    for (const { issue, stageLabel } of filtered) {
      const stageSuffix = stageLabel ? ` [${stageLabel.replace('shipper:', '')}]` : '';
      const lockedSuffix = issue.labels.some((l) => l.name === LOCKED_LABEL) ? ' [locked]' : '';
      lines.push(`  #${issue.number} ${issue.title}${stageSuffix}${lockedSuffix}`);
    }
  }

  if (statusFilter !== 'failed') renderControl('Blocked', blocked);
  if (statusFilter !== 'blocked') renderControl('Failed', failed);

  const out = lines.join('\n').trim();
  return out.length === 0 ? 'No shipper-managed issues found.' : out;
}

type GhIssueLabelsState = ReturnType<typeof parseIssueLabelsState>;

async function fetchIssueLabels(repo: string, issue: number): Promise<GhIssueLabelsState> {
  const { stdout } = await gh([
    'issue',
    'view',
    String(issue),
    '-R',
    repo,
    '--json',
    'number,state,labels',
  ]);
  return parseIssueLabelsState(stdout.trim());
}

const GROOM_MANUAL_MESSAGE =
  'Grooming must be done interactively by a human (it asks clarifying questions and edits the issue body). Ask the user to run `shipper groom <issue>` in their terminal; once the issue moves past `shipper:new`, you can retry this tool.';

async function assertNotAtNew(repo: string, issue: number): Promise<void> {
  const data = await fetchIssueLabels(repo, issue);
  const names = data.labels.map((l) => l.name);
  if (names.includes(NEW_LABEL)) {
    throw new Error(`Issue #${issue} is at ${NEW_LABEL}. ${GROOM_MANUAL_MESSAGE}`);
  }
}

async function isPullRequest(repo: string, ref: number): Promise<boolean> {
  try {
    await gh(['pr', 'view', String(ref), '-R', repo, '--json', 'number,url']);
    return true;
  } catch {
    return false;
  }
}

function renderChecks(repo: string, pr: number, checks: ReturnType<typeof classifyChecks>): string {
  const header = `Checks for ${repo}#${pr}: ${checks.passed.length} passed, ${checks.pending.length} pending, ${checks.failed.length} failed (total: ${checks.total})`;
  if (checks.failed.length === 0 && checks.pending.length === 0) return header;
  const lines = [header];
  if (checks.pending.length > 0) {
    lines.push('\nPending:');
    for (const c of checks.pending) lines.push(`  - ${c.name}${c.link ? ` (${c.link})` : ''}`);
  }
  if (checks.failed.length > 0) {
    lines.push('\nFailed:');
    for (const c of checks.failed) lines.push(`  - ${c.name}${c.link ? ` (${c.link})` : ''}`);
  }
  return lines.join('\n');
}

export function registerTools(server: McpServer, repo: string): void {
  server.registerTool(
    'shipper_list_issues',
    {
      description:
        'List shipper-managed issues grouped by workflow stage. Includes blocked and failed sections. Optional status filter restricts output to a single stage (new/groomed/designed/planned/implemented/pr-open/pr-reviewed/ready) or control label (blocked/failed).',
      inputSchema: {
        status: z.enum(STATUS_FILTER_VALUES as unknown as [string, ...string[]]).optional(),
      },
    },
    async ({ status }) => {
      try {
        const issues = await listShipperIssuesRaw(repo);
        return textOk(renderIssueList(issues, status));
      } catch (err) {
        return formatToolError(err);
      }
    }
  );

  server.registerTool(
    'shipper_get_issue',
    {
      description:
        'Get detailed information about a specific issue: title, body, labels, state, author, and (if one exists) the linked open PR number.',
      inputSchema: { issue: issueSchema() },
    },
    async ({ issue }) => {
      try {
        const xml = await fetchIssue(repo, String(issue));
        const pr = await tryResolvePrForIssue(repo, issue);
        const suffix = pr ? `\n\n<linked-pr number="${pr}"/>` : '';
        return textOk(`${xml}${suffix}`);
      } catch (err) {
        return formatToolError(err);
      }
    }
  );

  server.registerTool(
    'shipper_get_pr_checks',
    {
      description:
        'Get the CI check status for a pull request: counts and details for failed/pending checks.',
      inputSchema: { pr: issueSchema() },
    },
    async ({ pr }) => {
      try {
        const raw = await fetchChecks(repo, String(pr));
        const classified = classifyChecks(raw);
        return textOk(renderChecks(repo, pr, classified));
      } catch (err) {
        return formatToolError(err);
      }
    }
  );

  server.registerTool(
    'shipper_advance',
    {
      description:
        'Advance an issue by one workflow stage (shipper next). Dispatches to the appropriate stage command based on the current label. Runs in headless mode — may take several minutes for implementation and PR review stages. Refuses to operate on `shipper:new` issues because grooming requires interactive input.',
      inputSchema: { issue: issueSchema() },
    },
    async ({ issue }) => {
      try {
        await assertNotAtNew(repo, issue);
        const args = ['next', String(issue), '--mode', 'headless'];
        const result = await spawnShipper(args, { timeoutMs: agentTimeoutMs() });
        return formatSpawnResult(result, `shipper ${args.join(' ')}`);
      } catch (err) {
        return formatToolError(err);
      }
    }
  );

  server.registerTool(
    'shipper_create_issue',
    {
      description:
        'Create a new GitHub issue from a plain-text request. Spawns `shipper new <request> --mode headless`, which runs an agent to research the codebase and draft an issue tagged `shipper:new`. Requires a non-empty request.',
      inputSchema: { request: z.string().min(1) },
    },
    async ({ request }) => {
      try {
        const args = ['new', request, '--mode', 'headless'];
        const result = await spawnShipper(args, { timeoutMs: agentTimeoutMs() });
        return formatSpawnResult(result, `shipper new <request> --mode headless`);
      } catch (err) {
        return formatToolError(err);
      }
    }
  );

  server.registerTool(
    'shipper_unblock',
    {
      description:
        'Attempt to unblock a blocked issue (shipper:blocked label). Runs the unblock prompt to check if the blocker is resolved. Headless mode.',
      inputSchema: { issue: issueSchema() },
    },
    async ({ issue }) => {
      try {
        const args = ['unblock', String(issue), '--mode', 'headless'];
        const result = await spawnShipper(args, { timeoutMs: agentTimeoutMs() });
        return formatSpawnResult(result, `shipper ${args.join(' ')}`);
      } catch (err) {
        return formatToolError(err);
      }
    }
  );

  server.registerTool(
    'shipper_merge',
    {
      description:
        'Run the merge queue once for shipper:ready PRs. If an issue number is provided, merges only that PR; otherwise processes all ready PRs. Always runs --once (never polls).',
      inputSchema: { issue: issueSchema().optional() },
    },
    async ({ issue }) => {
      try {
        const args = ['merge', '--once'];
        if (issue !== undefined) args.splice(1, 0, String(issue));
        const result = await spawnShipper(args, { timeoutMs: FIVE_MINUTES_MS });
        return formatSpawnResult(result, `shipper ${args.join(' ')}`);
      } catch (err) {
        return formatToolError(err);
      }
    }
  );

  server.registerTool(
    'shipper_unlock',
    {
      description:
        "Release an issue lock. With issue: release that issue's lock. With stale=true: sweep all stale locks across the repo. Exactly one of issue or stale must be provided.",
      inputSchema: { issue: issueSchema().optional(), stale: z.boolean().optional() },
    },
    async ({ issue, stale }) => {
      try {
        if (stale && issue !== undefined) {
          throw new Error('Provide either `issue` or `stale`, not both.');
        }
        if (!stale && issue === undefined) {
          throw new Error('Provide either `issue` or `stale: true`.');
        }

        if (stale) {
          const locked = await listIssues(repo, { label: LOCKED_LABEL });
          if (locked.length === 0) return textOk('No stale locks found.');
          const lines: string[] = [];
          let released = 0;
          let skipped = 0;
          for (const lockedIssue of locked) {
            const issueStr = String(lockedIssue.number);
            if (await isLockStale(repo, issueStr)) {
              await releaseIssueLock(repo, issueStr);
              lines.push(`#${issueStr}: stale — released`);
              released += 1;
            } else {
              lines.push(`#${issueStr}: active — skipped`);
              skipped += 1;
            }
          }
          lines.push(
            released === 0
              ? 'No stale locks found.'
              : `Released ${released} stale lock(s) (${skipped} active lock(s) skipped).`
          );
          return textOk(lines.join('\n'));
        }

        await releaseIssueLock(repo, String(issue));
        return textOk(`Released lock on #${issue}.`);
      } catch (err) {
        return formatToolError(err);
      }
    }
  );

  server.registerTool(
    'shipper_adopt',
    {
      description:
        'Adopt an existing GitHub issue into the shipper workflow by adding the shipper:new label. Fails if the target is a PR or already has a shipper label.',
      inputSchema: { issue: issueSchema() },
    },
    async ({ issue }) => {
      try {
        if (await isPullRequest(repo, issue)) {
          throw new Error(`#${issue} is a pull request, not an issue.`);
        }
        const data = await fetchIssueLabels(repo, issue);
        const shipperLabels = data.labels
          .map((l) => l.name)
          .filter((n) => n.startsWith('shipper:'));
        if (shipperLabels.length > 0) {
          return textOk(
            `Issue #${issue} already has shipper label(s): ${shipperLabels.join(', ')}. No changes made.`
          );
        }
        await gh(['issue', 'edit', String(issue), '-R', repo, '--add-label', 'shipper:new']);
        return textOk(`Issue #${issue} adopted into shipper workflow.`);
      } catch (err) {
        return formatToolError(err);
      }
    }
  );
}

export function registerInitErrorTools(server: McpServer, error: unknown): void {
  const names = [
    'shipper_list_issues',
    'shipper_get_issue',
    'shipper_get_pr_checks',
    'shipper_advance',
    'shipper_create_issue',
    'shipper_unblock',
    'shipper_merge',
    'shipper_unlock',
    'shipper_adopt',
  ];
  for (const name of names) {
    server.registerTool(
      name,
      {
        description: 'Shipper MCP server failed to initialize. See error details.',
        inputSchema: {},
      },
      () => formatToolError(error)
    );
  }
}
