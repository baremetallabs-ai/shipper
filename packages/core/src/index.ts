// Curated public API for workspace consumers. New helpers default to internal.ts
// unless an external package needs them on the root surface.
export {
  findBranchForIssue,
  generateBranchName,
  getBranchForPR,
  getRepoRoot,
} from './lib/branch.js';
export type { CheckClassification, PRChecksLine } from './lib/checks.js';
export {
  classifyChecks,
  enrichFailedChecks,
  fetchChecks,
  rerunFailedChecks,
} from './lib/checks.js';
export { hasErrorCode, toError, toErrorMessage } from './lib/errors.js';
export type { DesktopControlState } from './lib/desktop-control.js';
export {
  DESKTOP_AGENT_GRACE_TIMEOUT_MS,
  DESKTOP_CONTROL_STATE_FILE,
  DESKTOP_FINALIZE_SENTINEL_FILE,
  DESKTOP_WRAPPER_DRAIN_TIMEOUT_MS,
  SHIPPER_DESKTOP_CONTROL_DIR_ENV,
  hasDesktopResultArtifact,
  isDesktopFinalizeRequested,
  readDesktopControlState,
  requestDesktopFinalize,
  resolveDesktopControlDir,
  writeDesktopControlState,
} from './lib/desktop-control.js';
export { PAUSED_EXIT_CODE, RETRIABLE_FAILURE_EXIT_CODE } from './lib/exit-codes.js';
export { MCP_GROOMING_FLAG, isMcpGroomingEnabled } from './lib/feature-flags.js';
export { gh } from './lib/gh.js';
export { GhPayloadError } from './lib/gh-json.js';
export type { MergeQueueSearchNode, PrViewForMerge } from './lib/gh-schemas.js';
export {
  parseIssueLabelsState,
  parseIssueNumberLabels,
  parseIssueNumberLabelsList,
  parseIssueStateTitle,
  parseIssueTitleLabelsList,
  parseMergeQueueSearch,
  parsePrBaseRefNameView,
  parsePrCreatedAtView,
  parsePrFilesPages,
  parsePrMergeStateView,
  parsePrStateMergedTitle,
  parsePrViewForMerge,
  parseQueuedPrList,
} from './lib/gh-schemas.js';
export type { ListIssueItem } from './lib/github.js';
export {
  autoSelectIssue,
  autoSelectPrForStage,
  clearStaleLockIfNeeded,
  fetchIssue,
  fetchIssueTimelines,
  listIssues,
  resolveBaseBranch,
  resolveRef,
  selectIssuesForStage,
  sortIssuesByLabelTime,
  tryResolvePrForIssue,
} from './lib/github.js';
export { withStageHooks } from './lib/hooks.js';
export type { LabelDefinition } from './lib/labels.js';
export {
  ALL_LABEL_NAMES,
  BLOCKED_LABEL,
  CONTROL_LABEL_NAMES,
  CONTROL_LABELS,
  DESIGNED_LABEL,
  DISPLAY_NAME_MAP,
  FAILED_LABEL,
  GROOMED_LABEL,
  IMPLEMENTED_LABEL,
  LABELS,
  LOCKED_LABEL,
  NEW_LABEL,
  PLANNED_LABEL,
  PRIORITY_HIGH_LABEL,
  PRIORITY_LABEL_NAMES,
  PRIORITY_LABELS,
  PRIORITY_LOW_LABEL,
  PR_OPEN_LABEL,
  PR_REVIEWED_LABEL,
  READY_LABEL,
  STAGE_LABEL_NAMES,
  STAGE_NAME_MAP,
  WORKFLOW_LABELS,
  getPriorityTier,
} from './lib/labels.js';
export {
  acquireIssueLock,
  isLockStale,
  releaseIssueLock,
  renewIssueLock,
  withIssueLock,
} from './lib/lock.js';
export type { Logger } from './lib/logger.js';
export { createLogger, getLogCaptureStream, logger, withLogCapture } from './lib/logger.js';
export type { QueuedPR } from './lib/merge-execution.js';
export { executeMerge, getLinkedIssueNumber, postMerge } from './lib/merge-execution.js';
export { parseDiffHunks } from './lib/output-protocol/index.js';
export {
  executeTransition,
  GroomPostFlightError,
  handleAgentCrash,
  postComment,
  postReplies,
  PROTOCOL_OUTPUT_DIR,
  processGroomResult,
  processResult,
  readGroomManifest,
  retryOnInvalidOutput,
  scrubOutputDir,
  setupProtocolDirs,
  truncateLargeInput,
  validateStageOutput,
  writeContextFile,
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
} from './lib/output-protocol/index.js';
export { __installFakeTransports } from './lib/testing-seams.js';
export {
  checkGhAuth,
  checkGhInstalled,
  checkGitHubRemote,
  checkGitRepo,
  checkLabels,
  maybeAutoSetupGit,
  runAuthPreflight,
  runPreflight,
  runPrereqChecks,
  warnTrackedOutputFiles,
} from './lib/prerequisites.js';
export type { DeferQuestion, DeferQuestionOption } from './lib/defer-stream.js';
export type { AnswerLine, DeferMarkerPayload } from './lib/defer-loop.js';
export { DEFER_MARKER_PREFIX, DEFER_MARKER_SUFFIX, parseDeferMarker } from './lib/defer-loop.js';
export type { RunPromptOpts } from './lib/prompt-runner.js';
export { buildPromptCommand, runPrompt } from './lib/prompt-runner.js';
export { agentPrompts } from './lib/prompts.js';
export { ensureRepoClone, ensureRepoCloneForWorktree } from './lib/repo-clone.js';
export { getRepoNwo } from './lib/repo.js';
export type { ArtifactScan, ResetOpResult, ResetResult, WorkflowStage } from './lib/reset.js';
export {
  executeReset,
  getCurrentStage,
  getStageIndex,
  getStageLabel,
  getValidTargets,
  getWorktreeRepoName,
  isClean,
  parseStage,
  scanArtifacts,
} from './lib/reset.js';
export type { CreatedIssueIdentity, NewResultJson, ResultJson } from './lib/result-schema.js';
export { readNewResultFile, readResultFile, validateNewResult } from './lib/result-schema.js';
export { scripts } from './lib/scripts.js';
export {
  aggregateAllIssueUsage,
  aggregateSessionUsage,
  findLatestSessionMeta,
  resolveSessionRepo,
  SHIPPER_SESSION_RUN_ID_ENV,
} from './lib/session.js';
export type {
  GitStatusEntry,
  GitStatusSnapshot,
  SetupFinalizeResult,
} from './lib/setup-finalize.js';
export { offerSetupFinalize, readGitStatusSnapshot } from './lib/setup-finalize.js';
export type { AgentName, CommandMode, PrReviewWait } from './lib/settings.js';
export {
  DEFAULTS,
  SETTING_DESCRIPTIONS,
  getSettings,
  loadSettings,
  resolveDisableMcp,
  resolveMode,
} from './lib/settings.js';
export { sleepMs } from './lib/sleep.js';
export type { StageRunResult, StageScaffoldOpts } from './lib/stage-scaffold.js';
export { runStageScaffold, simpleInvoker, transportInvoker } from './lib/stage-scaffold.js';
export type { LabelTransition, Verdict } from './lib/stage-transitions.js';
export { resolveTransition } from './lib/stage-transitions.js';
export { isPlainObject } from './lib/type-guards.js';
export type { TokenUsage } from './lib/token-usage.js';
export { totalTokens } from './lib/usage.js';
export { extractFinalMessage } from './lib/transcript.js';
export { CLI_VERSION, checkVersionFreshness } from './lib/version.js';
export type { CreateDesktopGroomWorktreeOpts, DesktopGroomWorktree } from './lib/worktree.js';
export {
  createDesktopGroomWorktree,
  formatConflictContext,
  getCommitsAheadCount,
  getGitRevParse,
  pushWithRetry,
  syncWorktree,
  withWorktree,
} from './lib/worktree.js';
export { default as readmeTemplate } from './templates/readme.js';
