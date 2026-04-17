import { z } from 'zod';
import { parseGhJson } from './gh-json.js';

function makeParser<T>(schema: z.ZodType<T>, shapeName: string): (json: string) => T {
  return (json) => parseGhJson(json, schema, shapeName);
}

export const AuthorSchema = z.object({
  login: z.string(),
});
export type Author = z.infer<typeof AuthorSchema>;

export const LabelSchema = z.object({
  name: z.string(),
});
export type Label = z.infer<typeof LabelSchema>;

export const CommentSchema = z.object({
  author: AuthorSchema,
  body: z.string(),
  createdAt: z.string(),
});
export type Comment = z.infer<typeof CommentSchema>;

export const ReviewSchema = z.object({
  author: AuthorSchema,
  body: z.string(),
  state: z.string(),
  submittedAt: z.string().nullable(),
});
export type Review = z.infer<typeof ReviewSchema>;

export const IssueSchema = z.object({
  number: z.number(),
  title: z.string(),
  state: z.string(),
  labels: z.array(LabelSchema),
  body: z.string(),
  comments: z.array(CommentSchema),
  author: AuthorSchema,
  createdAt: z.string(),
});
export type Issue = z.infer<typeof IssueSchema>;
export const parseIssue = makeParser(IssueSchema, 'Issue');

export const PullRequestSchema = IssueSchema.extend({
  headRefName: z.string(),
  baseRefName: z.string(),
  reviews: z.array(ReviewSchema),
});
export type PullRequest = z.infer<typeof PullRequestSchema>;
export const parsePullRequest = makeParser(PullRequestSchema, 'PullRequest');

export const IssueListItemSchema = z.object({
  number: z.number(),
  title: z.string(),
  state: z.string(),
  labels: z.array(LabelSchema),
  author: AuthorSchema.nullable(),
  createdAt: z.string(),
  url: z.string(),
});
export type IssueListItem = z.infer<typeof IssueListItemSchema>;
export const IssueListSchema = z.array(IssueListItemSchema);
export type IssueList = z.infer<typeof IssueListSchema>;
export const parseIssueList = makeParser(IssueListSchema, 'IssueList');

export const IssueTitleLabelsSchema = z.object({
  number: z.number(),
  title: z.string(),
  labels: z.array(LabelSchema),
});
export type IssueTitleLabels = z.infer<typeof IssueTitleLabelsSchema>;
export const IssueTitleLabelsListSchema = z.array(IssueTitleLabelsSchema);
export type IssueTitleLabelsList = z.infer<typeof IssueTitleLabelsListSchema>;
export const parseIssueTitleLabelsList = makeParser(
  IssueTitleLabelsListSchema,
  'IssueTitleLabelsList'
);

export const IssueNumberLabelsSchema = z.object({
  number: z.number(),
  labels: z.array(LabelSchema),
});
export type IssueNumberLabels = z.infer<typeof IssueNumberLabelsSchema>;
export const parseIssueNumberLabels = makeParser(IssueNumberLabelsSchema, 'IssueNumberLabels');

export const IssueNumberLabelsListSchema = z.array(IssueNumberLabelsSchema);
export type IssueNumberLabelsList = z.infer<typeof IssueNumberLabelsListSchema>;
export const parseIssueNumberLabelsList = makeParser(
  IssueNumberLabelsListSchema,
  'IssueNumberLabelsList'
);

export const IssueLabelsStateSchema = z.object({
  number: z.number(),
  state: z.string(),
  labels: z.array(LabelSchema),
});
export type IssueLabelsState = z.infer<typeof IssueLabelsStateSchema>;
export const parseIssueLabelsState = makeParser(IssueLabelsStateSchema, 'IssueLabelsState');

export const IssueStateTitleSchema = z.object({
  title: z.string(),
  state: z.string(),
});
export type IssueStateTitle = z.infer<typeof IssueStateTitleSchema>;
export const parseIssueStateTitle = makeParser(IssueStateTitleSchema, 'IssueStateTitle');

