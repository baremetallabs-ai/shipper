import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AnswerLine, DeferMarkerPayload } from './defer-loop.js';
import { findMissingAnswers } from './defer-loop.js';
import type { DeferQuestion, StreamJsonDeferConsumer } from './defer-stream.js';

export interface QuestionBridgeRequest {
  requestId: string;
  sessionId: string;
  toolUseId: string;
  questions: DeferQuestion[];
  answerPath: string;
  createdAt: string;
}

export interface QuestionBridgeFailure {
  requestId?: string;
  toolUseId?: string;
  message: string;
  createdAt: string;
}

export interface DriveQuestionBridgeOptions {
  bridgeDir: string;
  streamConsumer: StreamJsonDeferConsumer;
  childExit: Promise<number>;
  readAnswer: () => Promise<AnswerLine>;
  emitMarker: (payload: DeferMarkerPayload) => void;
  abortChild: () => void;
  pollIntervalMs?: number;
  orderResolutionTimeoutMs?: number;
}

interface BridgeDirs {
  requestsDir: string;
  answersDir: string;
  failuresDir: string;
}

interface ChildExitState {
  resolved: boolean;
  exitCode?: number;
  error?: Error;
}

const DEFAULT_POLL_INTERVAL_MS = 50;
const DEFAULT_ORDER_RESOLUTION_TIMEOUT_MS = 30_000;

export async function driveQuestionBridge(options: DriveQuestionBridgeOptions): Promise<number> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const orderResolutionTimeoutMs =
    options.orderResolutionTimeoutMs ?? DEFAULT_ORDER_RESOLUTION_TIMEOUT_MS;
  const dirs = await ensureBridgeDirs(options.bridgeDir);
  const answeredToolUseIds = new Set<string>();
  const unmatchedRequestFirstSeenAt = new Map<string, number>();
  const childExitState: ChildExitState = { resolved: false };

  options.childExit.then(
    (exitCode) => {
      childExitState.resolved = true;
      childExitState.exitCode = exitCode;
    },
    (err: unknown) => {
      childExitState.resolved = true;
      childExitState.exitCode = 1;
      childExitState.error = err instanceof Error ? err : new Error(String(err));
    }
  );

  try {
    for (;;) {
      await throwIfFailureFileExists(dirs.failuresDir);
      const requests = await readRequests(dirs.requestsDir);
      const requestsByToolUseId = indexRequestsByToolUseId(requests);
      const unansweredRequests = requests.filter(
        (request) => !answeredToolUseIds.has(request.toolUseId)
      );

      if (childExitState.resolved) {
        await throwIfFailureFileExists(dirs.failuresDir);
        if (unansweredRequests.length > 0) {
          throw new Error(
            `Claude exited while ${unansweredRequests.length} AskUserQuestion request(s) were pending`
          );
        }
        if (childExitState.error) {
          throw childExitState.error;
        }
        return childExitState.exitCode ?? 1;
      }

      const orderedToolUses = options.streamConsumer.getQuestionToolUseOrder();
      const orderedToolUseIds = new Set(orderedToolUses.map((toolUse) => toolUse.toolUseId));
      const unmatchedRequests = unansweredRequests.filter(
        (request) => !orderedToolUseIds.has(request.toolUseId)
      );
      throwIfRequestsRemainUnordered(
        unmatchedRequests,
        unmatchedRequestFirstSeenAt,
        orderResolutionTimeoutMs
      );

      const nextToolUse = orderedToolUses.find(
        (toolUse) =>
          requestsByToolUseId.has(toolUse.toolUseId) && !answeredToolUseIds.has(toolUse.toolUseId)
      );

      if (nextToolUse) {
        const request = requestsByToolUseId.get(nextToolUse.toolUseId);
        if (!request) {
          throw new Error(`Ordered AskUserQuestion request ${nextToolUse.toolUseId} disappeared`);
        }
        options.emitMarker({
          sessionId: request.sessionId,
          questions: request.questions,
          toolUseId: request.toolUseId,
        });
        const answerLine = await readAnswerBeforeChildExit(options, request);
        const missing = findMissingAnswers(request.questions, answerLine.answers);
        if (missing.length > 0) {
          throw new Error(`Missing answers for deferred question batch: ${missing.join(', ')}`);
        }
        await writeAnswerFile(request, answerLine.answers);
        answeredToolUseIds.add(request.toolUseId);
        continue;
      }

      await sleep(pollIntervalMs);
    }
  } catch (err) {
    safeAbort(options.abortChild);
    throw err;
  }
}

