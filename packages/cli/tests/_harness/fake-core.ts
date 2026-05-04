import { mkdtempSync, mkdirSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  __installFakeTransports,
  type PRChecksLine,
  type ResultJson,
  type RunPromptOpts,
} from '@dnsquared/shipper-core';

type AggregateSessionUsageResult = Awaited<
  ReturnType<(typeof import('@dnsquared/shipper-core'))['aggregateSessionUsage']>
>;

type GhResponse = { stdout: string; stderr: string };
type GhHandler = (
  args: string[],
  options?: { cwd?: string }
) => GhResponse | Promise<GhResponse> | undefined | Promise<undefined>;

interface FakeIssueRecord {
  number: string;
  title: string;
  body: string;
  state: 'OPEN' | 'CLOSED';
  url: string;
  labels: Set<string>;
  comments: string[];
  timeline: string[];
}

interface FakePrRecord {
  number: string;
  body: string;
  baseRefName: string;
  createdAt: string;
  headRefName: string;
  diff: string;
  authorLogin: string;
  labels: Set<string>;
  reviewThreads: unknown[];
}

interface FakeRunStep {
  name: string;
  conclusion: string | null;
  number: number;
  status: string;
}

interface FakeRunJob {
  name: string;
  conclusion: string | null;
  databaseId: number;
  steps: FakeRunStep[];
}

interface FakeRunRecord {
  jobs: FakeRunJob[];
  failedLogsByJobId: Map<number, string>;
}

interface FakePrCreateRecord {
  url: string;
  head: string;
  base: string;
  title: string;
  draft: boolean;
  body: string;
}

interface FakeReviewSubmission {
  pr: string;
  body: string;
}

interface FakeLabelTransition {
  target: 'issue' | 'pr';
  number: string;
  add: string[];
  remove: string[];
}

interface FakeState {
  issues: Map<string, FakeIssueRecord>;
  prs: Map<string, FakePrRecord>;
  postedComments: Array<{ target: 'issue'; number: string; body: string }>;
  postedReplies: Array<{ pr: string; commentId: string; body: string }>;
  rerunRequests: Array<{ runId: string }>;
  createdPrs: FakePrCreateRecord[];
  submittedReviews: FakeReviewSubmission[];
  labelTransitions: FakeLabelTransition[];
  sleepCalls: number[];
}

interface SetIssueInit {
  title?: string;
  body?: string;
  state?: 'OPEN' | 'CLOSED';
  labels?: string[];
  comments?: string[];
  timeline?: string[];
}

interface SetPrInit {
  body?: string;
  baseRefName?: string;
  createdAt?: string;
  headRefName?: string;
  diff?: string;
  authorLogin?: string;
  labels?: string[];
  reviewThreads?: unknown[];
}

interface SetRunInit {
  jobs?: FakeRunJob[];
  failedLogsByJobId?: Record<number, string>;
}

interface WriteStageOutputOptions {
  result: Omit<ResultJson, 'comment' | 'replies' | 'pr_spec' | 'review_payload' | 'groom'> &
    Partial<Pick<ResultJson, 'comment' | 'replies' | 'pr_spec' | 'review_payload' | 'groom'>>;
  commentBody?: string;
  replies?: Record<string, string>;
  prSpec?: {
    path?: string;
    bodyPath?: string;
    body: string;
    title: string;
    base: string;
    headBranch: string;
    draft?: boolean;
  };
  reviewPayload?: {
    path?: string;
    payload: unknown;
  };
  groom?: {
    path?: string;
    manifest: unknown;
    files?: Record<string, string>;
  };
}