export const PrSummarySchema = z.object({
  number: z.number(),
  headRefName: z.string(),
});
export type PrSummary = z.infer<typeof PrSummarySchema>;
export const PrSummaryListSchema = z.array(PrSummarySchema);
export type PrSummaryList = z.infer<typeof PrSummaryListSchema>;
export const parsePrSummaryList = makeParser(PrSummaryListSchema, 'PrSummaryList');

export const QueuedPrSchema = z.object({
  number: z.number(),
  title: z.string(),
  headRefName: z.string(),
  baseRefName: z.string(),
});
export type QueuedPr = z.infer<typeof QueuedPrSchema>;
export const QueuedPrListSchema = z.array(QueuedPrSchema);
export type QueuedPrList = z.infer<typeof QueuedPrListSchema>;
export const parseQueuedPrList = makeParser(QueuedPrListSchema, 'QueuedPrList');

export const PrViewForMergeSchema = z.object({
  number: z.number(),
  title: z.string(),
  headRefName: z.string(),
  baseRefName: z.string(),
  state: z.string(),
  labels: z.array(LabelSchema),
});
export type PrViewForMerge = z.infer<typeof PrViewForMergeSchema>;
export const parsePrViewForMerge = makeParser(PrViewForMergeSchema, 'PrViewForMerge');

export const PrMergeStateViewSchema = z.object({
  mergeStateStatus: z.string(),
  mergeable: z.string().nullable().optional(),
});
export type PrMergeStateView = z.infer<typeof PrMergeStateViewSchema>;
export const parsePrMergeStateView = makeParser(PrMergeStateViewSchema, 'PrMergeStateView');

export const PrBodyViewSchema = z.object({
  body: z.string(),
});
export type PrBodyView = z.infer<typeof PrBodyViewSchema>;
export const parsePrBodyView = makeParser(PrBodyViewSchema, 'PrBodyView');

export const PrNumberBodyViewSchema = z.object({
  number: z.number(),
  body: z.string(),
});
export type PrNumberBodyView = z.infer<typeof PrNumberBodyViewSchema>;
export const parsePrNumberBodyView = makeParser(PrNumberBodyViewSchema, 'PrNumberBodyView');

export const PrStateViewSchema = z.object({
  state: z.string(),
});
export type PrStateView = z.infer<typeof PrStateViewSchema>;
export const parsePrStateView = makeParser(PrStateViewSchema, 'PrStateView');

export const PrCreatedAtViewSchema = z.object({
  createdAt: z.string(),
});
export type PrCreatedAtView = z.infer<typeof PrCreatedAtViewSchema>;
export const parsePrCreatedAtView = makeParser(PrCreatedAtViewSchema, 'PrCreatedAtView');

export const PrBaseRefNameViewSchema = z.object({
  baseRefName: z.string(),
});
export type PrBaseRefNameView = z.infer<typeof PrBaseRefNameViewSchema>;
export const parsePrBaseRefNameView = makeParser(PrBaseRefNameViewSchema, 'PrBaseRefNameView');

export const PrHeadRefNameViewSchema = z.object({
  headRefName: z.string(),
});
export type PrHeadRefNameView = z.infer<typeof PrHeadRefNameViewSchema>;
export const parsePrHeadRefNameView = makeParser(PrHeadRefNameViewSchema, 'PrHeadRefNameView');

export const DependencyPrSchema = z.object({
  title: z.string(),
  state: z.string(),
  mergedAt: z.string().nullable(),
});
export type DependencyPr = z.infer<typeof DependencyPrSchema>;
export const parseDependencyPr = makeParser(DependencyPrSchema, 'DependencyPr');

export const PrChecksLineSchema = z.object({
  name: z.string(),
  state: z.string(),
  bucket: z.string(),
  link: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined),
});
export type PrChecksLine = z.infer<typeof PrChecksLineSchema>;
export const PrChecksSchema = z.array(PrChecksLineSchema);
export type PrChecks = z.infer<typeof PrChecksSchema>;
export const parsePrChecks = makeParser(PrChecksSchema, 'PrChecks');

export const RunViewStepSchema = z.object({
  name: z.string(),
  conclusion: z.string().nullable(),
  number: z.number(),
  status: z.string(),
});
export type RunViewStep = z.infer<typeof RunViewStepSchema>;

