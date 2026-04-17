import { logger } from '../logger.js';
import { installWithRemediation } from './install.js';
import { pushWithRetry } from './push.js';
import {
  MAX_REBASE_ATTEMPTS,
  execAsync,
  formatCommandFailure,
  formatTransportError,
  spawnAsync,
  syncWithRemoteBranch,
  type ConflictContext,
  type WorktreeGitOpts,
} from './helpers.js';
import {
  abortRebase,
  appendAbortFailure,
  buildConflictContext,
  getConflictContextOrThrow,
  getRetryFailureText,
  isRebaseComplete,
  stageResolvedFiles,
} from './conflicts.js';

type RebaseRetryOutcome = { kind: 'success' } | { kind: 'agent-non-zero'; code: number };

async function rebaseWithRetries(
  opts: WorktreeGitOpts,
  initialRebase: { code: number; stdout: string; stderr: string },
  runConflictAgent: (conflictContext: ConflictContext) => Promise<number>
): Promise<RebaseRetryOutcome> {
  const targetRef = `origin/${opts.baseBranch}`;
  let conflictContext = await getConflictContextOrThrow(opts, targetRef, initialRebase);

  for (let attempt = 1; attempt <= MAX_REBASE_ATTEMPTS; attempt++) {
    const agentCode = await runConflictAgent(conflictContext);
    if (agentCode !== 0) {
      return { kind: 'agent-non-zero', code: agentCode };
    }

    await stageResolvedFiles(opts.wtPath);
    const continueResult = await execAsync('git', ['rebase', '--continue'], {
      cwd: opts.wtPath,
      env: { GIT_EDITOR: 'true' },
    });
    if (continueResult.code === 0) {
      return { kind: 'success' };
    }

    const continueError = getRetryFailureText(continueResult);
    if (attempt === MAX_REBASE_ATTEMPTS) {
      const abortFailure = await abortRebase(opts.wtPath);
      throw formatTransportError(
        opts,
        appendAbortFailure(
          `Could not complete rebase onto ${targetRef} after ${MAX_REBASE_ATTEMPTS} conflict resolution attempts.\n${continueError}`,
          abortFailure
        )
      );
    }

    const nextConflictContext = await buildConflictContext(opts.wtPath, continueError);
    if (!nextConflictContext) {
      if (await isRebaseComplete(opts.wtPath)) {
        return { kind: 'success' };
      }

      const abortFailure = await abortRebase(opts.wtPath);
      throw formatTransportError(
        opts,
        appendAbortFailure(
          `git rebase --continue failed without unresolved files.\n${formatCommandFailure(
            'git',
            ['rebase', '--continue'],
            continueResult
          )}`,
          abortFailure
        )
      );
    }
    conflictContext = nextConflictContext;
  }

  throw formatTransportError(
    opts,
    `Could not complete rebase onto ${targetRef} after ${MAX_REBASE_ATTEMPTS} conflict resolution attempts.`
  );
}

export async function syncWorktree(
  opts: WorktreeGitOpts,
  resolveConflicts: (conflictContext: ConflictContext) => Promise<number>,
  remediateInstallError?: (installError: string) => Promise<number>
): Promise<void> {
  await spawnAsync('git', ['fetch', 'origin'], { cwd: opts.wtPath });
  await syncWithRemoteBranch(opts);

  const initialRebase = await execAsync(
    'git',
    ['rebase', '--autostash', `origin/${opts.baseBranch}`],
    { cwd: opts.wtPath }
  );
  if (initialRebase.code === 0) {
    const installCode = await installWithRemediation(opts.wtPath, remediateInstallError);
    if (installCode !== undefined) {
      throw formatTransportError(opts, `Install remediation agent exited with code ${installCode}`);
    }
    return;
  }

  const outcome = await rebaseWithRetries(opts, initialRebase, resolveConflicts);
  if (outcome.kind === 'agent-non-zero') {
    const abortFailure = await abortRebase(opts.wtPath);
    throw formatTransportError(
      opts,
      appendAbortFailure(`Conflict resolution exited with code ${outcome.code}`, abortFailure)
    );
  }

  const installCode = await installWithRemediation(opts.wtPath, remediateInstallError);
  if (installCode !== undefined) {
    throw formatTransportError(opts, `Install remediation agent exited with code ${installCode}`);
  }
}

export async function withGitTransport(
  opts: WorktreeGitOpts,
  runAgent: (
    conflictContext?: ConflictContext,
    pushError?: string,
    installError?: string
  ) => Promise<number>
): Promise<number> {
  await spawnAsync('git', ['fetch', 'origin'], { cwd: opts.wtPath });
  await syncWithRemoteBranch(opts);

  const initialRebase = await execAsync(
    'git',
    ['rebase', '--autostash', `origin/${opts.baseBranch}`],
    { cwd: opts.wtPath }
  );

  if (initialRebase.code !== 0) {
    const outcome = await rebaseWithRetries(opts, initialRebase, (conflictContext) =>
      runAgent(conflictContext)
    );
    if (outcome.kind === 'agent-non-zero') {
      logger.error(`Agent exited with code ${outcome.code} — skipping push.`);
      return outcome.code;
    }

    const installCode = await installWithRemediation(opts.wtPath, (installError) =>
      runAgent(undefined, undefined, installError)
    );
    if (installCode !== undefined) {
      logger.error(`Agent exited with code ${installCode} — skipping push.`);
      return installCode;
    }

    return await pushWithRetry(opts, runAgent);
  }

  const installCode = await installWithRemediation(opts.wtPath, (installError) =>
    runAgent(undefined, undefined, installError)
  );
  if (installCode !== undefined) {
    logger.error(`Agent exited with code ${installCode} — skipping push.`);
    return installCode;
  }

  const agentCode = await runAgent();
  if (agentCode !== 0) {
    logger.error(`Agent exited with code ${agentCode} — proceeding to push.`);
  }

  return await pushWithRetry(opts, runAgent);
}
