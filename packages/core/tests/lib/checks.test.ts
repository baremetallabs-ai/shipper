import { promisify } from 'node:util';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toError } from '../../src/lib/errors.js';

const execFileMock = vi.fn();

const execFile = Object.assign(
  (...args: unknown[]) => {
    execFileMock(...args);
  },
  {
    [promisify.custom]: (...args: unknown[]) =>
      new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        execFileMock(
          ...args,
          (err: unknown, stdout: string | Buffer = '', stderr: string | Buffer = '') => {
            if (err) {
              reject(toError(err));
              return;
            }
            resolve({ stdout: String(stdout), stderr: String(stderr) });
          }
        );
      }),
  }
);

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execFile };
});

const { fetchChecks, classifyChecks, enrichFailedChecks, rerunFailedChecks } =
  await import('../../src/lib/checks.js');
type PRChecksLine = import('../../src/lib/checks.js').PRChecksLine;
const repo = 'owner/repo';

beforeEach(() => {
  execFileMock.mockReset();
});

describe('fetchChecks', () => {
  it('calls gh pr checks with --json and parses output', async () => {
    const checks = [
      {
        name: 'build',
        state: 'COMPLETED',
        bucket: 'pass',
        link: 'https://github.com/owner/repo/actions/runs/123456789/job/987654321',
      },
    ];
    execFileMock.mockImplementation((_cmd: string, _args: string[], ...rest: unknown[]) => {
      const cb = rest[rest.length - 1] as (...cbArgs: unknown[]) => void;
      cb(null, JSON.stringify(checks), '');
    });

    const result = await fetchChecks(repo, '42');

    expect(execFileMock).toHaveBeenCalledWith(
      'gh',
      ['pr', 'checks', '42', '-R', repo, '--json', 'name,state,bucket,link'],
      expect.objectContaining({ encoding: 'utf-8' }),
      expect.any(Function)
    );
    expect(result).toEqual(checks);
  });

  it('always includes -R with the repo argument', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], ...rest: unknown[]) => {
      const cb = rest[rest.length - 1] as (...cbArgs: unknown[]) => void;
      cb(null, '[]', '');
    });

    await fetchChecks(repo, '42');

    expect(execFileMock).toHaveBeenCalledWith(
      'gh',
      ['pr', 'checks', '42', '-R', repo, '--json', 'name,state,bucket,link'],
      expect.objectContaining({ encoding: 'utf-8' }),
      expect.any(Function)
    );
  });
});