async function ensureBridgeDirs(bridgeDir: string): Promise<BridgeDirs> {
  const requestsDir = path.join(bridgeDir, 'requests');
  const answersDir = path.join(bridgeDir, 'answers');
  const failuresDir = path.join(bridgeDir, 'failures');
  await mkdir(requestsDir, { recursive: true });
  await mkdir(answersDir, { recursive: true });
  await mkdir(failuresDir, { recursive: true });
  return { requestsDir, answersDir, failuresDir };
}

async function readJsonFile(filePath: string): Promise<unknown> {
  const raw = await readFile(filePath, 'utf-8');
  return JSON.parse(raw);
}

async function readRequests(requestsDir: string): Promise<QuestionBridgeRequest[]> {
  const entries = await readdir(requestsDir, { withFileTypes: true });
  const requests: QuestionBridgeRequest[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const filePath = path.join(requestsDir, entry.name);
    const parsed = await readJsonFile(filePath);
    requests.push(validateRequest(parsed, filePath));
  }
  return requests;
}

function validateRequest(value: unknown, filePath: string): QuestionBridgeRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Malformed AskUserQuestion bridge request at ${filePath}: expected object`);
  }
  const record = value as Record<string, unknown>;
  const requestId = requireString(record.requestId, filePath, 'requestId');
  const sessionId = requireString(record.sessionId, filePath, 'sessionId');
  const toolUseId = requireString(record.toolUseId, filePath, 'toolUseId');
  const answerPath = requireString(record.answerPath, filePath, 'answerPath');
  const createdAt = requireString(record.createdAt, filePath, 'createdAt');
  if (!Array.isArray(record.questions)) {
    throw new Error(`Malformed AskUserQuestion bridge request at ${filePath}: questions missing`);
  }
  const questions = record.questions.map((question, index) =>
    validateQuestion(question, filePath, index)
  );
  return {
    requestId,
    sessionId,
    toolUseId,
    questions,
    answerPath,
    createdAt,
  };
}

function requireString(value: unknown, filePath: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Malformed AskUserQuestion bridge request at ${filePath}: ${field} missing`);
  }
  return value;
}

function validateQuestion(value: unknown, filePath: string, index: number): DeferQuestion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      `Malformed AskUserQuestion bridge request at ${filePath}: questions[${index}] invalid`
    );
  }
  const record = value as Record<string, unknown>;
  if (typeof record.question !== 'string') {
    throw new Error(
      `Malformed AskUserQuestion bridge request at ${filePath}: questions[${index}].question missing`
    );
  }
  if (!Array.isArray(record.options)) {
    throw new Error(
      `Malformed AskUserQuestion bridge request at ${filePath}: questions[${index}].options missing`
    );
  }
  const options = record.options
    .map((option) => {
      if (!option || typeof option !== 'object' || Array.isArray(option)) return undefined;
      const optionRecord = option as Record<string, unknown>;
      if (typeof optionRecord.label !== 'string') return undefined;
      const normalized: DeferQuestion['options'][number] = { label: optionRecord.label };
      if (typeof optionRecord.description === 'string') {
        normalized.description = optionRecord.description;
      }
      return normalized;
    })
    .filter((option): option is DeferQuestion['options'][number] => option !== undefined);
  const question: DeferQuestion = {
    question: record.question,
    options,
    multiSelect: typeof record.multiSelect === 'boolean' ? record.multiSelect : false,
  };
  if (typeof record.header === 'string') {
    question.header = record.header;
  }
  return question;
}

