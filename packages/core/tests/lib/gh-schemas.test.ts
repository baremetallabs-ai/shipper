import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  parseCommentIdCreatedAt,
  parseIssue,
  parseIssueLabelsState,
  parseIssueList,
  parseIssueNumberLabels,
  parseIssueNumberLabelsList,
  parseIssueStateTitle,
  parseIssueTitleLabelsList,
  parseIssueWithLabelsBody,
  parseMatchingRefs,
  parseMergeQueueSearch,
  parsePrBaseRefNameView,
  parsePrBodyView,
  parsePrChecks,
  parsePrCreatedAtView,
  parsePrFilesPages,
  parsePrHeadRefNameView,
  parsePrMergeStateView,
  parsePrNumberBodyView,
  parsePrReviewThreads,
  parsePrStateMergedTitle,
  parsePrStateView,
  parsePrSummaryList,
  parsePrViewForMerge,
  parsePullRequest,
  parseQueuedPrList,
  parseRunViewJobs,
  parseTimelineLabelEvent,
} from '../../src/lib/gh-schemas.js';

type Parser = (json: string) => unknown;
type InvalidCase = {
  label: string;
  raw: (fixture: unknown) => string;
};
type ParserCase = {
  shapeName: string;
  fixture: string;
  parse: Parser;
  invalid: [InvalidCase, InvalidCase, InvalidCase, InvalidCase];
};

function readFixture(name: string): string {
  return readFileSync(new URL(`../fixtures/gh/${name}`, import.meta.url), 'utf-8');
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error('Expected object fixture');
  }

  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error('Expected array fixture');
  }

  return value;
}

function firstObject(value: unknown): Record<string, unknown> {
  const list = asArray(value);
  const first = list[0];
  if (!first) {
    throw new Error('Expected non-empty array fixture');
  }

  return asObject(first);
}

