import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const scriptsDir = path.resolve('src/scripts');

describe('gh-api-get-reviews.sh', () => {
  it('rejects wrong arg count', () => {
    expect(() => {
      execFileSync('bash', [path.join(scriptsDir, 'gh-api-get-reviews.sh')], { stdio: 'pipe' });
    }).toThrow();
  });

  it('prints usage on wrong arg count', () => {
    try {
      execFileSync('bash', [path.join(scriptsDir, 'gh-api-get-reviews.sh')], { stdio: 'pipe' });
    } catch (err: unknown) {
      const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? '';
      expect(stderr).toContain('Usage:');
    }
  });
});

describe('gh-api-reply-thread.sh', () => {
  it('rejects wrong arg count', () => {
    expect(() => {
      execFileSync('bash', [path.join(scriptsDir, 'gh-api-reply-thread.sh'), 'a', 'b'], {
        stdio: 'pipe',
      });
    }).toThrow();
  });
});

describe('gh-api-get-pr-files.sh', () => {
  it('rejects wrong arg count', () => {
    expect(() => {
      execFileSync('bash', [path.join(scriptsDir, 'gh-api-get-pr-files.sh')], { stdio: 'pipe' });
    }).toThrow();
  });
});

describe('gh-api-post-review.sh', () => {
  it('rejects wrong arg count', () => {
    expect(() => {
      execFileSync('bash', [path.join(scriptsDir, 'gh-api-post-review.sh'), 'a'], {
        stdio: 'pipe',
      });
    }).toThrow();
  });
});
