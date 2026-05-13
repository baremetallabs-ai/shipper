import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CLAUDE_SETTINGS_RELATIVE_PATH,
  DEFER_BRIDGE_RELATIVE_PATH,
  SHIPPER_MCP_BRIDGE_ENV,
  SHIPPER_QUESTION_BRIDGE_DIR_ENV,
  SHIPPER_QUESTION_BRIDGE_TIMEOUT_MS_ENV,
  buildClaudeSettings,
  installDeferBridge,
  isMcpBridgeEnabled,
} from '../../src/lib/defer-bridge.js';

interface RunBridgeResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface HookOutput {
  hookSpecificOutput: {
    hookEventName: string;
    permissionDecision: string;
    updatedInput?: {
      questions?: unknown[];
      answers?: Record<string, string>;
    };
    permissionDecisionReason?: string;
  };
}

interface BridgeRequest {
  requestId: string;
  sessionId: string;
  toolUseId: string;
  questions: { question: string; header?: string; options: unknown[]; multiSelect: boolean }[];
  answerPath: string;
  createdAt: string;
}

interface SettingsShape {
  hooks: {
    PreToolUse: {
      matcher: string;
      hooks: { type: string; command: string; timeout: number }[];
    }[];
  };
}

function parseHookOutput(json: string): HookOutput {
  return JSON.parse(json) as HookOutput;
}

function parseSettings(json: string): SettingsShape {
  return JSON.parse(json) as SettingsShape;
}

function hookInput(toolUseId: string, question = 'Which framework?'): string {
  return JSON.stringify({
    session_id: 'sess_abc123',
    tool_use_id: toolUseId,
    tool_input: {
      questions: [
        {
          question,
          header: 'Framework',
          options: [
            { label: 'React', description: 'React lib' },
            { label: 'Vue', description: 'Vue framework' },
          ],
        },
      ],
    },
  });
}