interface CreateFakeCore {
  state: FakeState;
  install(): void;
  dispose(): Promise<void>;
  wtPath(): string;
  repoRoot(): string;
  setIssue(number: string, init?: SetIssueInit): void;
  setPr(number: string, init?: SetPrInit): void;
  setRun(runId: string, init?: SetRunInit): void;
  queueChecks(prNumber: string, ...checks: PRChecksLine[][]): void;
  queueRevParse(...values: string[]): void;
  queueCommitsAhead(...values: number[]): void;
  scriptGitRevParse(handler: (cwd: string, ref: string) => Promise<string> | string): void;
  scriptCommitsAhead(
    handler: (wtPath: string, baseBranch: string) => Promise<number> | number
  ): void;
  scriptRunPrompt(handler: (name: string, opts: RunPromptOpts) => Promise<number> | number): void;
  scriptSyncWorktree(
    handler: (
      opts: unknown,
      resolveConflicts: (conflictContext: unknown) => Promise<number>,
      remediateInstallError?: (installError: string) => Promise<number>
    ) => Promise<void> | void
  ): void;
  scriptPushWithRetry(
    handler: (
      opts: unknown,
      runAgent: (
        conflictContext?: unknown,
        pushError?: string,
        installError?: string
      ) => Promise<number>
    ) => Promise<number> | number
  ): void;
  scriptSleep(handler: (ms: number) => Promise<void> | void): void;
  scriptAggregateSessionUsage(
    handler: (
      repo: string,
      issue: string,
      since: Date
    ) => Promise<AggregateSessionUsageResult> | AggregateSessionUsageResult
  ): void;
  stubGh(handler: GhHandler): void;
  writeStageOutput(options: WriteStageOutputOptions): Promise<ResultJson>;
}

const DEFAULT_REPO_ROOT_NAME = 'repo';
const DEFAULT_WORKTREE_NAME = 'worktree';
const DEFAULT_COMMENT_PATH = '.shipper/output/comment.md';
const DEFAULT_REPLIES_PATH = '.shipper/output/replies';
const DEFAULT_PR_SPEC_PATH = '.shipper/output/pr-spec.json';
const DEFAULT_PR_BODY_PATH = '.shipper/output/pr-body.md';
const DEFAULT_REVIEW_PAYLOAD_PATH = '.shipper/output/review-payload.json';
const DEFAULT_VIEWER_LOGIN = 'shipper-bot';

function createIssue(number: string, init: SetIssueInit = {}): FakeIssueRecord {
  return {
    number,
    title: init.title ?? `Issue ${number}`,
    body: init.body ?? '',
    state: init.state ?? 'OPEN',
    url: `https://github.com/owner/repo/issues/${number}`,
    labels: new Set(init.labels ?? []),
    comments: [...(init.comments ?? [])],
    timeline: [...(init.timeline ?? [])],
  };
}

function createPr(number: string, init: SetPrInit = {}): FakePrRecord {
  return {
    number,
    body: init.body ?? '',
    baseRefName: init.baseRefName ?? 'main',
    createdAt: init.createdAt ?? new Date().toISOString(),
    headRefName: init.headRefName ?? `shipper/${number}-branch`,
    diff: init.diff ?? 'diff --git a/file b/file\n',
    authorLogin: init.authorLogin ?? 'dnsquared',
    labels: new Set(init.labels ?? []),
    reviewThreads: [...(init.reviewThreads ?? [])],
  };
}

function parseRepoResource(resource: string): { repo: string; tail: string[] } | null {
  const parts = resource.split('/');
  if (parts.length < 5 || parts[0] !== 'repos') {
    return null;
  }

  return {
    repo: `${parts[1]}/${parts[2]}`,
    tail: parts.slice(3),
  };
}

function getFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function toResponse(stdout = '', stderr = ''): GhResponse {
  return { stdout, stderr };
}

function resolvePathWithCwd(filePath: string, options?: { cwd?: string }): string {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }

  return path.resolve(options?.cwd ?? process.cwd(), filePath);
}

async function maybeReadBodyFile(args: string[], options?: { cwd?: string }): Promise<string> {
  const bodyFile = getFlagValue(args, '--body-file');
  if (bodyFile) {
    return await readFile(resolvePathWithCwd(bodyFile, options), 'utf-8');
  }

  return getFlagValue(args, '--body') ?? '';
}

