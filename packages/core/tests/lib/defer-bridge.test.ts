import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CLAUDE_SETTINGS_RELATIVE_PATH,
  DEFER_BRIDGE_RELATIVE_PATH,
  SHIPPER_DEFERRED_ANSWERS_ENV,
  buildClaudeSettings,
  installDeferBridge,
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

interface SettingsShape {
  hooks: {
    PreToolUse: {
      matcher: string;
      hooks: { type: string; command: string }[];
    }[];
  };
}

function parseHookOutput(json: string): HookOutput {
  return JSON.parse(json) as HookOutput;
}

function parseSettings(json: string): SettingsShape {
  return JSON.parse(json) as SettingsShape;
}

async function runBridge(
  scriptPath: string,
  stdin: string,
  env: Record<string, string | undefined> = {}
): Promise<RunBridgeResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
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
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

describe('installDeferBridge', () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), 'shipper-defer-bridge-test-'));
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it('writes the bridge script and claude settings into the worktree', async () => {
    const { bridgeScriptPath, claudeSettingsPath } = await installDeferBridge(workdir);
    expect(bridgeScriptPath).toBe(path.join(workdir, DEFER_BRIDGE_RELATIVE_PATH));
    expect(claudeSettingsPath).toBe(path.join(workdir, CLAUDE_SETTINGS_RELATIVE_PATH));

    const settingsRaw = await readFile(claudeSettingsPath, 'utf-8');
    const settings = parseSettings(settingsRaw);
    expect(settings.hooks.PreToolUse[0]?.matcher).toBe('AskUserQuestion');
    expect(settings.hooks.PreToolUse[0]?.hooks[0]?.type).toBe('command');
    expect(settings.hooks.PreToolUse[0]?.hooks[0]?.command).toContain(bridgeScriptPath);

    const scriptRaw = await readFile(bridgeScriptPath, 'utf-8');
    expect(scriptRaw).toContain(SHIPPER_DEFERRED_ANSWERS_ENV);
  });

  it('returns defer when SHIPPER_DEFERRED_ANSWERS is unset', async () => {
    const { bridgeScriptPath } = await installDeferBridge(workdir);
    const input = JSON.stringify({
      tool_input: {
        questions: [
          {
            question: 'Which framework?',
            header: 'Framework',
            options: [
              { label: 'React', description: 'React lib' },
              { label: 'Vue', description: 'Vue framework' },
            ],
            multiSelect: false,
          },
        ],
      },
    });

    const result = await runBridge(bridgeScriptPath, input);
    const parsed = parseHookOutput(result.stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('defer');
  });

  it('returns allow with answers when SHIPPER_DEFERRED_ANSWERS points at a valid file', async () => {
    const { bridgeScriptPath } = await installDeferBridge(workdir);
    const answersPath = path.join(workdir, 'answers.json');
    const answers = { 'Which framework?': 'React' };
    await writeFile(answersPath, JSON.stringify(answers));

    const input = JSON.stringify({
      tool_input: {
        questions: [
          {
            question: 'Which framework?',
            header: 'Framework',
            options: [
              { label: 'React', description: 'React lib' },
              { label: 'Vue', description: 'Vue framework' },
            ],
            multiSelect: false,
          },
        ],
      },
    });

    const result = await runBridge(bridgeScriptPath, input, {
      [SHIPPER_DEFERRED_ANSWERS_ENV]: answersPath,
    });
    const parsed = parseHookOutput(result.stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(parsed.hookSpecificOutput.updatedInput?.answers).toEqual(answers);
    expect(parsed.hookSpecificOutput.updatedInput?.questions).toHaveLength(1);
  });

  it('falls through to defer when answers file is missing (already consumed)', async () => {
    const { bridgeScriptPath } = await installDeferBridge(workdir);
    const input = JSON.stringify({ tool_input: { questions: [] } });
    const result = await runBridge(bridgeScriptPath, input, {
      [SHIPPER_DEFERRED_ANSWERS_ENV]: path.join(workdir, 'does-not-exist.json'),
    });
    const parsed = parseHookOutput(result.stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('defer');
  });

  it('deletes the answers file after a successful read (single-use)', async () => {
    const { bridgeScriptPath } = await installDeferBridge(workdir);
    const answersPath = path.join(workdir, 'one-shot.json');
    await writeFile(answersPath, JSON.stringify({ Q: 'A' }));
    const input = JSON.stringify({ tool_input: { questions: [] } });
    await runBridge(bridgeScriptPath, input, {
      [SHIPPER_DEFERRED_ANSWERS_ENV]: answersPath,
    });
    await expect(readFile(answersPath, 'utf-8')).rejects.toThrow();
  });

  it('returns deny when answers file is malformed', async () => {
    const { bridgeScriptPath } = await installDeferBridge(workdir);
    const answersPath = path.join(workdir, 'bad.json');
    await writeFile(answersPath, '{not valid');
    const input = JSON.stringify({ tool_input: { questions: [] } });
    const result = await runBridge(bridgeScriptPath, input, {
      [SHIPPER_DEFERRED_ANSWERS_ENV]: answersPath,
    });
    const parsed = parseHookOutput(result.stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

describe('buildClaudeSettings', () => {
  it('produces JSON with the right hook shape', () => {
    const settings = parseSettings(buildClaudeSettings('/abs/path/to/bridge.mjs'));
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0]?.matcher).toBe('AskUserQuestion');
    expect(settings.hooks.PreToolUse[0]?.hooks[0]?.command).toBe('node /abs/path/to/bridge.mjs');
  });
});
