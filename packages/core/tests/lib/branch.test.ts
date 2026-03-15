import { promisify } from 'node:util';
import { beforeEach, describe, it, expect, vi } from 'vitest';

const execFileMock = vi.fn();
function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

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
              reject(normalizeError(err));
              return;
            }
            resolve({ stdout: String(stdout), stderr: String(stderr) });
          }
        );
      }),
  }
);

vi.mock('node:child_process', () => ({
  execFile,
}));

const { generateBranchName, findBranchForIssue } = await import('../../src/lib/branch.js');
const repo = 'owner/repo';

beforeEach(() => {
  execFileMock.mockReset();
  execFileMock.mockImplementation((_cmd: string, args: string[], ...rest: unknown[]) => {
    const cb = rest[rest.length - 1] as (...cbArgs: unknown[]) => void;
    if (args.includes('--jq')) {
      cb(null, 'Add Login Flow\n', '');
      return;
    }
    cb(null, '', '');
  });
});

describe('generateBranchName', () => {
  it('generates a slug from the issue title', async () => {
    const result = await generateBranchName(repo, '42');
    expect(result).toBe('shipper/42-add-login-flow');
    expect(execFileMock).toHaveBeenCalledWith(
      'gh',
      ['issue', 'view', '42', '-R', repo, '--json', 'title', '--jq', '.title'],
      expect.objectContaining({ encoding: 'utf-8' }),
      expect.any(Function)
    );
  });

  it('strips leading # from issue ref', async () => {
    const result = await generateBranchName(repo, '#42');
    expect(result).toBe('shipper/42-add-login-flow');
  });

  it('handles special characters in title', async () => {
    execFileMock.mockImplementationOnce((_cmd: string, _args: string[], ...rest: unknown[]) => {
      const cb = rest[rest.length - 1] as (...cbArgs: unknown[]) => void;
      cb(null, 'Fix: login & signup (v2)!!!\n', '');
    });

    const result = await generateBranchName(repo, '10');
    expect(result).toBe('shipper/10-fix-login-signup-v2');
  });

  it('truncates long slugs', async () => {
    execFileMock.mockImplementationOnce((_cmd: string, _args: string[], ...rest: unknown[]) => {
      const cb = rest[rest.length - 1] as (...cbArgs: unknown[]) => void;
      cb(null, 'a'.repeat(100) + '\n', '');
    });

    const result = await generateBranchName(repo, '7');
    expect(result.length).toBeLessThanOrEqual(60); // "shipper/7-" (10) + 50-char slug max
  });

  it('falls back to implement when title fetch fails', async () => {
    execFileMock.mockImplementationOnce((_cmd: string, _args: string[], ...rest: unknown[]) => {
      const cb = rest[rest.length - 1] as (...cbArgs: unknown[]) => void;
      cb(Object.assign(new Error('gh failed'), { stderr: 'HTTP 404 not found' }));
    });

    const result = await generateBranchName(repo, '99');
    expect(result).toBe('shipper/99-implement');
  });
});

describe('findBranchForIssue', () => {
  it('strips worktree + prefix from local branch fallback', async () => {
    execFileMock.mockReset();
    execFileMock.mockImplementation((_cmd: string, args: string[], ...rest: unknown[]) => {
      const cb = rest[rest.length - 1] as (...cbArgs: unknown[]) => void;
      if (args.includes('--prune')) {
        // git fetch origin --prune
        cb(null, '', '');
        return;
      }
      if (args.includes('-r')) {
        // git branch -r — no remote branches found
        cb(null, '', '');
        return;
      }
      if (args.includes('--list')) {
        // git branch --list — branch checked out in a worktree
        cb(null, '+ shipper/260-fix-prompts-remove-leniency\n', '');
        return;
      }
      cb(null, '', '');
    });

    const result = await findBranchForIssue('260');
    expect(result).toBe('shipper/260-fix-prompts-remove-leniency');
  });

  it('strips current branch * prefix from local branch fallback', async () => {
    execFileMock.mockReset();
    execFileMock.mockImplementation((_cmd: string, args: string[], ...rest: unknown[]) => {
      const cb = rest[rest.length - 1] as (...cbArgs: unknown[]) => void;
      if (args.includes('--prune')) {
        cb(null, '', '');
        return;
      }
      if (args.includes('-r')) {
        cb(null, '', '');
        return;
      }
      if (args.includes('--list')) {
        cb(null, '* shipper/42-add-login-flow\n', '');
        return;
      }
      cb(null, '', '');
    });

    const result = await findBranchForIssue('42');
    expect(result).toBe('shipper/42-add-login-flow');
  });
});
