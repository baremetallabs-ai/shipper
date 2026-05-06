import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  BLOCKED_LABEL,
  DISPLAY_NAME_MAP,
  executeReset,
  FAILED_LABEL,
  LOCKED_LABEL,
  NEW_LABEL,
  STAGE_LABEL_NAMES,
  classifyChecks,
  extractFinalMessage,
  fetchChecks,
  fetchIssue,
  findLatestSessionMeta,
  getCurrentStage,
  getSettings,
  getStageIndex,
  getStageLabel,
  getWorktreeRepoName,
  gh,
  isClean,
  isLockStale,
  MCP_GROOMING_FLAG,
  isMcpGroomingEnabled,
  listIssues,
  parseIssueLabelsState,
  parseIssueTitleLabelsList,
  readNewResultFile,
  readResultFile,
  releaseIssueLock,
  resolveSessionRepo,
  scanArtifacts,
  SHIPPER_SESSION_RUN_ID_ENV,
  toErrorMessage,
  tryResolvePrForIssue,
} from '@baremetallabs-ai/shipper-core';
import {
  formatAdvanceResult,
  formatCreateIssueResult,
  formatResetPreview,
  formatResetResult,
  formatSpawnResult,
  formatToolError,
  formatUnblockResult,
  INVALID_CREATED_ISSUE_RESULT_DETAIL,
  MISSING_CREATE_ISSUE_SESSION_METADATA_DETAIL,
  MISSING_CREATED_ISSUE_RESULT_FILE_DETAIL,
  spawnShipper,
  startShipper,
  type ShipperRunner,
  type ToolTextResult,
} from './helpers.js';
import { buildDocsCorpus, type DocsCorpus, type DocsSearchMatch } from './docs/corpus.js';

const STAGE_SHORT_NAMES = STAGE_LABEL_NAMES.map((l) => l.replace(/^shipper:/, ''));
const STATUS_FILTER_VALUES = [...STAGE_SHORT_NAMES, 'blocked', 'failed'] as const;
const RESET_TARGET_VALUES = ['new', 'groomed', 'designed', 'planned', 'implemented'] as const;

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const STAGE_FOR_LABEL = {
  'shipper:new': 'groom',
  'shipper:groomed': 'design',
  'shipper:designed': 'plan',
  'shipper:planned': 'implement',
  'shipper:implemented': 'pr_open',
  'shipper:pr-open': 'pr_review',
  'shipper:pr-reviewed': 'pr_remediate',
} as const;
type AdvanceStageName = (typeof STAGE_FOR_LABEL)[keyof typeof STAGE_FOR_LABEL];
type AdvanceVerdict = 'accept' | 'reject' | 'fail';

export const toolNames = [
  'shipper_list_issues',
  'shipper_get_issue',
  'shipper_get_pr_checks',
  'shipper_docs_search',
  'shipper_docs_get',
  'shipper_advance',
  'shipper_groom',
  'shipper_create_issue',
  'shipper_unblock',
  'shipper_merge',
  'shipper_unlock',
  'shipper_reset',
  'shipper_adopt',
  'shipper_answer_question',
] as const;

export type ToolName = (typeof toolNames)[number];

type McpInputSchema = ZodRawShapeCompat;
type McpToolContext = { docsCorpus: DocsCorpus };

export type McpToolDefinition<InputSchema extends McpInputSchema = McpInputSchema> = {
  name: ToolName;
  description: string;
  inputSchema: InputSchema;
  annotations?: ToolAnnotations;
  experimental?: { flag: typeof MCP_GROOMING_FLAG; enabled: () => boolean };
  createHandler: (repo: string, context: McpToolContext) => ToolCallback<InputSchema>;
};

function defineTool<const InputSchema extends McpInputSchema>(
  definition: McpToolDefinition<InputSchema>
): McpToolDefinition<InputSchema> {
  return definition;
}

function textOk(text: string): ToolTextResult {
  return { content: [{ type: 'text', text }] };
}

function formatDocsSearchMatches(matches: DocsSearchMatch[]): string {
  return matches
    .map((match, index) =>
      [
        `Match ${index + 1}`,
        `path: ${match.path}`,
        `title: ${match.title}`,
        `score: ${match.score.toFixed(2)}`,
        `snippet: ${match.snippet}`,
      ].join('\n')
    )
    .join('\n\n');
}