export const RunViewJobSchema = z.object({
  name: z.string(),
  conclusion: z.string().nullable(),
  databaseId: z.number(),
  steps: z.array(RunViewStepSchema),
});
export type RunViewJob = z.infer<typeof RunViewJobSchema>;

export const RunViewJobsSchema = z.object({
  jobs: z.array(RunViewJobSchema),
});
export type RunViewJobs = z.infer<typeof RunViewJobsSchema>;
export const parseRunViewJobs = makeParser(RunViewJobsSchema, 'RunViewJobs');

export const TimelineLabelEventSchema = z.object({
  event: z.string(),
  label: LabelSchema.optional(),
  created_at: z.string().optional(),
});
export type TimelineLabelEventPayload = z.infer<typeof TimelineLabelEventSchema>;
export const parseTimelineLabelEvent = makeParser(TimelineLabelEventSchema, 'TimelineLabelEvent');

export const CommentIdCreatedAtSchema = z.object({
  id: z.number(),
  created_at: z.string(),
});
export type CommentIdCreatedAt = z.infer<typeof CommentIdCreatedAtSchema>;
export const parseCommentIdCreatedAt = makeParser(CommentIdCreatedAtSchema, 'CommentIdCreatedAt');

export const MatchingRefSchema = z.object({
  ref: z.string(),
});
export type MatchingRef = z.infer<typeof MatchingRefSchema>;
export const MatchingRefsSchema = z.array(MatchingRefSchema);
export type MatchingRefs = z.infer<typeof MatchingRefsSchema>;
export const parseMatchingRefs = makeParser(MatchingRefsSchema, 'MatchingRefs');

export const PrFileSchema = z.object({
  filename: z.string(),
});
export type PrFile = z.infer<typeof PrFileSchema>;
export const PrFilesPageSchema = z.array(PrFileSchema);
export type PrFilesPage = z.infer<typeof PrFilesPageSchema>;
export const PrFilesPagesSchema = z.array(PrFilesPageSchema);
export type PrFilesPages = z.infer<typeof PrFilesPagesSchema>;
export const parsePrFilesPages = makeParser(PrFilesPagesSchema, 'PrFilesPages');

export const MergeQueueLabeledEventSchema = z.object({
  createdAt: z.string(),
  label: LabelSchema.optional(),
});
export type MergeQueueLabeledEvent = z.infer<typeof MergeQueueLabeledEventSchema>;

export const MergeQueueSearchNodeSchema = z.object({
  number: z.number(),
  title: z.string(),
  headRefName: z.string(),
  baseRefName: z.string(),
  timelineItems: z.object({
    nodes: z.array(MergeQueueLabeledEventSchema),
  }),
});
export type MergeQueueSearchNode = z.infer<typeof MergeQueueSearchNodeSchema>;

export const PageInfoSchema = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable(),
});
export type PageInfo = z.infer<typeof PageInfoSchema>;

export const MergeQueueSearchSchema = z.object({
  data: z.object({
    search: z.object({
      nodes: z.array(MergeQueueSearchNodeSchema),
      pageInfo: PageInfoSchema,
    }),
  }),
});
export type MergeQueueSearch = z.infer<typeof MergeQueueSearchSchema>;
export const parseMergeQueueSearch = makeParser(MergeQueueSearchSchema, 'MergeQueueSearch');

export const PrReviewThreadCommentSchema = z.object({
  id: z.number(),
  author: z.string(),
  body: z.string(),
  createdAt: z.string(),
});
export type PrReviewThreadComment = z.infer<typeof PrReviewThreadCommentSchema>;

export const PrReviewThreadSchema = z.object({
  path: z.string().nullable().optional(),
  line: z.number().nullable().optional(),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  comments: z.array(PrReviewThreadCommentSchema),
});
export type PrReviewThread = z.infer<typeof PrReviewThreadSchema>;

export const PrReviewThreadsSchema = z.array(PrReviewThreadSchema);
export type PrReviewThreads = z.infer<typeof PrReviewThreadsSchema>;
export const parsePrReviewThreads = makeParser(PrReviewThreadsSchema, 'PrReviewThreads');
