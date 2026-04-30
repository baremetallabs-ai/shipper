import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const SHIPPER_DEFERRED_ANSWERS_ENV = 'SHIPPER_DEFERRED_ANSWERS';

export const DEFER_BRIDGE_RELATIVE_PATH = path.join('.shipper', 'defer-bridge.mjs');
export const CLAUDE_SETTINGS_RELATIVE_PATH = path.join('.claude', 'settings.json');

const BRIDGE_SCRIPT = `#!/usr/bin/env node
import { readFile, unlink } from 'node:fs/promises';

const ANSWERS_ENV = ${JSON.stringify(SHIPPER_DEFERRED_ANSWERS_ENV)};

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function emit(decision) {
  process.stdout.write(JSON.stringify(decision));
}

async function loadAnswers(answersPath) {
  let raw;
  try {
    raw = await readFile(answersPath, 'utf-8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(\`Answers file at \${answersPath} did not contain a JSON object\`);
  }
  // Single-use: delete after successful read so subsequent AskUserQuestion calls defer again.
  try {
    await unlink(answersPath);
  } catch {}
  return parsed;
}

async function main() {
  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = {};
  }
  const toolInput = payload && typeof payload === 'object' ? payload.tool_input ?? {} : {};
  const questions = Array.isArray(toolInput.questions) ? toolInput.questions : [];

  const answersPath = process.env[ANSWERS_ENV];
  if (answersPath) {
    let answers;
    try {
      answers = await loadAnswers(answersPath);
    } catch (err) {
      process.stderr.write(\`shipper defer-bridge: \${err instanceof Error ? err.message : String(err)}\\n\`);
      emit({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'shipper defer-bridge failed to read answers',
        },
      });
      return;
    }
    if (answers !== null) {
      emit({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { questions, answers },
        },
      });
      return;
    }
    // Env var set but file is gone (already consumed by an earlier hook fire) — defer.
  }

  emit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'defer',
    },
  });
}

main().catch((err) => {
  process.stderr.write(\`shipper defer-bridge: \${err instanceof Error ? err.message : String(err)}\\n\`);
  emit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'shipper defer-bridge crashed',
    },
  });
});
`;

export function getBridgeScriptSource(): string {
  return BRIDGE_SCRIPT;
}

export function buildClaudeSettings(bridgeScriptAbsPath: string): string {
  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'AskUserQuestion',
          hooks: [
            {
              type: 'command',
              command: `node ${JSON.stringify(bridgeScriptAbsPath).slice(1, -1)}`,
            },
          ],
        },
      ],
    },
  };
  return JSON.stringify(settings, null, 2);
}

export async function installDeferBridge(worktreePath: string): Promise<{
  bridgeScriptPath: string;
  claudeSettingsPath: string;
}> {
  const bridgeScriptPath = path.join(worktreePath, DEFER_BRIDGE_RELATIVE_PATH);
  const claudeSettingsPath = path.join(worktreePath, CLAUDE_SETTINGS_RELATIVE_PATH);

  await mkdir(path.dirname(bridgeScriptPath), { recursive: true });
  await writeFile(bridgeScriptPath, BRIDGE_SCRIPT, { mode: 0o755 });

  await mkdir(path.dirname(claudeSettingsPath), { recursive: true });
  await writeFile(claudeSettingsPath, buildClaudeSettings(bridgeScriptPath));

  return { bridgeScriptPath, claudeSettingsPath };
}
