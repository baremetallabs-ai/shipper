import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const script = path.resolve('src/scripts/install-deps.sh');
const tmpDir = path.resolve('tests/scripts/.install-deps-tmp');
const shipperDir = path.join(tmpDir, '.shipper');
const settingsFile = path.join(shipperDir, 'settings.json');

beforeAll(() => {
  mkdirSync(shipperDir, { recursive: true });
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function runScript(cwd: string): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync('bash', [script], {
    cwd,
    stdio: 'pipe',
    env: { ...process.env },
  });
  return {
    stdout: result.stdout?.toString() ?? '',
    stderr: result.stderr?.toString() ?? '',
    exitCode: result.status ?? 1,
  };
}

describe('install-deps.sh', () => {
  it('runs the configured installCommand', () => {
    writeFileSync(settingsFile, JSON.stringify({ installCommand: 'echo installed' }));
    const result = runScript(tmpDir);
    expect(result.stdout).toContain('Running: echo installed');
    expect(result.stdout).toContain('installed');
    expect(result.exitCode).toBe(0);
  });

  it('prints warning and exits 0 when no installCommand is set', () => {
    writeFileSync(settingsFile, JSON.stringify({}));
    const result = runScript(tmpDir);
    expect(result.stderr).toContain('No installCommand configured');
    expect(result.exitCode).toBe(0);
  });

  it('prints warning and exits 0 when settings.json is missing', () => {
    const emptyDir = path.join(tmpDir, 'no-settings');
    mkdirSync(emptyDir, { recursive: true });
    const result = runScript(emptyDir);
    expect(result.stderr).toContain('not found');
    expect(result.exitCode).toBe(0);
    rmSync(emptyDir, { recursive: true, force: true });
  });

  it('exits with non-zero when installCommand fails', () => {
    writeFileSync(settingsFile, JSON.stringify({ installCommand: 'false' }));
    const result = runScript(tmpDir);
    expect(result.exitCode).not.toBe(0);
  });
});