function startBridge(
  scriptPath: string,
  stdin: string,
  env: Record<string, string | undefined> = {}
): { done: Promise<RunBridgeResult> } {
  const child = spawn(process.execPath, [scriptPath], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const done = new Promise<RunBridgeResult>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
  child.stdin.on('error', () => undefined);
  child.stdin.end(stdin);
  return { done };
}

async function runBridge(
  scriptPath: string,
  stdin: string,
  env: Record<string, string | undefined> = {}
): Promise<RunBridgeResult> {
  return await startBridge(scriptPath, stdin, env).done;
}

async function readRequests(bridgeDir: string, expectedCount: number): Promise<BridgeRequest[]> {
  const requestsDir = path.join(bridgeDir, 'requests');
  for (let attempt = 0; attempt < 80; attempt += 1) {
    let files: string[] = [];
    try {
      files = (await readdir(requestsDir)).filter((file) => file.endsWith('.json'));
    } catch {
      // The hook creates the request directory after it starts.
    }
    if (files.length >= expectedCount) {
      return await Promise.all(
        files.map(async (file) => {
          const raw = await readFile(path.join(requestsDir, file), 'utf-8');
          return JSON.parse(raw) as BridgeRequest;
        })
      );
    }
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${expectedCount} bridge request file(s)`);
}

async function writeAnswer(request: BridgeRequest, answers: Record<string, string>): Promise<void> {
  await writeFile(
    request.answerPath,
    JSON.stringify({
      requestId: request.requestId,
      answers,
      answeredAt: new Date().toISOString(),
    })
  );
}

async function expectFailureFile(bridgeDir: string): Promise<void> {
  const failuresDir = path.join(bridgeDir, 'failures');
  for (let attempt = 0; attempt < 80; attempt += 1) {
    let files: string[] = [];
    try {
      files = (await readdir(failuresDir)).filter((file) => file.endsWith('.json'));
    } catch {
      // The hook creates the failure directory only when a bridge failure happens.
    }
    if (files.length > 0) {
      return;
    }
    await sleep(25);
  }
  throw new Error('Timed out waiting for bridge failure file');
}

describe('isMcpBridgeEnabled', () => {
  it('returns true only for the literal value 1', () => {
    expect(isMcpBridgeEnabled({ [SHIPPER_MCP_BRIDGE_ENV]: '1' })).toBe(true);
    expect(isMcpBridgeEnabled({})).toBe(false);
    expect(isMcpBridgeEnabled({ [SHIPPER_MCP_BRIDGE_ENV]: '' })).toBe(false);
    expect(isMcpBridgeEnabled({ [SHIPPER_MCP_BRIDGE_ENV]: '0' })).toBe(false);
    expect(isMcpBridgeEnabled({ [SHIPPER_MCP_BRIDGE_ENV]: 'true' })).toBe(false);
    expect(isMcpBridgeEnabled({ [SHIPPER_MCP_BRIDGE_ENV]: 'yes' })).toBe(false);
  });
});

describe('installDeferBridge', () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), 'shipper-defer-bridge-test-'));
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it('writes the bridge script and claude settings into the worktree', async () => {
    const { bridgeScriptPath, claudeSettingsPath } = await installDeferBridge(workdir, {
      timeoutSeconds: 3600,
    });
    expect(bridgeScriptPath).toBe(path.join(workdir, DEFER_BRIDGE_RELATIVE_PATH));
    expect(claudeSettingsPath).toBe(path.join(workdir, CLAUDE_SETTINGS_RELATIVE_PATH));

    const settingsRaw = await readFile(claudeSettingsPath, 'utf-8');
    const settings = parseSettings(settingsRaw);
    expect(settings.hooks.PreToolUse[0]?.matcher).toBe('AskUserQuestion');
    expect(settings.hooks.PreToolUse[0]?.hooks[0]?.type).toBe('command');
    expect(settings.hooks.PreToolUse[0]?.hooks[0]?.command).toContain(bridgeScriptPath);
    expect(settings.hooks.PreToolUse[0]?.hooks[0]?.timeout).toBe(3600);

    const scriptRaw = await readFile(bridgeScriptPath, 'utf-8');
    expect(scriptRaw).toContain(SHIPPER_QUESTION_BRIDGE_DIR_ENV);
    expect(scriptRaw).toContain(SHIPPER_QUESTION_BRIDGE_TIMEOUT_MS_ENV);
  });

  it('exits with no decision when bridge env is unset', async () => {
    const { bridgeScriptPath } = await installDeferBridge(workdir, { timeoutSeconds: 3600 });
    const result = await runBridge(bridgeScriptPath, hookInput('toolu_01abc'));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('writes one request and returns allow with the matching answer', async () => {
    const { bridgeScriptPath } = await installDeferBridge(workdir, { timeoutSeconds: 3600 });
    const bridgeDir = path.join(workdir, 'bridge');
    const running = startBridge(bridgeScriptPath, hookInput('toolu_01abc'), {
      [SHIPPER_QUESTION_BRIDGE_DIR_ENV]: bridgeDir,
      [SHIPPER_QUESTION_BRIDGE_TIMEOUT_MS_ENV]: '2000',
    });

    const [request] = await readRequests(bridgeDir, 1);
    expect(request?.sessionId).toBe('sess_abc123');
    expect(request?.toolUseId).toBe('toolu_01abc');
    expect(request?.questions).toEqual([
      {
        question: 'Which framework?',
        header: 'Framework',
        options: [
          { label: 'React', description: 'React lib' },
          { label: 'Vue', description: 'Vue framework' },
        ],
        multiSelect: false,
      },
    ]);

    await writeAnswer(request, { 'Which framework?': 'React' });
    const result = await running.done;
    const parsed = parseHookOutput(result.stdout);
    expect(result.exitCode).toBe(0);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(parsed.hookSpecificOutput.updatedInput?.answers).toEqual({
      'Which framework?': 'React',
    });
    expect(parsed.hookSpecificOutput.updatedInput?.questions).toHaveLength(1);
  });

  it('rendezvous with three concurrent hooks independently', async () => {
    const { bridgeScriptPath } = await installDeferBridge(workdir, { timeoutSeconds: 3600 });
    const bridgeDir = path.join(workdir, 'bridge');
    const env = {
      [SHIPPER_QUESTION_BRIDGE_DIR_ENV]: bridgeDir,
      [SHIPPER_QUESTION_BRIDGE_TIMEOUT_MS_ENV]: '2000',
    };
    const runs = [
      startBridge(bridgeScriptPath, hookInput('A', 'A?'), env),
      startBridge(bridgeScriptPath, hookInput('B', 'B?'), env),
      startBridge(bridgeScriptPath, hookInput('C', 'C?'), env),
    ];
    const requests = await readRequests(bridgeDir, 3);
    for (const request of requests) {
      await writeAnswer(request, { [request.questions[0]?.question ?? '']: request.toolUseId });
    }

    const results = await Promise.all(runs.map((run) => run.done));
    const outputs = results.map((result) => parseHookOutput(result.stdout));
    expect(results.map((result) => result.exitCode)).toEqual([0, 0, 0]);
    expect(outputs.map((output) => output.hookSpecificOutput.updatedInput?.answers)).toEqual([
      { 'A?': 'A' },
      { 'B?': 'B' },
      { 'C?': 'C' },
    ]);
  });

  it.each([
    ['invalid JSON', '{not valid'],
    [
      'wrong requestId',
      JSON.stringify({ requestId: 'wrong', answers: { 'Which framework?': 'React' } }),
    ],
    ['missing answers object', JSON.stringify({ requestId: 'placeholder' })],
  ])('returns deny and records a failure for malformed answer file: %s', async (_name, body) => {
    const { bridgeScriptPath } = await installDeferBridge(workdir, { timeoutSeconds: 3600 });
    const bridgeDir = path.join(workdir, 'bridge');
    const running = startBridge(bridgeScriptPath, hookInput('toolu_01abc'), {
      [SHIPPER_QUESTION_BRIDGE_DIR_ENV]: bridgeDir,
      [SHIPPER_QUESTION_BRIDGE_TIMEOUT_MS_ENV]: '2000',
    });
    const [request] = await readRequests(bridgeDir, 1);
    const content = body.replace('placeholder', request.requestId);
    await writeFile(request.answerPath, content);

    const result = await running.done;
    const parsed = parseHookOutput(result.stdout);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('shipper question-bridge');
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    await expectFailureFile(bridgeDir);
  });
});

describe('buildClaudeSettings', () => {
  it('produces JSON with the right hook shape and timeout', () => {
    const settings = parseSettings(
      buildClaudeSettings('/abs/path/to/bridge.mjs', { timeoutSeconds: 3600 })
    );
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0]?.matcher).toBe('AskUserQuestion');
    expect(settings.hooks.PreToolUse[0]?.hooks[0]?.command).toBe('node "/abs/path/to/bridge.mjs"');
    expect(settings.hooks.PreToolUse[0]?.hooks[0]?.timeout).toBe(3600);
  });
});
