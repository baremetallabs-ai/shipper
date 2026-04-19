import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFakeCore } from '../_harness/fake-core.js';
import { postReplies, processResult } from '../../src/lib/output-protocol/protocol-actions.js';
import { validateStageOutput } from '../../src/lib/output-protocol/protocol-validation.js';
import { withIssueLock } from '../../src/lib/lock.js';

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
});
