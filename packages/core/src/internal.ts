// Internal barrel for helpers that are intentionally not part of the curated
// @baremetallabs-ai/shipper-core public API. It is emitted for internal builds but not
// exported from the package surface.
export * from './lib/frontmatter.js';
export * from './lib/result-schema.js';

export { getRepoRoot } from './lib/branch.js';
export type { FailedStep } from './lib/checks.js';
export { formatZodPath, ghJson, parseGhJson } from './lib/gh-json.js';
export type {
  Author,
  CommentIdCreatedAt,
  Issue,
  IssueLabelsState,
  IssueList,
  IssueListItem,
  IssueNumberLabels,
  IssueNumberLabelsList,
  IssueStateTitle,
  IssueTitleLabels,
  IssueTitleLabelsList,
  IssueWithLabelsBody,
  Label,
  MatchingRef,
  MatchingRefs,
  MergeQueueLabeledEvent,
  MergeQueueSearch,
  PageInfo,
  PrBaseRefNameView,
  PrBodyView,
  PrChecks,
  PrChecksLine,
  PrCreatedAtView,
  PrFile,
  PrFilesPage,
  PrFilesPages,
  PrHeadRefNameView,
  PrMergeStateView,
  PrNumberBodyView,
  PrReviewThread,
  PrReviewThreadComment,
  PrReviewThreads,
  PrStateMergedTitle,
  PrStateView,
  PrSummary,
  PrSummaryList,
  PullRequest,
  QueuedPr,
  QueuedPrList,
  Review,
  RunViewJob,
  RunViewJobs,
  RunViewStep,
  TimelineLabelEventPayload,
} from './lib/gh-schemas.js';
export {
  AuthorSchema,
  CommentIdCreatedAtSchema,
  IssueLabelsStateSchema,
  IssueListItemSchema,
  IssueListSchema,
  IssueNumberLabelsListSchema,
  IssueNumberLabelsSchema,
  IssueSchema,
  IssueStateTitleSchema,
  IssueTitleLabelsListSchema,
  IssueTitleLabelsSchema,
  IssueWithLabelsBodySchema,
  LabelSchema,
  MatchingRefsSchema,
  MatchingRefSchema,
  MergeQueueLabeledEventSchema,
  MergeQueueSearchNodeSchema,
  MergeQueueSearchSchema,
  PageInfoSchema,
  PrBaseRefNameViewSchema,
  PrBodyViewSchema,
  PrChecksLineSchema,
  PrChecksSchema,
  PrCreatedAtViewSchema,
  PrFileSchema,
  PrFilesPagesSchema,
  PrFilesPageSchema,
  PrHeadRefNameViewSchema,
  PrMergeStateViewSchema,
  PrNumberBodyViewSchema,
  PrReviewThreadCommentSchema,
  PrReviewThreadsSchema,
  PrReviewThreadSchema,
  PrStateMergedTitleSchema,
  PrStateViewSchema,
  PrSummaryListSchema,
  PrSummarySchema,
  PrViewForMergeSchema,
  PullRequestSchema,
  QueuedPrListSchema,
  QueuedPrSchema,
  ReviewSchema,
  RunViewJobsSchema,
  RunViewJobSchema,
  RunViewStepSchema,
  TimelineLabelEventSchema,
  parseCommentIdCreatedAt,
  parseIssue,
  parseIssueList,
  parseIssueWithLabelsBody,
  parseMatchingRefs,
  parsePrBodyView,
  parsePrChecks,
  parsePrHeadRefNameView,
  parsePrNumberBodyView,
  parsePrReviewThreads,
  parsePrStateView,
  parsePrSummaryList,
  parsePullRequest,
  parseRunViewJobs,
  parseTimelineLabelEvent,
} from './lib/gh-schemas.js';
export type {
  ListIssuesOptions,
  ResolvedRef,
  ResolvedRefBoth,
  StageIssueCandidate,
  TimelineLabelEvent,
} from './lib/github.js';
export { fetchPR, formatIssue, formatPR } from './lib/github.js';
export { runAdvisoryHook, runPostHook, runPreHook, runWorktreeHook } from './lib/hooks.js';
export { formatDuration } from './lib/logger.js';
export type { ExecuteMergeOptions } from './lib/merge-execution.js';
export { isPrMerged, pollPrMerged } from './lib/merge-execution.js';
export type { DiffFileHunks } from './lib/output-protocol/index.js';
export {
  createPrFromSpec,
  createPrFromSpecWithMetadata,
  formatCorrectionMessage,
  processGroomResult,
  readGroomManifest,
  submitReviewPayload,
} from './lib/output-protocol/index.js';
export type {
  GroomBlocked,
  GroomChildIssue,
  GroomClosedManifest,
  GroomClosedOutcome,
  GroomDecompositionKind,
  GroomManifest,
  GroomOpenManifest,
  GroomParent,
  GroomPriority,
  GroomStageManifest,
} from './lib/output-protocol/index.js';
export { checkShipperDir } from './lib/prerequisites.js';
export type { PromptCommand } from './lib/prompt-runner.js';
export { getRepoClonePath } from './lib/repo-clone.js';
export type {
  ArtifactScan,
  CurrentStage,
  ExecuteResetOptions,
  PREntry,
  ResetOpResult,
  ResetOpStatus,
  ScanArtifactsOptions,
} from './lib/reset.js';
export type { SessionMeta, SessionRepoInfo } from './lib/session.js';
export {
  getSessionDir,
  getSessionPaths,
  persistNewResultForLatestSession,
  resolveSessionRepo,
  SHIPPER_SESSION_RUN_ID_ENV,
  writeSessionMeta,
} from './lib/session.js';
export type { CommandConfig, MergeSettings, Settings } from './lib/settings.js';
export { resolveAgent, resolveDisableMcp } from './lib/settings.js';
export type {
  ScaffoldResultStage,
  ScaffoldStage,
  StageInvocation,
  StageInvokerFactory,
} from './lib/stage-scaffold.js';
export type { StageName, Verdict } from './lib/stage-transitions.js';
export type { TokenUsage } from './lib/usage.js';
export { formatUsageLine, parseAgentUsage } from './lib/usage.js';
export type {
  ConflictContext,
  CreateWorktreeOpts,
  CreateWorktreeResult,
  WorktreeGitOpts,
} from './lib/worktree.js';
export {
  createWorktree,
  getWorktreePath,
  pushWorktree,
  removeWorktree,
  withGitTransport,
} from './lib/worktree.js';