describe('enrichFailedChecks', () => {
  function respond(
    result:
      | { stdout: string; stderr?: string }
      | {
          error: Error;
          stdout?: string;
          stderr?: string;
        }
  ): (...cbArgs: unknown[]) => void {
    return (...cbArgs: unknown[]) => {
      const cb = cbArgs[cbArgs.length - 1] as (...args: unknown[]) => void;
      if ('error' in result) {
        cb(result.error, result.stdout ?? '', result.stderr ?? '');
        return;
      }

      cb(null, result.stdout, result.stderr ?? '');
    };
  }

  function mockGhCalls(
    handlers: Array<{
      match: (args: string[]) => boolean;
      result:
        | { stdout: string; stderr?: string }
        | {
            error: Error;
            stdout?: string;
            stderr?: string;
          };
    }>
  ): void {
    execFileMock.mockImplementation((_cmd: string, args: string[], ...rest: unknown[]) => {
      const handler = handlers.find((candidate) => candidate.match(args));
      if (!handler) {
        throw new Error(`Unexpected gh args: ${JSON.stringify(args)}`);
      }

      respond(handler.result)(...rest);
    });
  }

  function makeStepLog(jobName: string, stepName: string, lineCount: number): string {
    return Array.from({ length: lineCount }, (_, index) => {
      const lineNumber = index + 1;
      return `${jobName}\t${stepName}\t2026-03-16T18:00:${String(lineNumber).padStart(2, '0')}Z line ${lineNumber}`;
    }).join('\n');
  }

  it('enriches failed checks with all failing steps, snippets, and log dumps', async () => {
    const failedChecks: PRChecksLine[] = [
      {
        name: 'Build / lint (ubuntu)',
        state: 'COMPLETED',
        bucket: 'fail',
        link: 'https://github.com/owner/repo/actions/runs/123456789/job/444555666',
      },
    ];
    const lintLog = makeStepLog('Build / lint (ubuntu)', 'lint', 60);
    const testLog = makeStepLog('Build / lint (ubuntu)', 'test', 55);
    const fullLog = `${lintLog}\n${testLog}`;

    mockGhCalls([
      {
        match: (args) => args.join(' ') === `run view 123456789 -R ${repo} --json jobs`,
        result: {
          stdout: JSON.stringify({
            jobs: [
              {
                name: 'Build / lint (ubuntu)',
                conclusion: 'failure',
                databaseId: 444555666,
                steps: [
                  { name: 'setup', conclusion: 'success', number: 1, status: 'completed' },
                  { name: 'lint', conclusion: 'failure', number: 2, status: 'completed' },
                  { name: 'test', conclusion: 'failure', number: 3, status: 'completed' },
                ],
              },
            ],
          }),
        },
      },
      {
        match: (args) => args.join(' ') === `run view -R ${repo} --job 444555666 --log-failed`,
        result: {
          stdout: fullLog,
        },
      },
    ]);

    const logDumps = await enrichFailedChecks(repo, failedChecks);

    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(failedChecks[0]?.failedSteps).toEqual([{ name: 'lint' }, { name: 'test' }]);
    expect(logDumps).toEqual(new Map([['build-lint-ubuntu', fullLog]]));
  });

  it('skips checks without a link', async () => {
    const failedChecks: PRChecksLine[] = [{ name: 'build', state: 'COMPLETED', bucket: 'fail' }];

    const logDumps = await enrichFailedChecks(repo, failedChecks);

    expect(execFileMock).not.toHaveBeenCalled();
    expect(failedChecks[0]?.failedSteps).toBeUndefined();
    expect(logDumps).toEqual(new Map());
  });

  it('skips non-GitHub Actions links', async () => {
    const failedChecks: PRChecksLine[] = [
      {
        name: 'build',
        state: 'COMPLETED',
        bucket: 'fail',
        link: 'https://app.circleci.com/pipelines/github/owner/repo/123',
      },
    ];

    const logDumps = await enrichFailedChecks(repo, failedChecks);

    expect(execFileMock).not.toHaveBeenCalled();
    expect(failedChecks[0]?.failedSteps).toBeUndefined();
    expect(logDumps).toEqual(new Map());
  });

  it('skips checks when the job name does not match exactly', async () => {
    const failedChecks: PRChecksLine[] = [
      {
        name: 'build',
        state: 'COMPLETED',
        bucket: 'fail',
        link: 'https://github.com/owner/repo/actions/runs/123456789/job/444555666',
      },
    ];

    mockGhCalls([
      {
        match: (args) => args.join(' ') === `run view 123456789 -R ${repo} --json jobs`,
        result: {
          stdout: JSON.stringify({
            jobs: [
              {
                name: 'different-job',
                conclusion: 'failure',
                databaseId: 444555666,
                steps: [{ name: 'lint', conclusion: 'failure', number: 1, status: 'completed' }],
              },
            ],
          }),
        },
      },
    ]);

    const logDumps = await enrichFailedChecks(repo, failedChecks);

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(failedChecks[0]?.failedSteps).toBeUndefined();
    expect(logDumps).toEqual(new Map());
  });

  it('skips checks when the matched job has no failing steps', async () => {
    const failedChecks: PRChecksLine[] = [
      {
        name: 'build',
        state: 'COMPLETED',
        bucket: 'fail',
        link: 'https://github.com/owner/repo/actions/runs/123456789/job/444555666',
      },
    ];

    mockGhCalls([
      {
        match: (args) => args.join(' ') === `run view 123456789 -R ${repo} --json jobs`,
        result: {
          stdout: JSON.stringify({
            jobs: [
              {
                name: 'build',
                conclusion: 'failure',
                databaseId: 444555666,
                steps: [{ name: 'setup', conclusion: 'success', number: 1, status: 'completed' }],
              },
            ],
          }),
        },
      },
    ]);

    const logDumps = await enrichFailedChecks(repo, failedChecks);

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(failedChecks[0]?.failedSteps).toBeUndefined();
    expect(logDumps).toEqual(new Map());
  });

  it('warns and skips the check when gh run view fails', async () => {
    const failedChecks: PRChecksLine[] = [
      {
        name: 'build',
        state: 'COMPLETED',
        bucket: 'fail',
        link: 'https://github.com/owner/repo/actions/runs/123456789/job/444555666',
      },
    ];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    mockGhCalls([
      {
        match: (args) => args.join(' ') === `run view 123456789 -R ${repo} --json jobs`,
        result: {
          error: new Error('gh exploded'),
        },
      },
    ]);

    const logDumps = await enrichFailedChecks(repo, failedChecks);

    expect(warnSpy).toHaveBeenCalledWith(
      `[shipper] Warning: Failed to enrich CI check "build": gh run view 123456789 -R ${repo} --json jobs failed: gh exploded`
    );
    expect(failedChecks[0]?.failedSteps).toBeUndefined();
    expect(logDumps).toEqual(new Map());

    warnSpy.mockRestore();
  });

  it('falls back to the full failed log when step parsing cannot isolate a failed step', async () => {
    const failedChecks: PRChecksLine[] = [
      {
        name: 'build',
        state: 'COMPLETED',
        bucket: 'fail',
        link: 'https://github.com/owner/repo/actions/runs/123456789/job/444555666',
      },
    ];
    const fullLog = Array.from({ length: 60 }, (_, index) => `fallback line ${index + 1}`).join(
      '\n'
    );

    mockGhCalls([
      {
        match: (args) => args.join(' ') === `run view 123456789 -R ${repo} --json jobs`,
        result: {
          stdout: JSON.stringify({
            jobs: [
              {
                name: 'build',
                conclusion: 'failure',
                databaseId: 444555666,
                steps: [{ name: 'lint', conclusion: 'failure', number: 1, status: 'completed' }],
              },
            ],
          }),
        },
      },
      {
        match: (args) => args.join(' ') === `run view -R ${repo} --job 444555666 --log-failed`,
        result: {
          stdout: fullLog,
        },
      },
    ]);

    const logDumps = await enrichFailedChecks(repo, failedChecks);

    expect(failedChecks[0]?.failedSteps).toEqual([{ name: 'lint' }]);
    expect(logDumps).toEqual(new Map([['build', fullLog]]));
  });

  it('writes unique log dump keys when multiple checks sanitize to the same name', async () => {
    const failedChecks: PRChecksLine[] = [
      {
        name: 'Build / lint',
        state: 'COMPLETED',
        bucket: 'fail',
        link: 'https://github.com/owner/repo/actions/runs/123456789/job/444555666',
      },
      {
        name: 'Build - lint',
        state: 'COMPLETED',
        bucket: 'fail',
        link: 'https://github.com/owner/repo/actions/runs/123456790/job/444555667',
      },
    ];
    const firstLog = makeStepLog('Build / lint', 'lint', 2);
    const secondLog = makeStepLog('Build - lint', 'lint', 2);

    mockGhCalls([
      {
        match: (args) => args.join(' ') === `run view 123456789 -R ${repo} --json jobs`,
        result: {
          stdout: JSON.stringify({
            jobs: [
              {
                name: 'Build / lint',
                conclusion: 'failure',
                databaseId: 444555666,
                steps: [{ name: 'lint', conclusion: 'failure', number: 1, status: 'completed' }],
              },
            ],
          }),
        },
      },
      {
        match: (args) => args.join(' ') === `run view -R ${repo} --job 444555666 --log-failed`,
        result: {
          stdout: firstLog,
        },
      },
      {
        match: (args) => args.join(' ') === `run view 123456790 -R ${repo} --json jobs`,
        result: {
          stdout: JSON.stringify({
            jobs: [
              {
                name: 'Build - lint',
                conclusion: 'failure',
                databaseId: 444555667,
                steps: [{ name: 'lint', conclusion: 'failure', number: 1, status: 'completed' }],
              },
            ],
          }),
        },
      },
      {
        match: (args) => args.join(' ') === `run view -R ${repo} --job 444555667 --log-failed`,
        result: {
          stdout: secondLog,
        },
      },
    ]);

    const logDumps = await enrichFailedChecks(repo, failedChecks);

    expect(logDumps).toEqual(
      new Map([
        ['build-lint', firstLog],
        ['build-lint-444555667', secondLog],
      ])
    );
  });
});

