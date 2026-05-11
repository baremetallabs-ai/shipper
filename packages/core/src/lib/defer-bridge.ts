import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const SHIPPER_QUESTION_BRIDGE_DIR_ENV = 'SHIPPER_QUESTION_BRIDGE_DIR';
export const SHIPPER_QUESTION_BRIDGE_TIMEOUT_MS_ENV = 'SHIPPER_QUESTION_BRIDGE_TIMEOUT_MS';

export const DEFER_BRIDGE_RELATIVE_PATH = path.join('.shipper', 'defer-bridge.mjs');
export const CLAUDE_SETTINGS_RELATIVE_PATH = path.join('.claude', 'settings.json');

const BRIDGE_SCRIPT = `#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const BRIDGE_DIR_ENV = ${JSON.stringify(SHIPPER_QUESTION_BRIDGE_DIR_ENV)};
const TIMEOUT_MS_ENV = ${JSON.stringify(SHIPPER_QUESTION_BRIDGE_TIMEOUT_MS_ENV)};
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 50;

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

function blockingFailure(reason) {
  emit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
  process.exitCode = 1;
}

function parseTimeoutMs() {
  const raw = process.env[TIMEOUT_MS_ENV];
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return parsed;
}

function normalizeQuestion(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (typeof value.question !== 'string') return undefined;
  const normalized = {
    question: value.question,
    options: [],
    multiSelect: typeof value.multiSelect === 'boolean' ? value.multiSelect : false,
  };
  if (typeof value.header === 'string') normalized.header = value.header;
  if (Array.isArray(value.options)) {
    for (const option of value.options) {
      if (!option || typeof option !== 'object' || Array.isArray(option)) continue;
      if (typeof option.label !== 'string') continue;
      const normalizedOption = { label: option.label };
      if (typeof option.description === 'string') {
        normalizedOption.description = option.description;
      }
      normalized.options.push(normalizedOption);
    }
  }
  return normalized;
}

function normalizeQuestions(rawQuestions) {
  if (!Array.isArray(rawQuestions)) {
    throw new Error('AskUserQuestion tool_input.questions must be an array');
  }
  const questions = [];
  for (const rawQuestion of rawQuestions) {
    const question = normalizeQuestion(rawQuestion);
    if (!question) {
      throw new Error('AskUserQuestion contained a malformed question');
    }
    questions.push(question);
  }
  return questions;
}

async function ensureBridgeDirs(bridgeDir) {
  const requestsDir = path.join(bridgeDir, 'requests');
  const answersDir = path.join(bridgeDir, 'answers');
  const failuresDir = path.join(bridgeDir, 'failures');
  await mkdir(requestsDir, { recursive: true });
  await mkdir(answersDir, { recursive: true });
  await mkdir(failuresDir, { recursive: true });
  return { requestsDir, answersDir, failuresDir };
}

async function writeJsonAtomic(filePath, value) {
  const tmpPath = \`\${filePath}.\${process.pid}.\${randomUUID()}.tmp\`;
  await writeFile(tmpPath, JSON.stringify(value));
  await rename(tmpPath, filePath);
}

async function writeFailure(failuresDir, failure) {
  try {
    const id = failure.requestId || randomUUID();
    await writeJsonAtomic(path.join(failuresDir, \`\${id}.json\`), failure);
  } catch {}
}

async function readAnswerFile(answerPath) {
  let raw;
  try {
    raw = await readFile(answerPath, 'utf-8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return undefined;
    throw err;
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(\`Answer file at \${answerPath} did not contain a JSON object\`);
  }
  return parsed;
}

function validateAnswerPayload(answerPayload, request) {
  if (answerPayload.requestId !== request.requestId) {
    throw new Error('Answer file requestId did not match request');
  }
  const rawAnswers = answerPayload.answers;
  if (!rawAnswers || typeof rawAnswers !== 'object' || Array.isArray(rawAnswers)) {
    throw new Error('Answer file did not contain an answers object');
  }
  const answers = {};
  for (const [key, value] of Object.entries(rawAnswers)) {
    answers[key] = String(value);
  }
  const missing = [];
  for (const question of request.questions) {
    if (!Object.prototype.hasOwnProperty.call(answers, question.question)) {
      missing.push(question.question);
    }
  }
  if (missing.length > 0) {
    throw new Error(\`Answer file was missing answers for: \${missing.join(', ')}\`);
  }
  return answers;
}

async function waitForAnswers(request, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const answerPayload = await readAnswerFile(request.answerPath);
    if (answerPayload) {
      return validateAnswerPayload(answerPayload, request);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(\`Timed out waiting for AskUserQuestion answer after \${timeoutMs}ms\`);
}

async function main() {
  const bridgeDir = process.env[BRIDGE_DIR_ENV];
  if (!bridgeDir) {
    return;
  }

  const requestId = randomUUID();
  let dirs;
  let toolUseId;
  let request;

  const raw = await readStdin();
  try {
    dirs = await ensureBridgeDirs(bridgeDir);
    const payload = JSON.parse(raw);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Claude hook input must be a JSON object');
    }
    if (typeof payload.session_id !== 'string') {
      throw new Error('Claude hook input was missing session_id');
    }
    if (typeof payload.tool_use_id !== 'string') {
      throw new Error('Claude hook input was missing tool_use_id');
    }
    toolUseId = payload.tool_use_id;
    const toolInput = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
    const questions = normalizeQuestions(toolInput.questions);
    request = {
      requestId,
      sessionId: payload.session_id,
      toolUseId,
      questions,
      answerPath: path.join(dirs.answersDir, \`\${requestId}.json\`),
      createdAt: new Date().toISOString(),
    };
    await writeJsonAtomic(path.join(dirs.requestsDir, \`\${requestId}.json\`), request);
    const answers = await waitForAnswers(request, parseTimeoutMs());
    emit({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { questions, answers },
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (dirs) {
      await writeFailure(dirs.failuresDir, {
        requestId,
        toolUseId,
        message,
        createdAt: new Date().toISOString(),
      });
    }
    process.stderr.write(\`shipper question-bridge: \${message}\\n\`);
    blockingFailure('shipper question-bridge failed');
  }
}

main().catch((err) => {
  process.stderr.write(\`shipper question-bridge: \${err instanceof Error ? err.message : String(err)}\\n\`);
  blockingFailure('shipper question-bridge crashed');
});
`;

