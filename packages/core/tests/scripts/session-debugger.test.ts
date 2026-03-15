import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const hasJq =
  spawnSync('bash', ['-lc', 'command -v jq >/dev/null 2>&1'], { stdio: 'pipe' }).status === 0;
const describeIf = hasJq ? describe : describe.skip;

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../../../..');
const scriptsDir = path.join(repoRoot, '.claude/skills/session-debugger/scripts');
const rawCaptureWarning =
  'Raw capture file - structured extraction requires native Codex transcripts under ~/.codex/sessions/';

let tempDir: string;
let homeDir: string;
let repoDir: string;
let claudeLogFile: string;
let codexLogFile: string;

beforeAll(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'session-debugger-'));
  homeDir = path.join(tempDir, 'home');
  repoDir = path.join(tempDir, 'repo');
  claudeLogFile = path.join(
    homeDir,
    '.shipper',
    'sessions',
    'owner-repo',
    '308-implement-2026-03-15T23-25-12-345Z.jsonl'
  );
  codexLogFile = path.join(
    homeDir,
    '.shipper',
    'sessions',
    'owner-repo',
    '308-pr_review-2026-03-15T23-30-00-000Z.jsonl'
  );

  mkdirSync(path.dirname(claudeLogFile), { recursive: true });
  mkdirSync(repoDir, { recursive: true });

  writeFileSync(
    claudeLogFile,
    [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_01',
              name: 'Bash',
              input: { command: 'echo hello', description: 'Print hello' },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_01',
              content: 'hello',
              is_error: false,
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'READY\nImplemented logging.' }],
        },
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'READY\nImplemented logging.',
      }),
      '',
    ].join('\n')
  );
  writeFileSync(
    claudeLogFile.replace(/\.jsonl$/, '.meta.json'),
    `${JSON.stringify(
      {
        repo: 'owner/repo',
        issue: '308',
        stage: 'implement',
        agent: 'claude',
        model: 'claude-opus-4-6',
        timestamp: '2026-03-15T23:25:12.345Z',
        exitCode: 0,
        logFile: claudeLogFile,
      },
      null,
      2
    )}\n`
  );

  writeFileSync(codexLogFile, 'Codex raw stdout capture\nFinal line\n');
  writeFileSync(
    codexLogFile.replace(/\.jsonl$/, '.meta.json'),
    `${JSON.stringify(
      {
        repo: 'owner/repo',
        issue: '308',
        stage: 'pr_review',
        agent: 'codex',
        model: 'gpt-5',
        timestamp: '2026-03-15T23:30:00.000Z',
        exitCode: 0,
        logFile: codexLogFile,
      },
      null,
      2
    )}\n`
  );

  execFileSync('git', ['init'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:owner/repo.git'], {
    cwd: repoDir,
    stdio: 'pipe',
  });
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function runScript(
  scriptName: string,
  args: string[] = []
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('bash', [path.join(scriptsDir, scriptName), ...args], {
    cwd: repoDir,
    env: { ...process.env, HOME: homeDir },
    stdio: 'pipe',
    encoding: 'utf8',
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
  };
}

describeIf('session-debugger scripts', () => {
  it('finds shipper-captured sessions via metadata without native transcript directories', () => {
    const result = runScript('find-sessions.sh', ['308']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[claude]');
    expect(result.stdout).toContain('[codex]');
    expect(result.stdout).toContain(claudeLogFile);
    expect(result.stdout).toContain(codexLogFile);
  });

  it('classifies captured sessions from metadata', () => {
    const claudeResult = runScript('classify-session.sh', [claudeLogFile]);
    const codexResult = runScript('classify-session.sh', [codexLogFile]);

    expect(claudeResult.status).toBe(0);
    expect(claudeResult.stdout).toContain('Agent:   claude');
    expect(claudeResult.stdout).toContain('Stage:   implement');
    expect(claudeResult.stdout).toContain('Repo:    owner/repo');
    expect(claudeResult.stdout).toContain('Issue:   308');
    expect(claudeResult.stdout).toContain('Summary: READY');

    expect(codexResult.status).toBe(0);
    expect(codexResult.stdout).toContain('Agent:   codex');
    expect(codexResult.stdout).toContain('Stage:   pr_review');
    expect(codexResult.stdout).toContain('Repo:    owner/repo');
    expect(codexResult.stdout).toContain('Issue:   308');
    expect(codexResult.stdout).toContain('Summary: <unavailable for raw capture>');
  });

  it('extracts structured Claude data from shipper-captured stream-json logs', () => {
    const toolCalls = runScript('extract-tool-calls.sh', [claudeLogFile]);
    const errors = runScript('extract-errors.sh', [claudeLogFile]);
    const finalMessage = runScript('extract-final-message.sh', [claudeLogFile]);
    const verdict = runScript('extract-verdict.sh', [claudeLogFile]);
    const toolResult = runScript('show-tool-result.sh', [claudeLogFile, '1']);

    expect(toolCalls.status).toBe(0);
    expect(toolCalls.stdout).toContain('Bash');
    expect(toolCalls.stdout).toContain('echo hello');
    expect(toolCalls.stdout).toContain('OK');

    expect(errors.status).toBe(0);
    expect(errors.stdout).toContain('No errors found.');

    expect(finalMessage.status).toBe(0);
    expect(finalMessage.stdout).toContain('READY');
    expect(finalMessage.stdout).toContain('Implemented logging.');

    expect(verdict.status).toBe(0);
    expect(verdict.stdout).toContain('Verdict: READY');
    expect(verdict.stdout).toContain('No label changes found');

    expect(toolResult.status).toBe(0);
    expect(toolResult.stdout).toContain('=== Tool Call #1 ===');
    expect(toolResult.stdout).toContain('hello');
  });

  it('prints the raw-capture warning for unsupported Codex extractors', () => {
    const rawToolCalls = runScript('extract-tool-calls.sh', [codexLogFile]);
    const rawErrors = runScript('extract-errors.sh', [codexLogFile]);
    const rawFinalMessage = runScript('extract-final-message.sh', [codexLogFile]);
    const rawVerdict = runScript('extract-verdict.sh', [codexLogFile]);
    const rawToolResult = runScript('show-tool-result.sh', [codexLogFile, '1']);

    expect(rawToolCalls.status).toBe(0);
    expect(rawToolCalls.stdout.trim()).toBe(rawCaptureWarning);
    expect(rawErrors.stdout.trim()).toBe(rawCaptureWarning);
    expect(rawFinalMessage.stdout.trim()).toBe(rawCaptureWarning);
    expect(rawVerdict.stdout).toContain(rawCaptureWarning);
    expect(rawToolResult.stdout.trim()).toBe(rawCaptureWarning);
  });
});
