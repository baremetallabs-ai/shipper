export type { DiffFileHunks } from './diff-parse.js';
export { parseDiffHunks } from './diff-parse.js';

export {
  PROTOCOL_INPUT_DIR,
  PROTOCOL_OUTPUT_DIR,
  scrubOutputDir,
  setupProtocolDirs,
  truncateLargeInput,
  writeContextFile,
} from './protocol-io.js';

export {
  formatCorrectionMessage,
  retryPrReviewOutputAndSubmission,
  retryOnInvalidNewIssueDraft,
  retryOnInvalidOutput,
  validateStageOutput,
} from './protocol-validation.js';

export { createIssueFromDraft, readNewIssueDraft, writeCreatedIssueResult } from './new.js';

export type { NewIssueDraftJson, NewIssueDraftResultJson, ValidatedNewIssueDraft } from './new.js';

export {
  GroomPostFlightError,
  processGroomResult,
  readGroomManifest,
  replaceBlockingIssuePlaceholder,
  priorityLabelsForGroomPriority,
} from './groom.js';

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
  LoadedGroomManifest,
} from './groom.js';

export {
  createPrFromSpec,
  createPrFromSpecWithMetadata,
  executeTransition,
  handleAgentCrash,
  postComment,
  postReplies,
  processResult,
  submitReviewPayload,
} from './protocol-actions.js';