export function createFakeCore(): CreateFakeCore {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'fake-core-'));
  const repoRoot = path.join(tmpRoot, DEFAULT_REPO_ROOT_NAME);
  const wtPath = path.join(tmpRoot, DEFAULT_WORKTREE_NAME);
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(wtPath, { recursive: true });

  const state: FakeState = {
    issues: new Map(),
    prs: new Map(),
    postedComments: [],
    postedReplies: [],
    rerunRequests: [],
    createdPrs: [],
    submittedReviews: [],
    labelTransitions: [],
    sleepCalls: [],
  };

  const checksQueue = new Map<string, PRChecksLine[][]>();
  const runs = new Map<string, FakeRunRecord>();
  const ghStubs: GhHandler[] = [];
  const revParseQueue: string[] = [];
  const commitsAheadQueue: number[] = [];

  const viewerLogin = DEFAULT_VIEWER_LOGIN;
  let installFakeTransportsCleanup: (() => void) | undefined;
  let runPromptHandler: (name: string, opts: RunPromptOpts) => Promise<number> | number = () => 0;
  let gitRevParseHandler: ((cwd: string, ref: string) => Promise<string> | string) | undefined;
  let commitsAheadHandler:
    | ((wtPath: string, baseBranch: string) => Promise<number> | number)
    | undefined;
  let syncWorktreeHandler:
    | ((
        opts: unknown,
        resolveConflicts: (conflictContext: unknown) => Promise<number>,
        remediateInstallError?: (installError: string) => Promise<number>
      ) => Promise<void> | void)
    | undefined;
  let pushWithRetryHandler:
    | ((
        opts: unknown,
        runAgent: (
          conflictContext?: unknown,
          pushError?: string,
          installError?: string
        ) => Promise<number>
      ) => Promise<number> | number)
    | undefined;
  let sleepHandler: ((ms: number) => Promise<void> | void) | undefined;
  let aggregateSessionUsageHandler:
    | ((
        repo: string,
        issue: string,
        since: Date
      ) => Promise<AggregateSessionUsageResult> | AggregateSessionUsageResult)
    | undefined;

  const ensureIssue = (number: string): FakeIssueRecord => {
    const existing = state.issues.get(number);
    if (existing) {
      return existing;
    }
    const issue = createIssue(number);
    state.issues.set(number, issue);
    return issue;
  };

  const ensurePr = (number: string): FakePrRecord => {
    const existing = state.prs.get(number);
    if (existing) {
      return existing;
    }
    const pr = createPr(number);
    state.prs.set(number, pr);
    return pr;
  };

  const nextChecks = (prNumber: string): PRChecksLine[] => {
    const queued = checksQueue.get(prNumber);
    if (!queued || queued.length === 0) {
      return [];
    }

    if (queued.length === 1) {
      return queued[0] ?? [];
    }

    const current = queued.shift();
    return current ?? [];
  };

  const recordLabelEdit = (
    target: 'issue' | 'pr',
    number: string,
    labels: Set<string>,
    add: string[],
    remove: string[]
  ): void => {
    for (const label of add) {
      labels.add(label);
    }
    for (const label of remove) {
      labels.delete(label);
    }

    state.labelTransitions.push({ target, number, add: [...add], remove: [...remove] });
  };

  const defaultGh = async (args: string[], options?: { cwd?: string }): Promise<GhResponse> => {
    if (args[0] === 'issue' && args[1] === 'view') {
      const issueNumber = args[2];
      if (!issueNumber) {
        throw new Error('Missing issue number');
      }
      const issue = ensureIssue(issueNumber);
      const jsonFields = getFlagValue(args, '--json');
      const jq = getFlagValue(args, '--jq');

      if (jsonFields === 'labels' && jq === '.labels[].name') {
        return toResponse([...issue.labels].join('\n'));
      }

      if (jsonFields === 'title' && jq === '.title') {
        return toResponse(issue.title);
      }

      if (jsonFields === 'number') {
        return toResponse(JSON.stringify({ number: Number(issueNumber) }));
      }

      return toResponse(
        JSON.stringify({
          number: Number(issueNumber),
          title: issue.title,
          body: issue.body,
          state: issue.state,
          url: issue.url,
          labels: [...issue.labels],
        })
      );
    }

    if (args[0] === 'issue' && args[1] === 'edit') {
      const issueNumber = args[2];
      if (!issueNumber) {
        throw new Error('Missing issue number');
      }
      const issue = ensureIssue(issueNumber);
      const add: string[] = [];
      const remove: string[] = [];

      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--add-label' && args[i + 1]) {
          add.push(args[i + 1] as string);
        }
        if (args[i] === '--remove-label' && args[i + 1]) {
          remove.push(args[i + 1] as string);
        }
      }

      const body = await maybeReadBodyFile(args, options);
      const title = getFlagValue(args, '--title');
      if (body) {
        issue.body = body;
      }
      if (title) {
        issue.title = title;
      }

      if (add.length > 0 || remove.length > 0) {
        recordLabelEdit('issue', issueNumber, issue.labels, add, remove);
      }
      if (add.includes('shipper:locked')) {
        issue.timeline.push(new Date().toISOString());
      }
      return toResponse();
    }

    if (args[0] === 'issue' && args[1] === 'comment') {
      const issueNumber = args[2];
      if (!issueNumber) {
        throw new Error('Missing issue number');
      }
      const issue = ensureIssue(issueNumber);
      const body = await maybeReadBodyFile(args, options);
      issue.comments.push(body);
      state.postedComments.push({ target: 'issue', number: issueNumber, body });
      return toResponse();
    }

    if (args[0] === 'issue' && args[1] === 'create') {
      const repo = getFlagValue(args, '-R');
      const title = getFlagValue(args, '--title');
      const body = await maybeReadBodyFile(args, options);
      if (!repo || !title) {
        throw new Error(`Unsupported issue create args: ${args.join(' ')}`);
      }

      const nextNumber =
        Math.max(0, ...[...state.issues.keys()].map((value) => Number.parseInt(value, 10) || 0)) +
        1;
      const issueNumber = String(nextNumber);
      const issue = createIssue(issueNumber, { title, body });
      issue.url = `https://github.com/${repo}/issues/${issueNumber}`;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--label' && args[i + 1]) {
          issue.labels.add(args[i + 1] as string);
        }
      }
      state.issues.set(issueNumber, issue);
      return toResponse(issue.url);
    }

    if (args[0] === 'issue' && args[1] === 'close') {
      const issueNumber = args[2];
      if (!issueNumber) {
        throw new Error('Missing issue number');
      }
      const issue = ensureIssue(issueNumber);
      issue.state = 'CLOSED';
      const comment = getFlagValue(args, '--comment');
      if (comment) {
        issue.comments.push(comment);
        state.postedComments.push({ target: 'issue', number: issueNumber, body: comment });
      }
      return toResponse();
    }

    if (args[0] === 'issue' && args[1] === 'list') {
      return toResponse('[]');
    }

    if (args[0] === 'pr' && args[1] === 'view') {
      const prNumber = args[2];
      if (!prNumber) {
        throw new Error('Missing PR number');
      }
      const pr = ensurePr(prNumber);
      const jsonFields = getFlagValue(args, '--json');
      const jq = getFlagValue(args, '--jq');

      if (jsonFields === 'author' && jq === '.author.login') {
        return toResponse(pr.authorLogin);
      }

      if (!jsonFields) {
        return toResponse(JSON.stringify(pr));
      }

      const payload: Record<string, unknown> = {};
      for (const field of jsonFields.split(',')) {
        if (field === 'number') payload.number = Number(pr.number);
        if (field === 'body') payload.body = pr.body;
        if (field === 'baseRefName') payload.baseRefName = pr.baseRefName;
        if (field === 'createdAt') payload.createdAt = pr.createdAt;
        if (field === 'headRefName') payload.headRefName = pr.headRefName;
        if (field === 'author') payload.author = { login: pr.authorLogin };
      }

      return toResponse(JSON.stringify(payload));
    }

    if (args[0] === 'pr' && args[1] === 'edit') {
      const prNumber = args[2];
      if (!prNumber) {
        throw new Error('Missing PR number');
      }
      const pr = ensurePr(prNumber);
      const add: string[] = [];
      const remove: string[] = [];

      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--add-label' && args[i + 1]) {
          add.push(args[i + 1] as string);
        }
        if (args[i] === '--remove-label' && args[i + 1]) {
          remove.push(args[i + 1] as string);
        }
      }

      recordLabelEdit('pr', prNumber, pr.labels, add, remove);
      return toResponse();
    }

    if (args[0] === 'pr' && args[1] === 'diff') {
      const prNumber = args[2];
      if (!prNumber) {
        throw new Error('Missing PR number');
      }
      return toResponse(ensurePr(prNumber).diff);
    }

    if (args[0] === 'pr' && args[1] === 'list') {
      const head = getFlagValue(args, '--head');
      const existing = [...state.prs.values()].find((pr) => pr.headRefName === head);
      if (!existing) {
        return toResponse('');
      }
      return toResponse(`https://github.com/${getFlagValue(args, '-R')}/pull/${existing.number}`);
    }

    if (args[0] === 'pr' && args[1] === 'create') {
      const repo = getFlagValue(args, '-R');
      const head = getFlagValue(args, '--head');
      const base = getFlagValue(args, '--base');
      const title = getFlagValue(args, '--title');
      const body = await maybeReadBodyFile(args, options);
      if (!repo || !head || !base || !title) {
        throw new Error(`Unsupported pr create args: ${args.join(' ')}`);
      }

      const nextNumber =
        Math.max(0, ...[...state.prs.keys()].map((value) => Number.parseInt(value, 10) || 0)) + 1;
      const prNumber = String(nextNumber);
      const url = `https://github.com/${repo}/pull/${prNumber}`;
      const pr = createPr(prNumber, { baseRefName: base, headRefName: head });
      state.prs.set(prNumber, pr);
      state.createdPrs.push({
        url,
        head,
        base,
        title,
        draft: args.includes('--draft'),
        body,
      });
      return toResponse(url);
    }

    if (args[0] === 'pr' && args[1] === 'checks') {
      const prNumber = args[2];
      if (!prNumber) {
        throw new Error('Missing PR number');
      }
      return toResponse(JSON.stringify(nextChecks(prNumber)));
    }

    if (args[0] === 'run' && args[1] === 'view') {
      const runId = args[2];
      const run = runId ? runs.get(runId) : undefined;

      if (runId && getFlagValue(args, '--json') === 'jobs') {
        return toResponse(JSON.stringify({ jobs: run?.jobs ?? [] }));
      }

      const jobId = getFlagValue(args, '--job');
      if (jobId && args.includes('--log-failed')) {
        const log =
          run?.failedLogsByJobId.get(Number(jobId)) ??
          [...runs.values()]
            .find((candidate) => candidate.failedLogsByJobId.has(Number(jobId)))
            ?.failedLogsByJobId.get(Number(jobId)) ??
          '';
        return toResponse(log);
      }
    }

    if (args[0] === 'run' && args[1] === 'rerun') {
      const runId = args[2];
      if (!runId) {
        throw new Error('Missing run id');
      }
      state.rerunRequests.push({ runId });
      return toResponse();
    }

    if (args[0] === 'api' && args[1] === 'graphql') {
      const prNumber = getFlagValue(args, '-F')?.replace(/^number=/, '');
      if (!prNumber) {
        return toResponse('[]');
      }
      return toResponse(JSON.stringify(ensurePr(prNumber).reviewThreads));
    }

    if (args[0] === 'api' && args[1] === 'user') {
      return toResponse(viewerLogin);
    }

    if (args[0] === 'api' && args[1]) {
      const parsed = parseRepoResource(args[1]);
      if (!parsed) {
        throw new Error(`Unsupported gh api resource: ${args[1]}`);
      }

      const { tail } = parsed;
      if (
        tail[0] === 'issues' &&
        tail[2] === 'timeline' &&
        tail[1] !== undefined &&
        args.includes('--paginate')
      ) {
        return toResponse(ensureIssue(tail[1]).timeline.join('\n'));
      }

      if (
        tail[0] === 'pulls' &&
        tail[2] === 'comments' &&
        tail[4] === 'replies' &&
        tail[1] !== undefined &&
        tail[3] !== undefined
      ) {
        const bodyArg = args.find((arg) => arg.startsWith('body='));
        const body = bodyArg ? bodyArg.slice('body='.length) : '';
        state.postedReplies.push({ pr: tail[1], commentId: tail[3], body });
        return toResponse();
      }

      if (tail[0] === 'pulls' && tail[2] === 'reviews' && tail[1] !== undefined) {
        const inputPath = getFlagValue(args, '--input');
        const body = inputPath
          ? await readFile(resolvePathWithCwd(inputPath, options), 'utf-8')
          : '';
        state.submittedReviews.push({ pr: tail[1], body });
        return toResponse();
      }
    }

    throw new Error(`Unsupported gh args: ${args.join(' ')}`);
  };

  return {
    state,
    install(): void {
      if (installFakeTransportsCleanup) {
        return;
      }

      installFakeTransportsCleanup = __installFakeTransports({
        gh: async (args, options) => {
          for (const stub of ghStubs) {
            const result = await stub(args, options);
            if (result !== undefined) {
              return result;
            }
          }
          return await defaultGh(args, options);
        },
        runPrompt: async (name, opts) => await runPromptHandler(name, opts),
        withWorktree: async (_opts, fn) => await fn(wtPath),
        syncWorktree: async (...args) => {
          if (!syncWorktreeHandler) {
            return;
          }
          await syncWorktreeHandler(args[0], args[1], args[2]);
        },
        pushWithRetry: async (...args) => {
          if (!pushWithRetryHandler) {
            return 0;
          }
          return await pushWithRetryHandler(args[0], args[1]);
        },
        getRepoRoot: () => Promise.resolve(repoRoot),
        getBranchForPR: (_repo, prRef) => Promise.resolve(ensurePr(prRef).headRefName),
        getGitRevParse: (cwd, ref) => {
          if (gitRevParseHandler) {
            return Promise.resolve(gitRevParseHandler(cwd, ref));
          }
          const queued = revParseQueue.shift();
          if (queued !== undefined) {
            return Promise.resolve(queued);
          }
          return Promise.resolve(ref === 'HEAD' ? 'head-sha' : `sha-for-${ref}`);
        },
        getCommitsAheadCount: (worktreePath, baseBranch) => {
          if (commitsAheadHandler) {
            return Promise.resolve(commitsAheadHandler(worktreePath, baseBranch));
          }
          const queued = commitsAheadQueue.shift();
          return Promise.resolve(queued ?? 1);
        },
        sleepMs: async (ms) => {
          state.sleepCalls.push(ms);
          await sleepHandler?.(ms);
        },
        aggregateSessionUsage: async (repo, issue, since) =>
          aggregateSessionUsageHandler?.(repo, issue, since),
      });
    },
    async dispose(): Promise<void> {
      installFakeTransportsCleanup?.();
      installFakeTransportsCleanup = undefined;
      await rm(tmpRoot, { recursive: true, force: true });
    },
    wtPath(): string {
      return wtPath;
    },
    repoRoot(): string {
      return repoRoot;
    },
    setIssue(number: string, init: SetIssueInit = {}): void {
      state.issues.set(number, createIssue(number, init));
    },
    setPr(number: string, init: SetPrInit = {}): void {
      state.prs.set(number, createPr(number, init));
    },
    setRun(runId: string, init: SetRunInit = {}): void {
      runs.set(runId, {
        jobs: [...(init.jobs ?? [])],
        failedLogsByJobId: new Map(
          Object.entries(init.failedLogsByJobId ?? {}).map(([jobId, log]) => [Number(jobId), log])
        ),
      });
    },
    queueChecks(prNumber: string, ...checks: PRChecksLine[][]): void {
      checksQueue.set(
        prNumber,
        checks.map((entry) => [...entry])
      );
    },
    queueRevParse(...values: string[]): void {
      revParseQueue.push(...values);
    },
    queueCommitsAhead(...values: number[]): void {
      commitsAheadQueue.push(...values);
    },
    scriptGitRevParse(handler): void {
      gitRevParseHandler = handler;
    },
    scriptCommitsAhead(handler): void {
      commitsAheadHandler = handler;
    },
    scriptRunPrompt(handler): void {
      runPromptHandler = handler;
    },
    scriptSyncWorktree(handler): void {
      syncWorktreeHandler = handler;
    },
    scriptPushWithRetry(handler): void {
      pushWithRetryHandler = handler;
    },
    scriptSleep(handler): void {
      sleepHandler = handler;
    },
    scriptAggregateSessionUsage(handler): void {
      aggregateSessionUsageHandler = handler;
    },
    stubGh(handler): void {
      ghStubs.push(handler);
    },
    async writeStageOutput(options: WriteStageOutputOptions): Promise<ResultJson> {
      const outputDir = path.join(wtPath, '.shipper', 'output');
      mkdirSync(outputDir, { recursive: true });

      const commentPath = options.result.comment ?? DEFAULT_COMMENT_PATH;
      await writeFile(path.join(wtPath, commentPath), options.commentBody ?? 'comment', 'utf-8');

      const result: ResultJson = {
        verdict: options.result.verdict,
        comment: commentPath,
      };

      if (options.replies && Object.keys(options.replies).length > 0) {
        const repliesPath = options.result.replies ?? DEFAULT_REPLIES_PATH;
        const absRepliesDir = path.join(wtPath, repliesPath);
        mkdirSync(absRepliesDir, { recursive: true });
        for (const [commentId, body] of Object.entries(options.replies)) {
          await writeFile(path.join(absRepliesDir, `${commentId}.md`), body, 'utf-8');
        }
        result.replies = repliesPath;
      } else if (options.result.replies) {
        result.replies = options.result.replies;
      }

      if (options.prSpec) {
        const prSpecPath = options.prSpec.path ?? options.result.pr_spec ?? DEFAULT_PR_SPEC_PATH;
        const bodyPath = options.prSpec.bodyPath ?? DEFAULT_PR_BODY_PATH;
        await writeFile(path.join(wtPath, bodyPath), options.prSpec.body, 'utf-8');
        await writeFile(
          path.join(wtPath, prSpecPath),
          JSON.stringify(
            {
              title: options.prSpec.title,
              body_file: bodyPath,
              base: options.prSpec.base,
              head_branch: options.prSpec.headBranch,
              draft: options.prSpec.draft ?? false,
            },
            null,
            2
          ),
          'utf-8'
        );
        result.pr_spec = prSpecPath;
      } else if (options.result.pr_spec) {
        result.pr_spec = options.result.pr_spec;
      }

      if (options.reviewPayload) {
        const reviewPayloadPath =
          options.reviewPayload.path ??
          options.result.review_payload ??
          DEFAULT_REVIEW_PAYLOAD_PATH;
        await writeFile(
          path.join(wtPath, reviewPayloadPath),
          JSON.stringify(options.reviewPayload.payload, null, 2),
          'utf-8'
        );
        result.review_payload = reviewPayloadPath;
      } else if (options.result.review_payload) {
        result.review_payload = options.result.review_payload;
      }

      if (options.groom) {
        const groomPath =
          options.groom.path ?? options.result.groom ?? '.shipper/output/groom.json';
        for (const [filePath, body] of Object.entries(options.groom.files ?? {})) {
          await writeFile(path.join(wtPath, filePath), body, 'utf-8');
        }
        await writeFile(
          path.join(wtPath, groomPath),
          JSON.stringify(options.groom.manifest, null, 2),
          'utf-8'
        );
        result.groom = groomPath;
      } else if (options.result.groom) {
        result.groom = options.result.groom;
      }

      await writeFile(
        path.join(outputDir, 'result.json'),
        JSON.stringify(result, null, 2),
        'utf-8'
      );
      return result;
    },
  };
}
