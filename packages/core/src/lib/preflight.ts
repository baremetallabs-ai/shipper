import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fetchChecks } from './checks.js';
import { gh } from './gh.js';
import { fetchIssue, fetchPR } from './github.js';
import { scrubInputDir } from './output-dirs.js';
import type { StageName } from './stage-transitions.js';

export interface PreflightContext {
  repo: string;
  issueRef: string;
  prRef?: string;
  inputDir: string;
}

type PreflightFetcher = (ctx: PreflightContext) => Promise<void>;

function refSlug(ref: string): string {
  return ref.replace(/[^A-Za-z0-9._-]+/g, '-');
}

function requirePrRef(ctx: PreflightContext, stage: StageName): string {
  if (!ctx.prRef) {
    throw new Error(`Stage "${stage}" requires opts.prRef for pre-flight context.`);
  }

  return ctx.prRef;
}

async function writeInputFile(inputDir: string, fileName: string, contents: string): Promise<void> {
  await writeFile(path.join(inputDir, fileName), contents, 'utf-8');
}

async function writeIssueContext(ctx: PreflightContext): Promise<void> {
  const issueSnapshot = await fetchIssue(ctx.repo, ctx.issueRef);
  await writeInputFile(ctx.inputDir, `issue-${refSlug(ctx.issueRef)}.md`, issueSnapshot);
}

async function writePrContext(ctx: PreflightContext): Promise<void> {
  const prRef = requirePrRef(ctx, 'pr_review');
  const prSnapshot = await fetchPR(ctx.repo, prRef);
  await writeInputFile(ctx.inputDir, `pr-${refSlug(prRef)}.md`, prSnapshot);
}

async function writePrDiff(ctx: PreflightContext): Promise<void> {
  const prRef = requirePrRef(ctx, 'pr_review');
  const { stdout } = await gh(['pr', 'diff', prRef, '-R', ctx.repo]);
  await writeInputFile(ctx.inputDir, `pr-diff-${refSlug(prRef)}.patch`, stdout);
}

async function writePrFiles(ctx: PreflightContext): Promise<void> {
  const prRef = requirePrRef(ctx, 'pr_review');
  const { stdout } = await gh(['api', `repos/${ctx.repo}/pulls/${prRef}/files`]);
  await writeInputFile(ctx.inputDir, `pr-files-${refSlug(prRef)}.json`, stdout);
}

async function writeViewerLogin(ctx: PreflightContext): Promise<void> {
  const { stdout } = await gh(['api', '/user', '--jq', '.login']);
  await writeInputFile(ctx.inputDir, 'viewer-login.txt', `${stdout.trim()}\n`);
}

async function writeCiContext(ctx: PreflightContext): Promise<void> {
  const prRef = requirePrRef(ctx, 'pr_remediate');
  const checks = await fetchChecks(ctx.repo, prRef);
  await writeInputFile(
    ctx.inputDir,
    `ci-status-${refSlug(prRef)}.json`,
    `${JSON.stringify(checks, null, 2)}\n`
  );
}

async function writeReviews(ctx: PreflightContext): Promise<void> {
  const prRef = requirePrRef(ctx, 'pr_remediate');
  const { stdout } = await gh(['api', `repos/${ctx.repo}/pulls/${prRef}/reviews`, '--paginate']);
  await writeInputFile(ctx.inputDir, `reviews-${refSlug(prRef)}.json`, stdout);
}

async function writeReviewThreads(ctx: PreflightContext): Promise<void> {
  const prRef = requirePrRef(ctx, 'pr_remediate');
  const owner = ctx.repo.split('/')[0];
  const repoName = ctx.repo.split('/')[1];
  const query = `
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: 100) {
            nodes {
              path
              line
              isResolved
              isOutdated
              comments(first: 100) {
                nodes {
                  databaseId
                  author {
                    login
                  }
                  body
                  createdAt
                }
              }
            }
          }
        }
      }
    }
  `;
  const { stdout } = await gh([
    'api',
    'graphql',
    '-f',
    `owner=${owner}`,
    '-f',
    `repo=${repoName}`,
    '-F',
    `number=${prRef}`,
    '-f',
    `query=${query}`,
  ]);

  const parsed = JSON.parse(stdout) as {
    data?: {
      repository?: {
        pullRequest?: {
          reviewThreads?: {
            nodes?: Array<{
              path: string;
              line: number;
              isResolved: boolean;
              isOutdated: boolean;
              comments: {
                nodes: Array<{
                  databaseId: number;
                  author?: { login?: string };
                  body: string;
                  createdAt: string;
                }>;
              };
            }>;
          };
        };
      };
    };
  };

  const threads =
    parsed.data?.repository?.pullRequest?.reviewThreads?.nodes?.map((thread) => ({
      path: thread.path,
      line: thread.line,
      isResolved: thread.isResolved,
      isOutdated: thread.isOutdated,
      comments: thread.comments.nodes.map((comment) => ({
        id: comment.databaseId,
        author: comment.author?.login ?? '',
        body: comment.body,
        createdAt: comment.createdAt,
      })),
    })) ?? [];

  await writeInputFile(
    ctx.inputDir,
    `threads-${refSlug(prRef)}.json`,
    `${JSON.stringify(threads, null, 2)}\n`
  );
}

export const PREFLIGHT: Record<StageName, PreflightFetcher[]> = {
  design: [writeIssueContext],
  plan: [writeIssueContext],
  implement: [writeIssueContext],
  pr_open: [writeIssueContext],
  pr_review: [writeIssueContext, writePrContext, writePrDiff, writePrFiles, writeViewerLogin],
  pr_remediate: [
    writeIssueContext,
    writePrContext,
    writeCiContext,
    writeReviews,
    writeReviewThreads,
  ],
  unblock: [writeIssueContext],
};

export async function runPreflight(stage: StageName, ctx: PreflightContext): Promise<void> {
  await scrubInputDir(path.resolve(ctx.inputDir, '..', '..'));

  for (const fetcher of PREFLIGHT[stage]) {
    await fetcher(ctx);
  }
}
