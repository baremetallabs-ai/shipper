import type { getBranchForPR, getRepoRoot } from './branch.js';
import { __setGetBranchForPRImpl, __setGetRepoRootImpl } from './branch.js';
import type { gh } from './gh.js';
import { __setGhImpl } from './gh.js';
import type { runPrompt } from './prompt-runner.js';
import { __setRunPromptImpl } from './prompt-runner.js';
import type { sleepMs } from './sleep.js';
import { __setSleepMsImpl } from './sleep.js';
import type {
  getCommitsAheadCount,
  getGitRevParse,
  pushWithRetry,
  syncWorktree,
  withWorktree,
} from './worktree.js';
import {
  __setGetCommitsAheadCountImpl,
  __setGetGitRevParseImpl,
  __setPushWithRetryImpl,
  __setSyncWorktreeImpl,
  __setWithWorktreeImpl,
} from './worktree.js';

export interface FakeTransportOverrides {
  gh?: typeof gh;
  runPrompt?: typeof runPrompt;
  withWorktree?: typeof withWorktree;
  syncWorktree?: typeof syncWorktree;
  pushWithRetry?: typeof pushWithRetry;
  getRepoRoot?: typeof getRepoRoot;
  getBranchForPR?: typeof getBranchForPR;
  getGitRevParse?: typeof getGitRevParse;
  getCommitsAheadCount?: typeof getCommitsAheadCount;
  sleepMs?: typeof sleepMs;
}

/**
 * Test-only hook for swapping external transport seams while keeping core logic real.
 */
export function __installFakeTransports(overrides: FakeTransportOverrides = {}): () => void {
  const restoreGh = __setGhImpl(overrides.gh);
  const restoreRunPrompt = __setRunPromptImpl(overrides.runPrompt);
  const restoreWithWorktree = __setWithWorktreeImpl(overrides.withWorktree);
  const restoreSyncWorktree = __setSyncWorktreeImpl(overrides.syncWorktree);
  const restorePushWithRetry = __setPushWithRetryImpl(overrides.pushWithRetry);
  const restoreGetRepoRoot = __setGetRepoRootImpl(overrides.getRepoRoot);
  const restoreGetBranchForPR = __setGetBranchForPRImpl(overrides.getBranchForPR);
  const restoreGetGitRevParse = __setGetGitRevParseImpl(overrides.getGitRevParse);
  const restoreGetCommitsAheadCount = __setGetCommitsAheadCountImpl(overrides.getCommitsAheadCount);
  const restoreSleepMs = __setSleepMsImpl(overrides.sleepMs);

  return () => {
    __setGhImpl(restoreGh);
    __setRunPromptImpl(restoreRunPrompt);
    __setWithWorktreeImpl(restoreWithWorktree);
    __setSyncWorktreeImpl(restoreSyncWorktree);
    __setPushWithRetryImpl(restorePushWithRetry);
    __setGetRepoRootImpl(restoreGetRepoRoot);
    __setGetBranchForPRImpl(restoreGetBranchForPR);
    __setGetGitRevParseImpl(restoreGetGitRevParse);
    __setGetCommitsAheadCountImpl(restoreGetCommitsAheadCount);
    __setSleepMsImpl(restoreSleepMs);
  };
}