interface PendingSession {
  runner: ShipperRunner;
  /** What the shipper child was originally asked to do — used for log/diagnostic context. */
  originatingTool: string;
  /** Issue number (if applicable) — restored into formatAdvanceResult on completion. */
  issue?: number;
  /** Repo the originating call was made against. */
  repo: string;
  /** Args passed to the original shipper invocation (for replay if ever needed). */
  args: string[];
  /** Pre-stage label captured before spawn so post-completion can reconstruct outcome. */
  preStageLabel?: string | null;
  /** Started-at timestamp for session log resolution on completion. */
  startedAt: Date;
  /** Repo slug for session log resolution. */
  repoSlug: string;
}

const pendingSessions = new Map<string, PendingSession>();

export function getPendingSession(sessionId: string): PendingSession | undefined {
  return pendingSessions.get(sessionId);
}

function clearPendingSession(sessionId: string): void {
  pendingSessions.delete(sessionId);
}

function formatAwaitingAnswer(payload: {
  sessionId: string;
  questions: unknown[];
  toolUseId?: string;
}): ToolTextResult {
  // Strip the worker's suggested options/labels before showing questions to the
  // orchestrator. The worker's options bias the answer (and tend to skew lazy);
  // the orchestrator should investigate and answer freely. The bridge accepts
  // free-text answers, so the orchestrator never needs to see the option list.
  const sanitizedQuestions = sanitizeQuestionsForOrchestrator(payload.questions);
  const text = [
    'Status: awaiting_answer',
    `Session: ${payload.sessionId}`,
    payload.toolUseId ? `Tool use id: ${payload.toolUseId}` : undefined,
    '',
    'The headless worker called AskUserQuestion and is paused awaiting answers from the orchestrator.',
    'Reply with `shipper_answer_question` providing { session_id, answers } where answers is a map',
    'of question text -> your answer (free text). Investigate the codebase / context yourself before',
    'answering — do not rely on the worker for option lists; they have been stripped intentionally',
    'so your answer is unbiased.',
    '',
    'Questions (JSON):',
    JSON.stringify(sanitizedQuestions, null, 2),
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
  return { content: [{ type: 'text', text }] };
}

function sanitizeQuestionsForOrchestrator(questions: unknown[]): unknown[] {
  return questions.map((q) => {
    if (!q || typeof q !== 'object') return q;
    const obj = q as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    if (typeof obj.question === 'string') out.question = obj.question;
    if (typeof obj.header === 'string') out.header = obj.header;
    return out;
  });
}

function issueSchema(): z.ZodNumber {
  return z.number().int().positive().describe('GitHub issue number.');
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

function findCurrentStageLabel(labels: string[]): string | undefined {
  return STAGE_LABEL_NAMES.findLast((label) => labels.includes(label));
}

function parseAdvanceStage(stageLabel: string | undefined): AdvanceStageName | undefined {
  return stageLabel ? STAGE_FOR_LABEL[stageLabel as keyof typeof STAGE_FOR_LABEL] : undefined;
}

async function resolveSessionContext(opts: {
  repoSlug: string;
  issue: string;
  stage: string;
  since: Date;
  runId?: string;
}): Promise<{ finalMessage?: string; sessionLogPath?: string; resultFile?: string }> {
  const meta = await findLatestSessionMeta(opts);
  if (!meta) {
    return {};
  }

  const resultFile = typeof meta.resultFile === 'string' ? meta.resultFile : undefined;
  if (!meta.logFile) {
    return { resultFile };
  }

  const agent = toAgentName(meta.agent);
  const finalMessage = agent ? await extractFinalMessage(agent, meta.logFile) : undefined;
  return {
    finalMessage,
    sessionLogPath: meta.logFile,
    resultFile,
  };
}

function toAgentName(agent: string): 'claude' | 'codex' | 'copilot' | undefined {
  return agent === 'claude' || agent === 'codex' || agent === 'copilot' ? agent : undefined;
}

function summarizeCommentBody(body: string): string {
  const beforeFeedback = body.split(/\n## Agent Feedback\b/, 1)[0] ?? body;
  const cleanedLines = beforeFeedback
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  const firstParagraph = cleanedLines
    .join('\n')
    .split(/\n\s*\n/, 1)[0]
    ?.trim();
  return firstParagraph ? firstParagraph.replace(/\s+/g, ' ') : '<not recorded>';
}

async function readUnblockReason(commentPath: string | undefined): Promise<string> {
  if (!commentPath) {
    return '<not recorded>';
  }

  try {
    const content = await readFile(path.resolve(process.cwd(), commentPath), 'utf-8');
    return summarizeCommentBody(content);
  } catch {
    return '<not recorded>';
  }
}

function resolveAdvanceOutcome(
  preStageLabel: string | undefined,
  postLabels: string[]
): { from: string; to: string; verdict: AdvanceVerdict } | undefined {
  if (!preStageLabel) {
    return undefined;
  }

  const stage = parseAdvanceStage(preStageLabel);
  if (!stage) {
    return undefined;
  }

  const transitionTargets = {
    groom: { accept: 'shipper:groomed', reject: 'shipper:new' },
    design: { accept: 'shipper:designed', reject: 'shipper:new' },
    plan: { accept: 'shipper:planned', reject: 'shipper:groomed' },
    implement: { accept: 'shipper:implemented', reject: 'shipper:designed' },
    pr_open: { accept: 'shipper:pr-open', reject: 'shipper:planned' },
    pr_review: { accept: 'shipper:pr-reviewed', reject: 'shipper:implemented' },
    pr_remediate: { accept: 'shipper:ready', reject: 'shipper:pr-open' },
  } as const;
  const transition = transitionTargets[stage];

  if (postLabels.includes(transition.accept)) {
    return { from: preStageLabel, to: transition.accept, verdict: 'accept' };
  }

  if (postLabels.includes(transition.reject)) {
    return { from: preStageLabel, to: transition.reject, verdict: 'reject' };
  }

  if (postLabels.includes(FAILED_LABEL)) {
    return { from: preStageLabel, to: FAILED_LABEL, verdict: 'fail' };
  }

  return undefined;
}

function resolveNoopAdvanceOutcome(
  preStageLabel: string | undefined,
  result: { exitCode: number; timedOut: boolean }
): { from: string; to: string; verdict: string } | undefined {
  if (preStageLabel !== 'shipper:ready' || result.timedOut || result.exitCode !== 0) {
    return undefined;
  }

  return { from: preStageLabel, to: preStageLabel, verdict: 'noop' };
}

function mapUnblockVerdict(
  verdict: 'accept' | 'reject' | 'fail'
): 'unblocked' | 'still-blocked' | 'failed' {
  switch (verdict) {
    case 'accept':
      return 'unblocked';
    case 'reject':
      return 'still-blocked';
    case 'fail':
      return 'failed';
  }
}

function resolveUnblockVerdict(
  preLabels: string[],
  postLabels: string[]
): 'unblocked' | 'still-blocked' | 'failed' | undefined {
  if (postLabels.includes(FAILED_LABEL)) {
    return 'failed';
  }

  if (preLabels.includes(BLOCKED_LABEL) && !postLabels.includes(BLOCKED_LABEL)) {
    return 'unblocked';
  }

  if (postLabels.includes(BLOCKED_LABEL)) {
    return 'still-blocked';
  }

  return undefined;
}

function isPullRequestNotFoundError(error: unknown): boolean {
  const stderr =
    typeof error === 'object' &&
    error !== null &&
    'stderr' in error &&
    typeof error.stderr === 'string'
      ? error.stderr
      : '';
  const detail = `${toErrorMessage(error)}\n${stderr}`;
  return (
    /could not resolve to a pullrequest/i.test(detail) ||
    /no pull requests found/i.test(detail) ||
    /pull request.*not found/i.test(detail)
  );
}

async function isPullRequest(repo: string, ref: number): Promise<boolean> {
  try {
    await gh(['pr', 'view', String(ref), '-R', repo, '--json', 'number,url']);
    return true;
  } catch (error) {
    if (isPullRequestNotFoundError(error)) {
      return false;
    }

    throw error;
  }
}

function getResetRepoRoot(): string {
  return process.cwd();
}

function getResetScanOptions(
  repoRoot: string,
  repoName: string,
  dryRun: boolean
): {
  repoRoot: string;
  repoName: string;
  refreshRemoteRefs?: boolean;
} {
  return dryRun ? { repoRoot, repoName, refreshRemoteRefs: false } : { repoRoot, repoName };
}

function getResetExecutionOptions(repoRoot: string): { repoRoot: string } {
  return { repoRoot };
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

export const mcpToolDefinitions = [
  defineTool({
    name: 'shipper_list_issues',
    description:
      'List shipper-managed issues grouped by workflow stage. Includes blocked and failed sections. Optional status filter restricts output to a single stage (new/groomed/designed/planned/implemented/pr-open/pr-reviewed/ready) or control label (blocked/failed).',
    inputSchema: {
      status: z
        .enum(STATUS_FILTER_VALUES as unknown as [string, ...string[]])
        .optional()
        .describe('Workflow stage or control status to filter by.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    createHandler:
      (repo) =>
      async ({ status }) => {
        try {
          const issues = await listShipperIssuesRaw(repo);
          return textOk(renderIssueList(issues, status));
        } catch (err) {
          return formatToolError(err);
        }
      },
  }),
  defineTool({
    name: 'shipper_get_issue',
    description:
      'Get detailed information about a specific issue: title, body, labels, state, author, and (if one exists) the linked open PR number.',
    inputSchema: { issue: issueSchema() },
    annotations: { readOnlyHint: true, openWorldHint: true },
    createHandler:
      (repo) =>
      async ({ issue }) => {
        try {
          const xml = await fetchIssue(repo, String(issue));
          const pr = await tryResolvePrForIssue(repo, issue);
          const suffix = pr ? `\n\n<linked-pr number="${pr}"/>` : '';
          return textOk(`${xml}${suffix}`);
        } catch (err) {
          return formatToolError(err);
        }
      },
  }),
  defineTool({
    name: 'shipper_get_pr_checks',
    description:
      'Get the CI check status for a pull request: counts and details for failed/pending checks.',
    inputSchema: {
      pr: z.number().int().positive().describe('GitHub pull request number.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    createHandler:
      (repo) =>
      async ({ pr }) => {
        try {
          const raw = await fetchChecks(repo, String(pr));
          const classified = classifyChecks(raw);
          return textOk(renderChecks(repo, pr, classified));
        } catch (err) {
          return formatToolError(err);
        }
      },
  }),
  defineTool({
    name: 'shipper_docs_search',
    description:
      'Search the Shipper documentation corpus. Returns matching pages with relevance-ranked snippets so an agent can decide which page(s) to fetch in full.',
    inputSchema: {
      query: z.string().min(1),
      limit: z.number().int().positive().max(25).optional(),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    createHandler:
      (_repo, context) =>
      ({ query, limit }) => {
        try {
          const matches = context.docsCorpus.search(query, limit ?? 5);
          if (matches.length === 0) {
            return textOk(`No documentation matches found for query: ${JSON.stringify(query)}`);
          }
          return textOk(formatDocsSearchMatches(matches));
        } catch (err) {
          return formatToolError(err);
        }
      },
  }),
  defineTool({
    name: 'shipper_docs_get',
    description:
      'Fetch the full markdown content of a Shipper documentation page by its docs-site path.',
    inputSchema: { path: z.string().min(1) },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    createHandler:
      (_repo, context) =>
      ({ path }) => {
        try {
          const page = context.docsCorpus.get(path);
          return textOk(page.body);
        } catch (err) {
          return formatToolError(err);
        }
      },
  }),
  defineTool({
    name: 'shipper_advance',
    description:
      'Advance an issue by one workflow stage (shipper next). Dispatches to the appropriate stage command based on the current label. Runs in headless mode — may take several minutes for implementation and PR review stages. Refuses to operate on `shipper:new` issues because grooming requires interactive input.',
    inputSchema: { issue: issueSchema() },
    annotations: { openWorldHint: true },
    createHandler:
      (repo) =>
      async ({ issue }) => {
        try {
          const sessionRepo = await resolveSessionRepo({ repo });
          const preIssue = await fetchIssueLabels(repo, issue);
          const preLabels = preIssue.labels.map((label) => label.name);
          if (preLabels.includes(NEW_LABEL)) {
            throw new Error(`Issue #${issue} is at ${NEW_LABEL}. ${GROOM_MANUAL_MESSAGE}`);
          }

          const preStageLabel = findCurrentStageLabel(preLabels);
          const preStage = parseAdvanceStage(preStageLabel);
          const startedAt = new Date();
          const args = ['next', String(issue), '--mode', 'headless'];
          const runner = startShipper(args, { timeoutMs: agentTimeoutMs() });

          const event = await runner.next();
          if (event.kind === 'deferred') {
            pendingSessions.set(event.sessionId, {
              runner,
              originatingTool: 'shipper_advance',
              issue,
              repo,
              args,
              preStageLabel,
              startedAt,
              repoSlug: sessionRepo.repoSlug,
            });
            return formatAwaitingAnswer({
              sessionId: event.sessionId,
              questions: event.payload.questions,
              ...(event.payload.toolUseId !== undefined
                ? { toolUseId: event.payload.toolUseId }
                : {}),
            });
          }

          const result = event.result;
          const postIssue = await fetchIssueLabels(repo, issue);
          const postLabels = postIssue.labels.map((label) => label.name);
          const outcome =
            resolveAdvanceOutcome(preStageLabel, postLabels) ??
            resolveNoopAdvanceOutcome(preStageLabel, result);
          const sessionContext = preStage
            ? await resolveSessionContext({
                repoSlug: sessionRepo.repoSlug,
                issue: String(issue),
                stage: preStage,
                since: startedAt,
              })
            : {};
          const prNumber = await tryResolvePrForIssue(repo, issue);
          return formatAdvanceResult(
            result,
            outcome
              ? {
                  ...outcome,
                  prUrl: prNumber ? `https://github.com/${repo}/pull/${prNumber}` : undefined,
                }
              : undefined,
            {
              command: `shipper ${args.join(' ')}`,
              finalMessage: sessionContext.finalMessage,
              sessionLogPath: sessionContext.sessionLogPath,
            }
          );
        } catch (err) {
          return formatToolError(err);
        }
      },
  }),
  defineTool({
    name: 'shipper_groom',
    description:
      "Run grooming on a `shipper:new` issue in headless mode and bridge AskUserQuestion through MCP so the orchestrator answers the worker's clarifying questions via `shipper_answer_question`.",
    inputSchema: { issue: issueSchema() },
    annotations: { openWorldHint: true },
    experimental: { flag: MCP_GROOMING_FLAG, enabled: isMcpGroomingEnabled },
    createHandler:
      (repo) =>
      async ({ issue }) => {
        try {
          const sessionRepo = await resolveSessionRepo({ repo });
          const preIssue = await fetchIssueLabels(repo, issue);
          const preLabels = preIssue.labels.map((label) => label.name);
          if (!preLabels.includes(NEW_LABEL)) {
            throw new Error(
              `shipper_groom only operates on issues at ${NEW_LABEL}. Issue #${issue} has labels: ${preLabels.join(', ') || '(none)'}.`
            );
          }
          const startedAt = new Date();
          const args = ['groom', String(issue), '--mode', 'headless'];
          const runner = startShipper(args, { timeoutMs: agentTimeoutMs() });

          const event = await runner.next();
          if (event.kind === 'deferred') {
            pendingSessions.set(event.sessionId, {
              runner,
              originatingTool: 'shipper_groom',
              issue,
              repo,
              args,
              preStageLabel: NEW_LABEL,
              startedAt,
              repoSlug: sessionRepo.repoSlug,
            });
            return formatAwaitingAnswer({
              sessionId: event.sessionId,
              questions: event.payload.questions,
              ...(event.payload.toolUseId !== undefined
                ? { toolUseId: event.payload.toolUseId }
                : {}),
            });
          }

          const result = event.result;
          const postIssue = await fetchIssueLabels(repo, issue);
          const postLabels = postIssue.labels.map((label) => label.name);
          const outcome =
            resolveAdvanceOutcome(NEW_LABEL, postLabels) ??
            resolveNoopAdvanceOutcome(NEW_LABEL, result);
          const sessionContext = await resolveSessionContext({
            repoSlug: sessionRepo.repoSlug,
            issue: String(issue),
            stage: 'groom',
            since: startedAt,
          });
          return formatAdvanceResult(result, outcome, {
            command: `shipper ${args.join(' ')}`,
            finalMessage: sessionContext.finalMessage,
            sessionLogPath: sessionContext.sessionLogPath,
          });
        } catch (err) {
          return formatToolError(err);
        }
      },
  }),
  defineTool({
    name: 'shipper_create_issue',
    description:
      'Create a new GitHub issue from a plain-text request. Spawns `shipper new <request> --mode headless`, which runs an agent to research the codebase and draft an issue tagged `shipper:new`. Requires a non-empty request.',
    inputSchema: {
      request: z.string().min(1).describe('Plain-text request for the issue creation agent.'),
    },
    annotations: { openWorldHint: true },
    createHandler:
      (repo) =>
      async ({ request }) => {
        try {
          const sessionRepo = await resolveSessionRepo({ repo });
          const startedAt = new Date();
          const runId = randomUUID();
          const args = ['new', request, '--mode', 'headless'];
          const result = await spawnShipper(args, {
            timeoutMs: agentTimeoutMs(),
            env: { [SHIPPER_SESSION_RUN_ID_ENV]: runId },
          });
          const sessionContext = await resolveSessionContext({
            repoSlug: sessionRepo.repoSlug,
            issue: 'unlinked',
            stage: 'new',
            since: startedAt,
            runId,
          });
          let payload: { issueNumber: number; title: string; url: string } | undefined;
          let missingPayloadDetail: string | undefined;
          if (!result.timedOut && result.exitCode === 0) {
            if (sessionContext.resultFile) {
              try {
                const newResult = await readNewResultFile(sessionContext.resultFile);
                payload = {
                  issueNumber: newResult.created_issue.number,
                  title: newResult.created_issue.title,
                  url: newResult.created_issue.url,
                };
              } catch (error) {
                missingPayloadDetail = `${INVALID_CREATED_ISSUE_RESULT_DETAIL}\n${toErrorMessage(
                  error
                )}`;
              }
            } else {
              missingPayloadDetail = sessionContext.sessionLogPath
                ? MISSING_CREATED_ISSUE_RESULT_FILE_DETAIL
                : MISSING_CREATE_ISSUE_SESSION_METADATA_DETAIL;
            }
          }
          return formatCreateIssueResult(result, payload, {
            command: 'shipper new <request> --mode headless',
            finalMessage: sessionContext.finalMessage,
            sessionLogPath: sessionContext.sessionLogPath,
            missingPayloadDetail,
          });
        } catch (err) {
          return formatToolError(err);
        }
      },
  }),
  defineTool({
    name: 'shipper_unblock',
    description:
      'Attempt to unblock a blocked issue (shipper:blocked label). Runs the unblock prompt to check if the blocker is resolved. Headless mode.',
    inputSchema: { issue: issueSchema() },
    annotations: { openWorldHint: true, idempotentHint: true },
    createHandler:
      (repo) =>
      async ({ issue }) => {
        try {
          const sessionRepo = await resolveSessionRepo({ repo });
          const preIssue = await fetchIssueLabels(repo, issue);
          const preLabels = preIssue.labels.map((label) => label.name);
          const startedAt = new Date();
          const args = ['unblock', String(issue), '--mode', 'headless'];
          const result = await spawnShipper(args, { timeoutMs: agentTimeoutMs() });
          const postIssue = await fetchIssueLabels(repo, issue);
          const postLabels = postIssue.labels.map((label) => label.name);
          const sessionContext = await resolveSessionContext({
            repoSlug: sessionRepo.repoSlug,
            issue: String(issue),
            stage: 'unblock',
            since: startedAt,
          });

          let verdict = resolveUnblockVerdict(preLabels, postLabels);
          let reason = '<not recorded>';
          try {
            const output = await readResultFile(path.resolve(process.cwd(), '.shipper', 'output'));
            verdict = mapUnblockVerdict(output.verdict);
            reason = await readUnblockReason(output.comment);
          } catch {
            if (result.timedOut || result.exitCode !== 0) {
              verdict = undefined;
            }
          }

          return formatUnblockResult(result, verdict ? { verdict, reason } : undefined, {
            command: `shipper ${args.join(' ')}`,
            finalMessage: sessionContext.finalMessage,
            sessionLogPath: sessionContext.sessionLogPath,
          });
        } catch (err) {
          return formatToolError(err);
        }
      },
  }),
  defineTool({
    name: 'shipper_merge',
    description:
      'Run the merge queue once for shipper:ready PRs. If an issue number is provided, merges only that PR; otherwise processes all ready PRs. Always runs --once (never polls).',
    inputSchema: {
      issue: issueSchema().optional(),
    },
    annotations: { openWorldHint: true },
    createHandler:
      () =>
      async ({ issue }) => {
        try {
          const args = ['merge', '--once'];
          if (issue !== undefined) args.splice(1, 0, String(issue));
          const result = await spawnShipper(args, { timeoutMs: FIVE_MINUTES_MS });
          return formatSpawnResult(result, `shipper ${args.join(' ')}`);
        } catch (err) {
          return formatToolError(err);
        }
      },
  }),
  defineTool({
    name: 'shipper_unlock',
    description:
      "Release an issue lock. With issue: release that issue's lock. With stale=true: sweep all stale locks across the repo. Exactly one of issue or stale must be provided.",
    inputSchema: {
      issue: issueSchema().optional(),
      stale: z
        .boolean()
        .optional()
        .describe('When true, release every stale shipper lock in the repository.'),
    },
    annotations: { openWorldHint: true, idempotentHint: true },
    createHandler:
      (repo) =>
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
      },
  }),
  defineTool({
    name: 'shipper_reset',
    description:
      'Reset an issue back to an earlier workflow stage without shelling out to the CLI. Requires an explicit target stage. Supports dry-run preview mode and refuses fresh issue locks.',
    inputSchema: {
      issue: issueSchema(),
      target: z.enum(RESET_TARGET_VALUES).describe('Earlier workflow stage to reset the issue to.'),
      dry_run: z
        .boolean()
        .optional()
        .describe('When true, preview reset cleanup without making changes.'),
    },
    annotations: { openWorldHint: true, destructiveHint: true },
    createHandler:
      (repo) =>
      async ({ issue, target, dry_run }) => {
        try {
          const repoRoot = getResetRepoRoot();
          const repoName = getWorktreeRepoName(repoRoot);

          if (await isPullRequest(repo, issue)) {
            throw new Error(`#${issue} is a pull request, not an issue.`);
          }

          const issueData = await fetchIssueLabels(repo, issue);
          if (issueData.state !== 'OPEN') {
            throw new Error(`Issue #${issue} is closed. Reset only works on open issues.`);
          }

          const labels = issueData.labels.map((label) => label.name);
          const isFailedOnly =
            labels.includes(FAILED_LABEL) &&
            !labels.some((label) => STAGE_LABEL_NAMES.includes(label));

          if (labels.includes(LOCKED_LABEL) && !(await isLockStale(repo, String(issue)))) {
            throw new Error(
              `Issue #${issue} is locked by another shipper instance. Release the lock with shipper_unlock before retrying.`
            );
          }

          if (!isFailedOnly) {
            const currentStage = getCurrentStage(labels);
            const currentIndex = getStageIndex(currentStage.stage);
            const targetIndex = getStageIndex(target);
            const sameImplementedStage = currentStage.hasPrLabels && target === 'implemented';

            if (targetIndex === currentIndex && !sameImplementedStage) {
              throw new Error(
                `Error: Issue #${issue} is already at ${getStageLabel(target)}. Reset only works backward.`
              );
            }

            if (targetIndex > currentIndex) {
              throw new Error(
                `Error: ${getStageLabel(target)} is ahead of the current stage ${getStageLabel(currentStage.stage)}. Reset only works backward.`
              );
            }
          }

          const scan = await scanArtifacts(
            issue,
            repo,
            target,
            labels,
            getResetScanOptions(repoRoot, repoName, dry_run === true)
          );

          if (isClean(scan)) {
            return textOk(
              `Issue #${issue} is already clean for target ${scan.targetLabel}. Nothing to reset.`
            );
          }

          if (dry_run) {
            return textOk(formatResetPreview(issue, scan));
          }

          const result = await executeReset(issue, scan, repo, getResetExecutionOptions(repoRoot));
          const text = formatResetResult(issue, result);
          return result.hasFailures
            ? { content: [{ type: 'text', text }], isError: true }
            : textOk(text);
        } catch (err) {
          return formatToolError(err);
        }
      },
  }),
  defineTool({
    name: 'shipper_adopt',
    description:
      'Adopt an existing GitHub issue into the shipper workflow by adding the shipper:new label. Fails if the target is a PR; issues that already have a shipper label return a no-op success.',
    inputSchema: { issue: issueSchema() },
    annotations: { openWorldHint: true },
    createHandler:
      (repo) =>
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
      },
  }),
  defineTool({
    name: 'shipper_answer_question',
    description:
      'Provide answers to a paused headless worker that called AskUserQuestion. The worker resumes with the supplied answers and continues until it either defers again (returning another awaiting_answer payload) or completes.',
    inputSchema: {
      session_id: z
        .string()
        .min(1)
        .describe('Paused shipper worker session id returned by an awaiting_answer response.'),
      answers: z
        .record(z.string(), z.string())
        .describe('Map from question text to the answer to send back to the paused worker.'),
    },
    annotations: { openWorldHint: true },
    experimental: { flag: MCP_GROOMING_FLAG, enabled: isMcpGroomingEnabled },
    createHandler:
      (repo) =>
      async ({ session_id, answers }) => {
        try {
          const session = pendingSessions.get(session_id);
          if (!session) {
            throw new Error(
              `No pending shipper session with id "${session_id}". The worker may have already completed or the MCP server may have restarted.`
            );
          }
          await session.runner.answer(answers);
          const event = await session.runner.next();
          if (event.kind === 'deferred') {
            // Replace the entry under the (likely-same) sessionId with the latest payload context.
            // Session id rarely changes across the same claude run, but we guard anyway.
            if (event.sessionId !== session_id) {
              pendingSessions.delete(session_id);
              pendingSessions.set(event.sessionId, session);
            }
            return formatAwaitingAnswer({
              sessionId: event.sessionId,
              questions: event.payload.questions,
              ...(event.payload.toolUseId !== undefined
                ? { toolUseId: event.payload.toolUseId }
                : {}),
            });
          }

          // Completion path — replicate shipper_advance/shipper_groom's post-completion summary.
          clearPendingSession(session_id);
          const result = event.result;
          const advanceLikeTools = new Set(['shipper_advance', 'shipper_groom']);
          if (!advanceLikeTools.has(session.originatingTool) || session.issue === undefined) {
            return formatSpawnResult(result, `shipper ${session.args.join(' ')}`);
          }
          const issue = session.issue;
          const postIssue = await fetchIssueLabels(repo, issue);
          const postLabels = postIssue.labels.map((label) => label.name);
          const preStageLabel = session.preStageLabel ?? undefined;
          const preStage = parseAdvanceStage(preStageLabel);
          const outcome =
            resolveAdvanceOutcome(preStageLabel, postLabels) ??
            resolveNoopAdvanceOutcome(preStageLabel, result);
          const sessionContext = preStage
            ? await resolveSessionContext({
                repoSlug: session.repoSlug,
                issue: String(issue),
                stage: preStage,
                since: session.startedAt,
              })
            : {};
          const prNumber = await tryResolvePrForIssue(repo, issue);
          return formatAdvanceResult(
            result,
            outcome
              ? {
                  ...outcome,
                  prUrl: prNumber ? `https://github.com/${repo}/pull/${prNumber}` : undefined,
                }
              : undefined,
            {
              command: `shipper ${session.args.join(' ')}`,
              finalMessage: sessionContext.finalMessage,
              sessionLogPath: sessionContext.sessionLogPath,
            }
          );
        } catch (err) {
          return formatToolError(err);
        }
      },
  }),
] as const;

export async function registerTools(server: McpServer, repo: string): Promise<void> {
  const context: McpToolContext = { docsCorpus: await buildDocsCorpus() };

  for (const definition of mcpToolDefinitions) {
    if (definition.experimental && !definition.experimental.enabled()) {
      continue;
    }

    server.registerTool<McpInputSchema, McpInputSchema>(
      definition.name,
      {
        description: definition.description,
        inputSchema: definition.inputSchema,
        ...(definition.annotations ? { annotations: definition.annotations } : {}),
      },
      definition.createHandler(repo, context) as ToolCallback<McpInputSchema>
    );
  }
}

export function registerInitErrorTools(server: McpServer, error: unknown): void {
  const names = [
    'shipper_list_issues',
    'shipper_get_issue',
    'shipper_get_pr_checks',
    'shipper_docs_search',
    'shipper_docs_get',
    'shipper_advance',
    'shipper_create_issue',
    'shipper_unblock',
    'shipper_merge',
    'shipper_unlock',
    'shipper_reset',
    'shipper_adopt',
    ...(isMcpGroomingEnabled() ? ['shipper_answer_question', 'shipper_groom'] : []),
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