export function getBridgeScriptSource(): string {
  return BRIDGE_SCRIPT;
}

export interface BuildClaudeSettingsOptions {
  timeoutSeconds: number;
}

export function buildClaudeSettings(
  bridgeScriptAbsPath: string,
  options: BuildClaudeSettingsOptions
): string {
  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'AskUserQuestion',
          hooks: [
            {
              type: 'command',
              command: `node ${JSON.stringify(bridgeScriptAbsPath)}`,
              timeout: options.timeoutSeconds,
            },
          ],
        },
      ],
    },
  };
  return JSON.stringify(settings, null, 2);
}

export async function installDeferBridge(
  worktreePath: string,
  options: BuildClaudeSettingsOptions
): Promise<{
  bridgeScriptPath: string;
  claudeSettingsPath: string;
}> {
  const bridgeScriptPath = path.join(worktreePath, DEFER_BRIDGE_RELATIVE_PATH);
  const claudeSettingsPath = path.join(worktreePath, CLAUDE_SETTINGS_RELATIVE_PATH);

  await mkdir(path.dirname(bridgeScriptPath), { recursive: true });
  await writeFile(bridgeScriptPath, BRIDGE_SCRIPT, { mode: 0o755 });

  await mkdir(path.dirname(claudeSettingsPath), { recursive: true });
  await writeFile(claudeSettingsPath, buildClaudeSettings(bridgeScriptPath, options));

  return { bridgeScriptPath, claudeSettingsPath };
}