const cases: ParserCase[] = [
  {
    shapeName: 'Issue',
    fixture: 'issue-view.json',
    parse: parseIssue,
    invalid: [
      {
        label: 'missing required field',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          delete copy.title;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong type for required field',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          copy.title = 638;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong shape for nested object',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          copy.author = 'dnsquared';
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong shape for array element',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          const labels = asArray(copy.labels);
          labels[0] = 1;
          return JSON.stringify(copy);
        },
      },
    ],
  },
  {
    shapeName: 'PullRequest',
    fixture: 'pr-view.json',
    parse: parsePullRequest,
    invalid: [
      {
        label: 'missing required field',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          delete copy.headRefName;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong type for required field',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          copy.baseRefName = 1;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong shape for nested object',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          const reviews = asArray(copy.reviews);
          const firstReview = asObject(reviews[0]);
          firstReview.author = 'copilot-pull-request-reviewer';
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong shape for array element',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          const reviews = asArray(copy.reviews);
          reviews[0] = 1;
          return JSON.stringify(copy);
        },
      },
    ],
  },
  {
    shapeName: 'IssueList',
    fixture: 'issue-list.json',
    parse: parseIssueList,
    invalid: [
      {
        label: 'missing required field',
        raw: (fixture) => {
          const copy = clone(fixture);
          delete firstObject(copy).number;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong type for required field',
        raw: (fixture) => {
          const copy = clone(fixture);
          firstObject(copy).url = 123;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong shape for nested object',
        raw: (fixture) => {
          const copy = clone(fixture);
          firstObject(copy).author = 'dnsquared';
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong shape for array element',
        raw: (fixture) => {
          const copy = clone(fixture);
          const labels = asArray(firstObject(copy).labels);
          labels[0] = 1;
          return JSON.stringify(copy);
        },
      },
    ],
  },
  {
    shapeName: 'IssueTitleLabelsList',
    fixture: 'issue-stage-list.json',
    parse: parseIssueTitleLabelsList,
    invalid: [
      {
        label: 'missing required field',
        raw: (fixture) => {
          const copy = clone(fixture);
          delete firstObject(copy).title;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong type for required field',
        raw: (fixture) => {
          const copy = clone(fixture);
          firstObject(copy).number = '641';
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong shape for nested object',
        raw: (fixture) => {
          const copy = clone(fixture);
          firstObject(copy).labels = 'shipper:new';
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong shape for array element',
        raw: (fixture) => {
          const copy = clone(fixture);
          const labels = asArray(firstObject(copy).labels);
          labels[0] = 1;
          return JSON.stringify(copy);
        },
      },
    ],
  },
  {
    shapeName: 'IssueNumberLabels',
    fixture: 'issue-number-labels.json',
    parse: parseIssueNumberLabels,
    invalid: [
      {
        label: 'missing required field',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          delete copy.number;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong type for required field',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          copy.number = '638';
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong shape for nested object',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          copy.labels = 'shipper:planned';
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong shape for array element',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          const labels = asArray(copy.labels);
          labels[0] = 1;
          return JSON.stringify(copy);
        },
      },
    ],
  },
  {
    shapeName: 'IssueNumberLabelsList',
    fixture: 'issue-number-labels-list.json',
    parse: parseIssueNumberLabelsList,
    invalid: [
      {
        label: 'missing required field',
        raw: (fixture) => {
          const copy = clone(fixture);
          delete firstObject(copy).number;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong type for required field',
        raw: (fixture) => {
          const copy = clone(fixture);
          firstObject(copy).number = '641';
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong shape for nested object',
        raw: (fixture) => {
          const copy = clone(fixture);
          firstObject(copy).labels = 'shipper:new';
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong shape for array element',
        raw: (fixture) => {
          const copy = clone(fixture);
          const labels = asArray(firstObject(copy).labels);
          labels[0] = 1;
          return JSON.stringify(copy);
        },
      },
    ],
  },
  {
    shapeName: 'IssueLabelsState',
    fixture: 'issue-labels-state.json',
    parse: parseIssueLabelsState,
    invalid: [
      {
        label: 'missing required field',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          delete copy.state;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong type for required field',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          copy.state = false;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong shape for nested object',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          copy.labels = 'shipper:planned';
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong shape for array element',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          const labels = asArray(copy.labels);
          labels[0] = 1;
          return JSON.stringify(copy);
        },
      },
    ],
  },
  {
    shapeName: 'IssueWithLabelsBody',
    fixture: 'issue-with-labels-body.json',
    parse: parseIssueWithLabelsBody,
    invalid: [
      {
        label: 'missing required field',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          delete copy.body;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong type for required field',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          copy.number = '638';
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong shape for nested object',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          copy.labels = 'shipper:planned';
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong shape for array element',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          const labels = asArray(copy.labels);
          labels[0] = 1;
          return JSON.stringify(copy);
        },
      },
    ],
  },
  {
    shapeName: 'IssueStateTitle',
    fixture: 'issue-state-title.json',
    parse: parseIssueStateTitle,
    invalid: [
      {
        label: 'missing required field',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          delete copy.title;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong type for required field',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          copy.state = 1;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong shape for nested object',
        raw: () => JSON.stringify({ title: 'Issue', state: { value: 'OPEN' } }),
      },
      {
        label: 'wrong shape for array element',
        raw: () => JSON.stringify([{ title: 'Issue', state: 'OPEN' }]),
      },
    ],
  },
  {
    shapeName: 'PrSummaryList',
    fixture: 'pr-summary-list.json',
    parse: parsePrSummaryList,
    invalid: [
      {
        label: 'missing required field',
        raw: (fixture) => {
          const copy = clone(fixture);
          delete firstObject(copy).headRefName;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong type for required field',
        raw: (fixture) => {
          const copy = clone(fixture);
          firstObject(copy).number = '643';
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong shape for nested object',
        raw: () => JSON.stringify({ prs: [{ number: 643, headRefName: 'shipper/630' }] }),
      },
      {
        label: 'wrong shape for array element',
        raw: (fixture) => {
          const copy = clone(fixture);
          asArray(copy)[0] = 1;
          return JSON.stringify(copy);
        },
      },
    ],
  },
  {
    shapeName: 'QueuedPrList',
    fixture: 'queued-pr-list.json',
    parse: parseQueuedPrList,
    invalid: [
      {
        label: 'missing required field',
        raw: (fixture) => {
          const copy = clone(fixture);
          delete firstObject(copy).baseRefName;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong type for required field',
        raw: (fixture) => {
          const copy = clone(fixture);
          firstObject(copy).title = 643;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong shape for nested object',
        raw: () => JSON.stringify({ prs: [{ number: 643, title: 'PR' }] }),
      },
      {
        label: 'wrong shape for array element',
        raw: (fixture) => {
          const copy = clone(fixture);
          asArray(copy)[0] = 1;
          return JSON.stringify(copy);
        },
      },
    ],
  },
  {
    shapeName: 'PrViewForMerge',
    fixture: 'pr-view-for-merge.json',
    parse: parsePrViewForMerge,
    invalid: [
      {
        label: 'missing required field',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          delete copy.labels;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong type for required field',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          copy.state = true;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong shape for nested object',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          copy.labels = 'shipper:ready';
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong shape for array element',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          const labels = asArray(copy.labels);
          labels[0] = 1;
          return JSON.stringify(copy);
        },
      },
    ],
  },
  {
    shapeName: 'PrMergeStateView',
    fixture: 'pr-merge-state.json',
    parse: parsePrMergeStateView,
    invalid: [
      {
        label: 'missing required field',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          delete copy.mergeStateStatus;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong type for required field',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          copy.mergeStateStatus = 1;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong shape for nested object',
        raw: () => JSON.stringify({ mergeStateStatus: { value: 'UNKNOWN' }, mergeable: 'UNKNOWN' }),
      },
      {
        label: 'wrong shape for array element',
        raw: () => JSON.stringify([{ mergeStateStatus: 'UNKNOWN', mergeable: 'UNKNOWN' }]),
      },
    ],
  },
  {
    shapeName: 'PrBodyView',
    fixture: 'pr-view-body.json',
    parse: parsePrBodyView,
    invalid: [
      {
        label: 'missing required field',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          delete copy.body;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong type for required field',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          copy.body = 1;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong shape for nested object',
        raw: () => JSON.stringify({ body: { text: 'Closes #630' } }),
      },
      {
        label: 'wrong shape for array element',
        raw: () => JSON.stringify([{ body: 'Closes #630' }]),
      },
    ],
  },
  {
    shapeName: 'PrNumberBodyView',
    fixture: 'pr-number-body.json',
    parse: parsePrNumberBodyView,
    invalid: [
      {
        label: 'missing required field',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          delete copy.number;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong type for required field',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          copy.number = '643';
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong shape for nested object',
        raw: () => JSON.stringify({ number: 643, body: { text: 'Closes #630' } }),
      },
      {
        label: 'wrong shape for array element',
        raw: () => JSON.stringify([{ number: 643, body: 'Closes #630' }]),
      },
    ],
  },
  {
    shapeName: 'PrStateView',
    fixture: 'pr-view-state.json',
    parse: parsePrStateView,
    invalid: [
      {
        label: 'missing required field',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          delete copy.state;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong type for required field',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          copy.state = 1;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong shape for nested object',
        raw: () => JSON.stringify({ state: { value: 'MERGED' } }),
      },
      {
        label: 'wrong shape for array element',
        raw: () => JSON.stringify([{ state: 'MERGED' }]),
      },
    ],
  },
  {
    shapeName: 'PrCreatedAtView',
    fixture: 'pr-view-created-at.json',
    parse: parsePrCreatedAtView,
    invalid: [
      {
        label: 'missing required field',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          delete copy.createdAt;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong type for required field',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          copy.createdAt = false;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong shape for nested object',
        raw: () => JSON.stringify({ createdAt: { value: '2026-04-17T20:32:05Z' } }),
      },
      {
        label: 'wrong shape for array element',
        raw: () => JSON.stringify([{ createdAt: '2026-04-17T20:32:05Z' }]),
      },
    ],
  },
  {
    shapeName: 'PrBaseRefNameView',
    fixture: 'pr-view-base-ref.json',
    parse: parsePrBaseRefNameView,
    invalid: [
      {
        label: 'missing required field',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          delete copy.baseRefName;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong type for required field',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          copy.baseRefName = false;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong shape for nested object',
        raw: () => JSON.stringify({ baseRefName: { value: 'main' } }),
      },
      {
        label: 'wrong shape for array element',
        raw: () => JSON.stringify([{ baseRefName: 'main' }]),
      },
    ],
  },
  {
    shapeName: 'PrHeadRefNameView',
    fixture: 'pr-head-ref-name.json',
    parse: parsePrHeadRefNameView,
    invalid: [
      {
        label: 'missing required field',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          delete copy.headRefName;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong type for required field',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          copy.headRefName = false;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong shape for nested object',
        raw: () => JSON.stringify({ headRefName: { value: 'shipper/630' } }),
      },
      {
        label: 'wrong shape for array element',
        raw: () => JSON.stringify([{ headRefName: 'shipper/630' }]),
      },
    ],
  },
  {
    shapeName: 'PrStateMergedTitle',
    fixture: 'pr-state-merged-title.json',
    parse: parsePrStateMergedTitle,
    invalid: [
      {
        label: 'missing required field',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          delete copy.mergedAt;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong type for required field',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          copy.state = 1;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong shape for nested object',
        raw: () => JSON.stringify({ title: 'PR', state: { value: 'MERGED' }, mergedAt: null }),
      },
      {
        label: 'wrong shape for array element',
        raw: () => JSON.stringify([{ title: 'PR', state: 'MERGED', mergedAt: null }]),
      },
    ],
  },
  {
    shapeName: 'PrChecks',
    fixture: 'pr-checks.json',
    parse: parsePrChecks,
    invalid: [
      {
        label: 'missing required field',
        raw: (fixture) => {
          const copy = clone(fixture);
          delete firstObject(copy).name;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong type for required field',
        raw: (fixture) => {
          const copy = clone(fixture);
          firstObject(copy).bucket = 1;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong shape for nested object',
        raw: () =>
          JSON.stringify({ checks: [{ name: 'check', state: 'SUCCESS', bucket: 'pass' }] }),
      },
      {
        label: 'wrong shape for array element',
        raw: (fixture) => {
          const copy = clone(fixture);
          asArray(copy)[0] = 1;
          return JSON.stringify(copy);
        },
      },
    ],
  },
  {
    shapeName: 'RunViewJobs',
    fixture: 'run-view-jobs.json',
    parse: parseRunViewJobs,
    invalid: [
      {
        label: 'missing required field',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          const firstJob = firstObject(copy.jobs);
          delete firstJob.databaseId;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong type for required field',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          firstObject(copy.jobs).name = 1;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong shape for nested object',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          firstObject(copy.jobs).steps = {};
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong shape for array element',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          const steps = asArray(firstObject(copy.jobs).steps);
          steps[0] = 1;
          return JSON.stringify(copy);
        },
      },
    ],
  },
  {
    shapeName: 'TimelineLabelEvent',
    fixture: 'issue-timeline-line.json',
    parse: parseTimelineLabelEvent,
    invalid: [
      {
        label: 'missing required field',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          delete copy.event;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong type for required field',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          copy.event = false;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong shape for nested object',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          copy.label = 'shipper:new';
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong shape for array element',
        raw: () => JSON.stringify([{ event: 'labeled', label: { name: 'shipper:new' } }]),
      },
    ],
  },
  {
    shapeName: 'CommentIdCreatedAt',
    fixture: 'comment-id-created-at-line.json',
    parse: parseCommentIdCreatedAt,
    invalid: [
      {
        label: 'missing required field',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          delete copy.id;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong type for required field',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          copy.id = '4270378941';
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong shape for nested object',
        raw: () =>
          JSON.stringify({ id: 4270378941, created_at: { value: '2026-04-17T18:28:38Z' } }),
      },
      {
        label: 'wrong shape for array element',
        raw: () => JSON.stringify([{ id: 4270378941, created_at: '2026-04-17T18:28:38Z' }]),
      },
    ],
  },
  {
    shapeName: 'MatchingRefs',
    fixture: 'matching-refs.json',
    parse: parseMatchingRefs,
    invalid: [
      {
        label: 'missing required field',
        raw: () => JSON.stringify([{}]),
      },
      {
        label: 'wrong type for required field',
        raw: () => JSON.stringify([{ ref: 1 }]),
      },
      {
        label: 'wrong shape for nested object',
        raw: () => JSON.stringify({ refs: [] }),
      },
      {
        label: 'wrong shape for array element',
        raw: () => JSON.stringify([1]),
      },
    ],
  },
  {
    shapeName: 'PrFilesPages',
    fixture: 'pr-files.json',
    parse: parsePrFilesPages,
    invalid: [
      {
        label: 'missing required field',
        raw: (fixture) => {
          const copy = clone(fixture);
          const firstPage = asArray(asArray(copy)[0]);
          delete asObject(firstPage[0]).filename;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong type for required field',
        raw: (fixture) => {
          const copy = clone(fixture);
          const firstPage = asArray(asArray(copy)[0]);
          asObject(firstPage[0]).filename = 1;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong shape for nested object',
        raw: (fixture) => {
          const copy = clone(fixture);
          asArray(copy)[0] = {};
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong shape for array element',
        raw: (fixture) => {
          const copy = clone(fixture);
          const firstPage = asArray(asArray(copy)[0]);
          firstPage[0] = 1;
          return JSON.stringify(copy);
        },
      },
    ],
  },
  {
    shapeName: 'MergeQueueSearch',
    fixture: 'merge-queue-search.json',
    parse: parseMergeQueueSearch,
    invalid: [
      {
        label: 'missing required field',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          const pageInfo = asObject(asObject(asObject(copy.data).search).pageInfo);
          delete pageInfo.hasNextPage;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong type for required field',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          const node = firstObject(asObject(asObject(copy.data).search).nodes);
          node.number = '643';
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong shape for nested object',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          const node = firstObject(asObject(asObject(copy.data).search).nodes);
          node.timelineItems = [];
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong shape for array element',
        raw: (fixture) => {
          const copy = asObject(clone(fixture));
          const nodes = asArray(asObject(asObject(copy.data).search).nodes);
          nodes[0] = 1;
          return JSON.stringify(copy);
        },
      },
    ],
  },
  {
    shapeName: 'PrReviewThreads',
    fixture: 'pr-review-threads.json',
    parse: parsePrReviewThreads,
    invalid: [
      {
        label: 'missing required field',
        raw: (fixture) => {
          const copy = clone(fixture);
          delete firstObject(copy).comments;
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong type for required field',
        raw: (fixture) => {
          const copy = clone(fixture);
          firstObject(copy).isResolved = 'false';
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong shape for nested object',
        raw: (fixture) => {
          const copy = clone(fixture);
          firstObject(copy).comments = {};
          return JSON.stringify(copy);
        },
      },
      {
        label: 'wrong shape for array element',
        raw: (fixture) => {
          const copy = clone(fixture);
          const comments = asArray(firstObject(copy).comments);
          comments[0] = 1;
          return JSON.stringify(copy);
        },
      },
    ],
  },
];

describe('gh-schemas', () => {
  for (const parserCase of cases) {
    it(`accepts the real ${parserCase.shapeName} fixture`, () => {
      expect(parserCase.parse(readFixture(parserCase.fixture))).toBeDefined();
    });

    for (const invalidCase of parserCase.invalid) {
      it(`rejects ${parserCase.shapeName} fixtures with ${invalidCase.label}`, () => {
        const fixture = JSON.parse(readFixture(parserCase.fixture)) as unknown;
        expect(() => parserCase.parse(invalidCase.raw(fixture))).toThrow(
          `gh returned an invalid ${parserCase.shapeName} payload:`
        );
      });
    }
  }
});
