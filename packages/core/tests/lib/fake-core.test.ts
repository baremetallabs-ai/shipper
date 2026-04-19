import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { __installFakeTransports } from '../../src/index.js';
import { gh } from '../../src/lib/gh.js';
import { createFakeCore } from '../_harness/fake-core.js';
import { postReplies, processResult } from '../../src/lib/output-protocol/protocol-actions.js';
import { validateStageOutput } from '../../src/lib/output-protocol/protocol-validation.js';
import { withIssueLock } from '../../src/lib/lock.js';
import { getCommitsAheadCount, getGitRevParse } from '../../src/lib/worktree.js';

describe('fakeCore harness', () => {
  let fake: ReturnType<typeof createFakeCore>;

  beforeEach(() => {
    fake = createFakeCore();
    fake.install();
  });

  afterEach(async () => {
    await fake.dispose();
  });

  it('drives real lock and output-protocol behavior from core tests', async () => {
    fake.setIssue('10', { labels: ['shipper:pr-reviewed'] });
    fake.setPr('42', { labels: ['shipper:pr-reviewed'] });

    await fake.writeStageOutput({
      result: {
        verdict: 'accept',
        comment: '.shipper/output/comment-10.md',
      },
      commentBody: '## Implementation Summary\n\nDone.',
      replies: {
        '101': 'Applied the change.',
      },
    });

    await withIssueLock('owner/repo', '10', async () => {
      expect(fake.state.issues.get('10')?.labels.has('shipper:locked')).toBe(true);

      const result = await validateStageOutput(fake.wtPath(), 'pr_remediate');
      await postReplies('owner/repo', '42', fake.wtPath(), result.replies);
      await processResult({
        repo: 'owner/repo',
        issueNumber: '10',
        stage: 'pr_remediate',
        cwd: fake.wtPath(),
        result,
        prNumber: '42',
      });
    });

    expect(fake.state.issues.get('10')?.labels).toEqual(new Set(['shipper:ready']));
    expect(fake.state.prs.get('42')?.labels).toEqual(new Set(['shipper:ready']));
    expect(fake.state.issues.get('10')?.labels.has('shipper:locked')).toBe(false);
    expect(fake.state.postedComments).toEqual([
      {
        target: 'issue',
        number: '10',
        body: '## Implementation Summary\n\nDone.',
      },
    ]);
    expect(fake.state.postedReplies).toEqual([
      {
        pr: '42',
        commentId: '101',
        body: 'Applied the change.',
      },
    ]);
  });

  it('starts each test with clean harness state', () => {
    expect(fake.state.issues.size).toBe(0);
    expect(fake.state.prs.size).toBe(0);
    expect(fake.state.postedComments).toEqual([]);
    expect(fake.state.postedReplies).toEqual([]);
  });

  it('resolves gh body and input files relative to cwd', async () => {
    fake.setIssue('10');
    fake.setPr('42');

    const outputDir = path.join(fake.wtPath(), '.shipper', 'output');
    await mkdir(outputDir, { recursive: true });
    await writeFile(path.join(outputDir, 'comment.md'), 'Comment from cwd', 'utf-8');
    await writeFile(
      path.join(outputDir, 'review.json'),
      '{"event":"COMMENT","body":"Review from cwd"}',
      'utf-8'
    );

    await gh(
      ['issue', 'comment', '10', '-R', 'owner/repo', '--body-file', '.shipper/output/comment.md'],
      {
        cwd: fake.wtPath(),
      }
    );
    await gh(
      [
        'api',
        'repos/owner/repo/pulls/42/reviews',
        '--method',
        'POST',
        '--input',
        '.shipper/output/review.json',
      ],
      {
        cwd: fake.wtPath(),
      }
    );

    expect(fake.state.postedComments).toContainEqual({
      target: 'issue',
      number: '10',
      body: 'Comment from cwd',
    });
    expect(fake.state.submittedReviews).toContainEqual({
      pr: '42',
      body: '{"event":"COMMENT","body":"Review from cwd"}',
    });
  });

  it('forwards explicit paths to scripted git helper seams', async () => {
    const gitRevParseCalls: Array<{ cwd: string; ref: string }> = [];
    const commitsAheadCalls: Array<{ wtPath: string; baseBranch: string }> = [];

    fake.scriptGitRevParse((cwd, ref) => {
      gitRevParseCalls.push({ cwd, ref });
      return 'scripted-head';
    });
    fake.scriptCommitsAhead((wtPath, baseBranch) => {
      commitsAheadCalls.push({ wtPath, baseBranch });
      return 3;
    });

    await expect(getGitRevParse('/tmp/custom-worktree', 'HEAD')).resolves.toBe('scripted-head');
    await expect(getCommitsAheadCount('/tmp/custom-worktree', 'main')).resolves.toBe(3);
    expect(gitRevParseCalls).toEqual([{ cwd: '/tmp/custom-worktree', ref: 'HEAD' }]);
    expect(commitsAheadCalls).toEqual([{ wtPath: '/tmp/custom-worktree', baseBranch: 'main' }]);
  });

  it('keeps unrelated seam overrides installed across nested partial installs', async () => {
    const restoreOuter = __installFakeTransports({
      getCommitsAheadCount: () => 7,
    });
    const restoreInner = __installFakeTransports({
      runPrompt: () => 0,
    });

    try {
      await expect(getCommitsAheadCount('/tmp/not-a-repo', 'main')).resolves.toBe(7);
    } finally {
      restoreInner();
      restoreOuter();
    }

    await expect(getCommitsAheadCount('/tmp/not-a-repo', 'main')).resolves.toBe(1);
  });
});