describe('classifyChecks', () => {
  it('classifies all passing checks', () => {
    const checks: PRChecksLine[] = [
      { name: 'build', state: 'COMPLETED', bucket: 'pass' },
      { name: 'lint', state: 'COMPLETED', bucket: 'pass' },
    ];

    const result = classifyChecks(checks);

    expect(result.passed).toHaveLength(2);
    expect(result.pending).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
    expect(result.total).toBe(2);
  });

  it('classifies pending checks', () => {
    const checks: PRChecksLine[] = [
      { name: 'build', state: 'COMPLETED', bucket: 'pass' },
      { name: 'test', state: 'PENDING', bucket: 'pending' },
      { name: 'lint', state: 'IN_PROGRESS', bucket: 'pending' },
      { name: 'deploy', state: 'QUEUED', bucket: 'pending' },
    ];

    const result = classifyChecks(checks);

    expect(result.passed).toHaveLength(1);
    expect(result.pending).toHaveLength(3);
    expect(result.failed).toHaveLength(0);
    expect(result.total).toBe(4);
  });

  it('classifies failed checks', () => {
    const checks: PRChecksLine[] = [
      { name: 'build', state: 'COMPLETED', bucket: 'fail' },
      { name: 'test', state: 'COMPLETED', bucket: 'fail' },
      { name: 'lint', state: 'COMPLETED', bucket: 'cancel' },
    ];

    const result = classifyChecks(checks);

    expect(result.passed).toHaveLength(0);
    expect(result.pending).toHaveLength(0);
    expect(result.failed).toHaveLength(3);
    expect(result.total).toBe(3);
  });

  it('returns empty arrays for empty input', () => {
    const result = classifyChecks([]);

    expect(result).toEqual({ pending: [], failed: [], passed: [], total: 0 });
  });

  it('classifies skipped checks as passed', () => {
    const checks: PRChecksLine[] = [
      { name: 'optional', state: 'COMPLETED', bucket: 'skipping' },
      { name: 'neutral', state: 'COMPLETED', bucket: 'pass' },
    ];

    const result = classifyChecks(checks);

    expect(result.passed).toHaveLength(2);
    expect(result.pending).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });

  it('handles mixed states correctly', () => {
    const checks: PRChecksLine[] = [
      { name: 'build', state: 'COMPLETED', bucket: 'pass' },
      { name: 'test', state: 'IN_PROGRESS', bucket: 'pending' },
      { name: 'lint', state: 'COMPLETED', bucket: 'fail' },
      { name: 'deploy', state: 'COMPLETED', bucket: 'skipping' },
    ];

    const result = classifyChecks(checks);

    expect(result.passed).toHaveLength(2);
    expect(result.pending).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.total).toBe(4);
  });
});

