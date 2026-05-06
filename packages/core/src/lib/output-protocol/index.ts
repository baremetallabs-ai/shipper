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
  retryOnInvalidOutput,
  validateStageOutput,
} from './protocol-validation.js';

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
  GroomDecompositionKind,
  GroomManifest,
  GroomParent,
  GroomPriority,
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
