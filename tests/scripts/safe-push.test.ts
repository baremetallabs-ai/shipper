import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import path from 'node:path';

const script = path.resolve('src/scripts/safe-push.sh');
const mockBinDir = path.resolve('tests/scripts/.mock-bin');
const mockGit = path.join(mockBinDir, 'git');

beforeAll(() => {
  // Create a mock git that just exits 0 so tests don't actually push
  mkdirSync(mockBinDir, { recursive: true });
  writeFileSync(mockGit, '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(mockGit, 0o755);
});

afterAll(() => {
  rmSync(mockBinDir, { recursive: true, force: true });
});

function runScript(...args: string[]) {
  return execFileSync('bash', [script, ...args], {
    stdio: 'pipe',
    env: { ...process.env, PATH: `${mockBinDir}:${process.env.PATH}` },
  });
}

function getStderr(...args: string[]): string {
  try {
    runScript(...args);
    return '';
  } catch (err: unknown) {
    return (err as { stderr?: Buffer }).stderr?.toString() ?? '';
  }
}

describe('safe-push.sh', () => {
  it('rejects --force flag', () => {
    expect(() => runScript('--force')).toThrow();
    expect(getStderr('--force')).toContain('--force push is not allowed');
  });

  it('rejects -f flag', () => {
    expect(() => runScript('-f')).toThrow();
    expect(getStderr('-f')).toContain('-f (force) push is not allowed');
  });

  it('rejects combined short flags containing f (e.g. -fu)', () => {
    expect(() => runScript('-fu')).toThrow();
    expect(getStderr('-fu')).toContain('-f (force) push is not allowed');
  });

  it('rejects force refspecs starting with +', () => {
    expect(() => runScript('+main:main')).toThrow();
    expect(getStderr('+main:main')).toContain("Force push refspecs (starting with '+')");
  });

  it('does not reject --force-with-lease', () => {
    expect(() => runScript('--force-with-lease')).not.toThrow();
  });

  it('does not reject -u origin HEAD', () => {
    expect(() => runScript('-u', 'origin', 'HEAD')).not.toThrow();
  });
});