function indexRequestsByToolUseId(
  requests: QuestionBridgeRequest[]
): Map<string, QuestionBridgeRequest> {
  const requestsByToolUseId = new Map<string, QuestionBridgeRequest>();
  for (const request of requests) {
    if (requestsByToolUseId.has(request.toolUseId)) {
      throw new Error(
        `Duplicate AskUserQuestion bridge request for tool_use_id ${request.toolUseId}`
      );
    }
    requestsByToolUseId.set(request.toolUseId, request);
  }
  return requestsByToolUseId;
}

function throwIfRequestsRemainUnordered(
  unmatchedRequests: QuestionBridgeRequest[],
  unmatchedRequestFirstSeenAt: Map<string, number>,
  orderResolutionTimeoutMs: number
): void {
  const now = Date.now();
  for (const request of unmatchedRequests) {
    const firstSeenAt = unmatchedRequestFirstSeenAt.get(request.requestId) ?? now;
    unmatchedRequestFirstSeenAt.set(request.requestId, firstSeenAt);
    if (now - firstSeenAt >= orderResolutionTimeoutMs) {
      throw new Error(
        `AskUserQuestion request ${request.requestId} for tool_use_id ${request.toolUseId} was not observed in Claude stream-json order`
      );
    }
  }
}

async function throwIfFailureFileExists(failuresDir: string): Promise<void> {
  const entries = await readdir(failuresDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const filePath = path.join(failuresDir, entry.name);
    const parsed = await readJsonFile(filePath);
    const failure = validateFailure(parsed, filePath);
    throw new Error(`AskUserQuestion hook failed: ${failure.message}`);
  }
}

function validateFailure(value: unknown, filePath: string): QuestionBridgeFailure {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Malformed AskUserQuestion bridge failure at ${filePath}: expected object`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.message !== 'string' || record.message.length === 0) {
    throw new Error(`Malformed AskUserQuestion bridge failure at ${filePath}: message missing`);
  }
  const failure: QuestionBridgeFailure = {
    message: record.message,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date(0).toISOString(),
  };
  if (typeof record.requestId === 'string') {
    failure.requestId = record.requestId;
  }
  if (typeof record.toolUseId === 'string') {
    failure.toolUseId = record.toolUseId;
  }
  return failure;
}

async function readAnswerBeforeChildExit(
  options: DriveQuestionBridgeOptions,
  request: QuestionBridgeRequest
): Promise<AnswerLine> {
  const answerPromise = options
    .readAnswer()
    .then((answer) => ({ kind: 'answer', answer }) as const);
  void answerPromise.catch(() => undefined);
  const childExitPromise = options.childExit.then(
    (exitCode) => ({ kind: 'child-exit', exitCode }) as const,
    (err: unknown) =>
      ({
        kind: 'child-exit',
        exitCode: 1,
        error: err instanceof Error ? err : new Error(String(err)),
      }) as const
  );
  const result = await Promise.race([answerPromise, childExitPromise]);
  if (result.kind === 'child-exit') {
    if ('error' in result) {
      throw result.error;
    }
    throw new Error(
      `Claude exited with code ${result.exitCode} while AskUserQuestion request ${request.requestId} was awaiting an answer`
    );
  }
  return result.answer;
}

async function writeAnswerFile(
  request: QuestionBridgeRequest,
  answers: Record<string, string>
): Promise<void> {
  const payload = {
    requestId: request.requestId,
    answers,
    answeredAt: new Date().toISOString(),
  };
  const tmpPath = `${request.answerPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, JSON.stringify(payload));
  await rename(tmpPath, request.answerPath);
}

function safeAbort(abortChild: () => void): void {
  try {
    abortChild();
  } catch {
    // Preserve the original bridge failure if aborting the child also fails.
  }
}
