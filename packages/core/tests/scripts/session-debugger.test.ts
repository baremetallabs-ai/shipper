import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../../../..');
const scriptsDir = path.join(repoRoot, '.claude', 'skills', 'session-debugger', 'scripts');
const tempRoots: string[] = [];

function makeTempRoot(): string {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'shipper-session-debugger-'));
  tempRoots.push(tempRoot);
  return tempRoot;
}

function setupRepo(tempRoot: string): string {
  const repoDir = path.join(tempRoot, 'repo');
  mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:owner/repo.git'], {
    cwd: repoDir,
    stdio: 'ignore',
  });
  return repoDir;
}

function writeJsonl(file: string, records: Array<Record<string, unknown>>): void {
  writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
}

function runScript(
  scriptName: string,
  args: string[],
  opts: { cwd: string; home: string }
): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync('bash', [path.join(scriptsDir, scriptName), ...args], {
    cwd: opts.cwd,
    env: { ...process.env, HOME: opts.home },
    stdio: 'pipe',
  });

  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.status ?? 1,
  };
}

afterEach(() => {
  for (const tempRoot of tempRoots.splice(0)) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

describe('session-debugger scripts', () => {
  it('finds shipper sessions via metadata and classifies them without heuristics', () => {
    const tempRoot = makeTempRoot();
    const homeDir = path.join(tempRoot, 'home');
    const repoDir = setupRepo(tempRoot);
    const sessionDir = path.join(homeDir, '.shipper', 'sessions', 'owner-repo');
    const logFile = path.join(sessionDir, '308-plan-2026-03-15T14-00-01-234Z.jsonl');
    const metaFile = path.join(sessionDir, '308-plan-2026-03-15T14-00-01-234Z.meta.json');

    mkdirSync(sessionDir, { recursive: true });
    writeJsonl(logFile, [
      {
        type: 'system',
        subtype: 'init',
        cwd: repoDir,
      },
      {
        type: 'user',
        cwd: repoDir,
        gitBranch: 'main',
        message: {
          role: 'user',
          content: '# Issue #308: Add session logging',
        },
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will inspect the logging path.' },
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'Bash',
              input: { command: 'npm test', description: 'Run tests' },
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: 'all tests passed',
              is_error: false,
            },
          ],
        },
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'READY\nImplementation complete.' }],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        result: 'ok',
      },
    ]);
    writeFileSync(
      metaFile,
      JSON.stringify(
        {
          repo: 'owner/repo',
          issue: '308',
          stage: 'plan',
          agent: 'claude',
          model: 'claude-opus-4-6',
          timestamp: '2026-03-15T14:00:01.234Z',
          exitCode: 0,
          logFile,
        },
        null,
        2
      )
    );

    const findSessions = runScript('find-sessions.sh', ['308'], { cwd: repoDir, home: homeDir });
    expect(findSessions.exitCode).toBe(0);
    expect(findSessions.stdout).toContain(`[claude]`);
    expect(findSessions.stdout).toContain(logFile);

    const classify = runScript('classify-session.sh', [logFile], { cwd: repoDir, home: homeDir });
    expect(classify.exitCode).toBe(0);
    expect(classify.stdout).toContain('Agent:   claude');
    expect(classify.stdout).toContain('Stage:   plan');
    expect(classify.stdout).toContain('Issue:   308');

    const toolCalls = runScript('extract-tool-calls.sh', [logFile], {
      cwd: repoDir,
      home: homeDir,
    });
    expect(toolCalls.exitCode).toBe(0);
    expect(toolCalls.stdout).toContain('Bash');
    expect(toolCalls.stdout).toContain('npm test');

    const errors = runScript('extract-errors.sh', [logFile], { cwd: repoDir, home: homeDir });
    expect(errors.exitCode).toBe(0);
    expect(errors.stdout).toContain('No errors found.');

    const finalMessage = runScript('extract-final-message.sh', [logFile], {
      cwd: repoDir,
      home: homeDir,
    });
    expect(finalMessage.exitCode).toBe(0);
    expect(finalMessage.stdout).toContain('READY');

    const verdict = runScript('extract-verdict.sh', [logFile], { cwd: repoDir, home: homeDir });
    expect(verdict.exitCode).toBe(0);
    expect(verdict.stdout).toContain('Verdict: READY');

    const toolResult = runScript('show-tool-result.sh', [logFile, '1'], {
      cwd: repoDir,
      home: homeDir,
    });
    expect(toolResult.exitCode).toBe(0);
    expect(toolResult.stdout).toContain('all tests passed');
  });

  it('prints a clear message for raw Codex capture files', () => {
    const tempRoot = makeTempRoot();
    const homeDir = path.join(tempRoot, 'home');
    const repoDir = setupRepo(tempRoot);
    const sessionDir = path.join(homeDir, '.shipper', 'sessions', 'owner-repo');
    const logFile = path.join(sessionDir, '308-implement-2026-03-15T14-00-01-234Z.jsonl');
    const metaFile = path.join(sessionDir, '308-implement-2026-03-15T14-00-01-234Z.meta.json');

    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(logFile, 'raw codex stdout\nnot json\n');
    writeFileSync(
      metaFile,
      JSON.stringify(
        {
          repo: 'owner/repo',
          issue: '308',
          stage: 'implement',
          agent: 'codex',
          model: 'gpt-5',
          timestamp: '2026-03-15T14:00:01.234Z',
          exitCode: 0,
          logFile,
        },
        null,
        2
      )
    );

    const toolCalls = runScript('extract-tool-calls.sh', [logFile], {
      cwd: repoDir,
      home: homeDir,
    });
    expect(toolCalls.exitCode).toBe(0);
    expect(toolCalls.stdout).toContain(
      'This is a raw capture file - structured extraction requires native Codex transcripts under ~/.codex/sessions/'
    );
  });
});
