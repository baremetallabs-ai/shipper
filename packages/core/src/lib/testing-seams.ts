import type { getBranchForPR, getRepoRoot } from './branch.js';
import { __setGetBranchForPRImpl, __setGetRepoRootImpl } from './branch.js';
import type { gh } from './gh.js';
import { __setGhImpl } from './gh.js';
import type { runPrompt } from './prompt-runner.js';
import { __setRunPromptImpl } from './prompt-runner.js';
import type { aggregateSessionUsage } from './session.js';
import { __setAggregateSessionUsageImpl } from './session.js';
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
  aggregateSessionUsage?: typeof aggregateSessionUsage;
}

/**
 * Test-only hook for swapping external transport seams while keeping core logic real.
 */
export function __installFakeTransports(overrides: FakeTransportOverrides = {}): () => void {
  const restoreFns: Array<() => void> = [];
  const hasOwn = (key: keyof FakeTransportOverrides): boolean =>
    Object.prototype.hasOwnProperty.call(overrides, key);

  if (hasOwn('gh')) {
    const restoreGh = __setGhImpl(overrides.gh);
    restoreFns.push(() => {
      __setGhImpl(restoreGh);
    });
  }

  if (hasOwn('runPrompt')) {
    const restoreRunPrompt = __setRunPromptImpl(overrides.runPrompt);
    restoreFns.push(() => {
      __setRunPromptImpl(restoreRunPrompt);
    });
  }

  if (hasOwn('withWorktree')) {
    const restoreWithWorktree = __setWithWorktreeImpl(overrides.withWorktree);
    restoreFns.push(() => {
      __setWithWorktreeImpl(restoreWithWorktree);
    });
  }

  if (hasOwn('syncWorktree')) {
    const restoreSyncWorktree = __setSyncWorktreeImpl(overrides.syncWorktree);
    restoreFns.push(() => {
      __setSyncWorktreeImpl(restoreSyncWorktree);
    });
  }

  if (hasOwn('pushWithRetry')) {
    const restorePushWithRetry = __setPushWithRetryImpl(overrides.pushWithRetry);
    restoreFns.push(() => {
      __setPushWithRetryImpl(restorePushWithRetry);
    });
  }

  if (hasOwn('getRepoRoot')) {
    const restoreGetRepoRoot = __setGetRepoRootImpl(overrides.getRepoRoot);
    restoreFns.push(() => {
      __setGetRepoRootImpl(restoreGetRepoRoot);
    });
  }

  if (hasOwn('getBranchForPR')) {
    const restoreGetBranchForPR = __setGetBranchForPRImpl(overrides.getBranchForPR);
    restoreFns.push(() => {
      __setGetBranchForPRImpl(restoreGetBranchForPR);
    });
  }

  if (hasOwn('getGitRevParse')) {
    const restoreGetGitRevParse = __setGetGitRevParseImpl(overrides.getGitRevParse);
    restoreFns.push(() => {
      __setGetGitRevParseImpl(restoreGetGitRevParse);
    });
  }

  if (hasOwn('getCommitsAheadCount')) {
    const restoreGetCommitsAheadCount = __setGetCommitsAheadCountImpl(
      overrides.getCommitsAheadCount
    );
    restoreFns.push(() => {
      __setGetCommitsAheadCountImpl(restoreGetCommitsAheadCount);
    });
  }

  if (hasOwn('sleepMs')) {
    const restoreSleepMs = __setSleepMsImpl(overrides.sleepMs);
    restoreFns.push(() => {
      __setSleepMsImpl(restoreSleepMs);
    });
  }

  if (hasOwn('aggregateSessionUsage')) {
    const restoreAggregateSessionUsage = __setAggregateSessionUsageImpl(
      overrides.aggregateSessionUsage
    );
    restoreFns.push(() => {
      __setAggregateSessionUsageImpl(restoreAggregateSessionUsage);
    });
  }

  return () => {
    for (let index = restoreFns.length - 1; index >= 0; index -= 1) {
      restoreFns[index]?.();
    }
  };
}