describe('rerunFailedChecks', () => {
  function mockRerunCalls(
    handlers: Array<{
      match: (args: string[]) => boolean;
      result:
        | { stdout: string; stderr?: string }
        | {
            error: Error;
            stdout?: string;
            stderr?: string;
          };
    }>
  ): void {
    execFileMock.mockImplementation((_cmd: string, args: string[], ...rest: unknown[]) => {
      const handler = handlers.find((candidate) => candidate.match(args));
      if (!handler) {
        throw new Error(`Unexpected gh args: ${JSON.stringify(args)}`);
      }

      const cb = rest[rest.length - 1] as (...cbArgs: unknown[]) => void;
      if ('error' in handler.result) {
        cb(handler.result.error, handler.result.stdout ?? '', handler.result.stderr ?? '');
        return;
      }

      cb(null, handler.result.stdout, handler.result.stderr ?? '');
    });
  }

  it('deduplicates failed checks from the same run and reruns only failed jobs', async () => {
    const failedChecks: PRChecksLine[] = [
      {
        name: 'build',
        state: 'COMPLETED',
        bucket: 'fail',
        link: 'https://github.com/owner/repo/actions/runs/123456789/job/111',
      },
      {
        name: 'test',
        state: 'COMPLETED',
        bucket: 'fail',
        link: 'https://github.com/owner/repo/actions/runs/123456789/job/222',
      },
    ];

    mockRerunCalls([
      {
        match: (args) => args.join(' ') === `run rerun 123456789 --failed -R ${repo}`,
        result: { stdout: '' },
      },
    ]);

    await expect(rerunFailedChecks(repo, failedChecks)).resolves.toBeUndefined();

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledWith(
      'gh',
      ['run', 'rerun', '123456789', '--failed', '-R', repo],
      expect.objectContaining({ encoding: 'utf-8' }),
      expect.any(Function)
    );
  });

  it('reruns each distinct failed workflow run individually', async () => {
    const failedChecks: PRChecksLine[] = [
      {
        name: 'build',
        state: 'COMPLETED',
        bucket: 'fail',
        link: 'https://github.com/owner/repo/actions/runs/123456789/job/111',
      },
      {
        name: 'test',
        state: 'COMPLETED',
        bucket: 'fail',
        link: 'https://github.com/owner/repo/actions/runs/987654321/job/222',
      },
    ];

    mockRerunCalls([
      {
        match: (args) => args.join(' ') === `run rerun 123456789 --failed -R ${repo}`,
        result: { stdout: '' },
      },
      {
        match: (args) => args.join(' ') === `run rerun 987654321 --failed -R ${repo}`,
        result: { stdout: '' },
      },
    ]);

    await expect(rerunFailedChecks(repo, failedChecks)).resolves.toBeUndefined();

    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(execFileMock).toHaveBeenNthCalledWith(
      1,
      'gh',
      ['run', 'rerun', '123456789', '--failed', '-R', repo],
      expect.objectContaining({ encoding: 'utf-8' }),
      expect.any(Function)
    );
    expect(execFileMock).toHaveBeenNthCalledWith(
      2,
      'gh',
      ['run', 'rerun', '987654321', '--failed', '-R', repo],
      expect.objectContaining({ encoding: 'utf-8' }),
      expect.any(Function)
    );
  });

  it('ignores failed checks without GitHub Actions run links', async () => {
    const failedChecks: PRChecksLine[] = [
      { name: 'build', state: 'COMPLETED', bucket: 'fail' },
      {
        name: 'test',
        state: 'COMPLETED',
        bucket: 'fail',
        link: 'https://app.circleci.com/pipelines/github/owner/repo/123',
      },
    ];

    await expect(rerunFailedChecks(repo, failedChecks)).resolves.toBeUndefined();

    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('warns and continues when rerunning a workflow fails', async () => {
    const failedChecks: PRChecksLine[] = [
      {
        name: 'build',
        state: 'COMPLETED',
        bucket: 'fail',
        link: 'https://github.com/owner/repo/actions/runs/123456789/job/111',
      },
      {
        name: 'test',
        state: 'COMPLETED',
        bucket: 'fail',
        link: 'https://github.com/owner/repo/actions/runs/987654321/job/222',
      },
    ];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    mockRerunCalls([
      {
        match: (args) => args.join(' ') === `run rerun 123456789 --failed -R ${repo}`,
        result: {
          error: Object.assign(new Error('rerun exploded'), { stderr: 'HTTP 422: rerun exploded' }),
        },
      },
      {
        match: (args) => args.join(' ') === `run rerun 987654321 --failed -R ${repo}`,
        result: { stdout: '' },
      },
    ]);

    await expect(rerunFailedChecks(repo, failedChecks)).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      `[shipper] Warning: Failed to re-run workflow 123456789: gh run rerun 123456789 --failed -R ${repo} failed: HTTP 422: rerun exploded\n\nstderr:\nHTTP 422: rerun exploded`
    );
    expect(execFileMock).toHaveBeenCalledTimes(2);

    warnSpy.mockRestore();
  });
});
