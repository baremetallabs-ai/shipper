import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ghMock = vi.fn();

vi.mock('../../src/lib/gh.js', () => ({
  gh: (...args: unknown[]) => ghMock(...args),
}));

const { processResult } = await import('../../src/lib/postflight.js');
const { MissingResultError, InvalidResultError } = await import('../../src/lib/result-schema.js');

let outputDir: string;

async function writeResult(result: object): Promise<void> {
  await writeFile(path.join(outputDir, 'result.json'), JSON.stringify(result), 'utf-8');
}

beforeEach(async () => {
  outputDir = await mkdtemp(path.join(tmpdir(), 'shipper-postflight-'));
  ghMock.mockReset();
  ghMock.mockResolvedValue({ stdout: '', stderr: '' });
});

afterEach(async () => {
  await rm(outputDir, { recursive: true, force: true });
});

describe('processResult', () => {
  it('posts the comment then applies accept label transitions', async () => {
    await writeFile(path.join(outputDir, 'comment.md'), 'Implemented\n', 'utf-8');
    await writeResult({ verdict: 'accept', comment: 'comment.md' });

    await processResult('implement', {
      repo: 'owner/repo',
      issueRef: '248',
      outputDir,
    });

    expect(ghMock).toHaveBeenNthCalledWith(
      1,
      [
        'issue',
        'comment',
        '248',
        '-R',
        'owner/repo',
        '--body-file',
        path.join(outputDir, 'comment.md'),
      ],
      { cwd: undefined }
    );
    expect(ghMock).toHaveBeenNthCalledWith(
      2,
      [
        'issue',
        'edit',
        '248',
        '-R',
        'owner/repo',
        '--add-label',
        'shipper:implemented',
        '--remove-label',
        'shipper:planned',
      ],
      { cwd: undefined }
    );
  });

  it('applies reject and fail transitions without stage-specific side effects', async () => {
    await writeFile(path.join(outputDir, 'comment.md'), 'Nope\n', 'utf-8');

    await writeResult({ verdict: 'reject', comment: 'comment.md' });
    await processResult('plan', { repo: 'owner/repo', issueRef: '248', outputDir });
    expect(ghMock).toHaveBeenLastCalledWith(
      [
        'issue',
        'edit',
        '248',
        '-R',
        'owner/repo',
        '--add-label',
        'shipper:groomed',
        '--remove-label',
        'shipper:designed',
      ],
      { cwd: undefined }
    );

    ghMock.mockClear();
    await writeResult({ verdict: 'fail', comment: 'comment.md' });
    await processResult('plan', { repo: 'owner/repo', issueRef: '248', outputDir });
    expect(ghMock).toHaveBeenLastCalledWith(
      [
        'issue',
        'edit',
        '248',
        '-R',
        'owner/repo',
        '--add-label',
        'shipper:failed',
        '--remove-label',
        'shipper:designed',
      ],
      { cwd: undefined }
    );
  });

  it('creates a PR from pr_spec before advancing labels', async () => {
    await writeFile(path.join(outputDir, 'comment.md'), 'Open PR\n', 'utf-8');
    await writeFile(path.join(outputDir, 'body.md'), 'PR body\n', 'utf-8');
    await writeFile(
      path.join(outputDir, 'pr-spec.json'),
      JSON.stringify({
        title: 'feat: protocol',
        base: 'main',
        body: 'body.md',
        head: 'feature/protocol',
        draft: true,
      }),
      'utf-8'
    );
    await writeResult({ verdict: 'accept', comment: 'comment.md', pr_spec: 'pr-spec.json' });

    await processResult('pr_open', { repo: 'owner/repo', issueRef: '248', outputDir });

    expect(ghMock).toHaveBeenNthCalledWith(
      2,
      [
        'pr',
        'create',
        '-R',
        'owner/repo',
        '--base',
        'main',
        '--title',
        'feat: protocol',
        '--body-file',
        path.join(outputDir, 'body.md'),
        '--head',
        'feature/protocol',
        '--draft',
      ],
      { cwd: undefined }
    );
    expect(ghMock).toHaveBeenNthCalledWith(
      3,
      [
        'issue',
        'edit',
        '248',
        '-R',
        'owner/repo',
        '--add-label',
        'shipper:pr-open',
        '--remove-label',
        'shipper:implemented',
      ],
      { cwd: undefined }
    );
  });

  it('submits review payloads and still advances pr_review on REQUEST_CHANGES', async () => {
    await writeFile(path.join(outputDir, 'comment.md'), 'Review posted\n', 'utf-8');
    await writeFile(
      path.join(outputDir, 'review.json'),
      JSON.stringify({
        commit_id: 'abc',
        body: 'Needs fixes',
        event: 'REQUEST_CHANGES',
        comments: [],
      }),
      'utf-8'
    );
    await writeResult({ verdict: 'accept', comment: 'comment.md', review_payload: 'review.json' });

    await processResult('pr_review', {
      repo: 'owner/repo',
      issueRef: '248',
      prRef: '19',
      outputDir,
    });

    expect(ghMock).toHaveBeenNthCalledWith(
      2,
      [
        'api',
        'repos/owner/repo/pulls/19/reviews',
        '--method',
        'POST',
        '--input',
        path.join(outputDir, 'review.json'),
      ],
      { cwd: undefined }
    );
    expect(ghMock).toHaveBeenNthCalledWith(
      3,
      [
        'issue',
        'edit',
        '248',
        '-R',
        'owner/repo',
        '--add-label',
        'shipper:pr-reviewed',
        '--remove-label',
        'shipper:pr-open',
      ],
      { cwd: undefined }
    );
  });

  it('posts replies from the replies directory in numeric filename order', async () => {
    await writeFile(path.join(outputDir, 'comment.md'), 'Remediated\n', 'utf-8');
    await mkdir(path.join(outputDir, 'replies'));
    await writeFile(path.join(outputDir, 'replies', '10'), 'Reply ten\n', 'utf-8');
    await writeFile(path.join(outputDir, 'replies', '2'), 'Reply two\n', 'utf-8');
    await writeResult({ verdict: 'accept', comment: 'comment.md', replies: 'replies' });

    await processResult('pr_remediate', {
      repo: 'owner/repo',
      issueRef: '248',
      prRef: '19',
      outputDir,
    });

    expect(ghMock).toHaveBeenNthCalledWith(
      2,
      [
        'api',
        'repos/owner/repo/pulls/19/comments/2/replies',
        '--method',
        'POST',
        '-f',
        'body=Reply two\n',
      ],
      { cwd: undefined }
    );
    expect(ghMock).toHaveBeenNthCalledWith(
      3,
      [
        'api',
        'repos/owner/repo/pulls/19/comments/10/replies',
        '--method',
        'POST',
        '-f',
        'body=Reply ten\n',
      ],
      { cwd: undefined }
    );
    expect(ghMock).toHaveBeenNthCalledWith(
      4,
      [
        'issue',
        'edit',
        '248',
        '-R',
        'owner/repo',
        '--add-label',
        'shipper:ready',
        '--remove-label',
        'shipper:pr-reviewed',
      ],
      { cwd: undefined }
    );
  });

  it('throws before any side effects when result.json is missing or malformed', async () => {
    await expect(
      processResult('implement', { repo: 'owner/repo', issueRef: '248', outputDir })
    ).rejects.toThrowError(MissingResultError);
    expect(ghMock).not.toHaveBeenCalled();

    await writeFile(path.join(outputDir, 'result.json'), '{', 'utf-8');
    await expect(
      processResult('implement', { repo: 'owner/repo', issueRef: '248', outputDir })
    ).rejects.toThrowError(InvalidResultError);
    expect(ghMock).not.toHaveBeenCalled();
  });
});
