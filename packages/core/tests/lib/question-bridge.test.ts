import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnswerLine, DeferMarkerPayload } from '../../src/lib/defer-loop.js';
import { StreamJsonDeferConsumer, type DeferQuestion } from '../../src/lib/defer-stream.js';
import { driveQuestionBridge, type QuestionBridgeRequest } from '../../src/lib/question-bridge.js';

const QUESTION_TEMPLATE: DeferQuestion = {
  question: 'A?',
  header: 'Question',
  options: [],
  multiSelect: false,
};

function makeQuestion(question: string): DeferQuestion {
  return { ...QUESTION_TEMPLATE, question };
}

function makeConsumer(toolUses: { id: string; question: string }[]): StreamJsonDeferConsumer {
  const consumer = new StreamJsonDeferConsumer();
  consumer.consume(
    JSON.stringify({
      type: 'assistant',
      message: {
        content: toolUses.map((toolUse) => ({
          type: 'tool_use',
          id: toolUse.id,
          name: 'AskUserQuestion',
          input: { questions: [makeQuestion(toolUse.question)] },
        })),
      },
    }) + '\n'
  );
  return consumer;
}

async function ensureBridgeDirs(bridgeDir: string): Promise<void> {
  await mkdir(path.join(bridgeDir, 'requests'), { recursive: true });
  await mkdir(path.join(bridgeDir, 'answers'), { recursive: true });
  await mkdir(path.join(bridgeDir, 'failures'), { recursive: true });
}

async function writeRequest(
  bridgeDir: string,
  toolUseId: string,
  question: string
): Promise<QuestionBridgeRequest> {
  await ensureBridgeDirs(bridgeDir);
  const requestId = `request-${toolUseId}`;
  const request: QuestionBridgeRequest = {
    requestId,
    sessionId: 'sess_123',
    toolUseId,
    questions: [makeQuestion(question)],
    answerPath: path.join(bridgeDir, 'answers', `${requestId}.json`),
    createdAt: new Date().toISOString(),
  };
  await writeFile(path.join(bridgeDir, 'requests', `${requestId}.json`), JSON.stringify(request));
  return request;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitFor<T>(callback: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const value = callback();
    if (value !== undefined) return value;
    await sleep(10);
  }
  throw new Error('Timed out waiting for condition');
}

async function readAnswerFile(request: QuestionBridgeRequest): Promise<unknown> {
  const raw = await readFile(request.answerPath, 'utf-8');
  return JSON.parse(raw);
}

async function waitForAnswerFile(request: QuestionBridgeRequest): Promise<unknown> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      return await readAnswerFile(request);
    } catch {
      await sleep(10);
    }
  }
  throw new Error('Timed out waiting for answer file');
}

describe('driveQuestionBridge', () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), 'shipper-question-bridge-test-'));
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it('emits one marker and writes the answer file only after the orchestrator answer', async () => {
    const bridgeDir = path.join(workdir, 'bridge');
    const request = await writeRequest(bridgeDir, 'A', 'A?');
    const answer = deferred<AnswerLine>();
    const childExit = deferred<number>();
    const markers: DeferMarkerPayload[] = [];
    const abortChild = vi.fn();

    const drive = driveQuestionBridge({
      bridgeDir,
      streamConsumer: makeConsumer([{ id: 'A', question: 'A?' }]),
      childExit: childExit.promise,
      readAnswer: () => answer.promise,
      emitMarker: (payload) => markers.push(payload),
      abortChild,
      pollIntervalMs: 5,
      orderResolutionTimeoutMs: 20,
    });

    await waitFor(() => (markers.length === 1 ? markers[0] : undefined));
    expect(markers[0]).toEqual({
      sessionId: 'sess_123',
      questions: [makeQuestion('A?')],
      toolUseId: 'A',
    });
    await expect(readFile(request.answerPath, 'utf-8')).rejects.toThrow();

    answer.resolve({ answers: { 'A?': 'orchestrator A' } });
    await waitForAnswerFile(request);
    childExit.resolve(0);

    await expect(drive).resolves.toBe(0);
    expect(await readAnswerFile(request)).toMatchObject({
      requestId: request.requestId,
      answers: { 'A?': 'orchestrator A' },
    });
    expect(abortChild).not.toHaveBeenCalled();
  });

  it('emits out-of-order request files in stream-json order A, B, C', async () => {
    const bridgeDir = path.join(workdir, 'bridge');
    const requestC = await writeRequest(bridgeDir, 'C', 'C?');
    const requestA = await writeRequest(bridgeDir, 'A', 'A?');
    const requestB = await writeRequest(bridgeDir, 'B', 'B?');
    const childExit = deferred<number>();
    const markers: DeferMarkerPayload[] = [];
    const answers: AnswerLine[] = [
      { answers: { 'A?': 'answer A' } },
      { answers: { 'B?': 'answer B' } },
      { answers: { 'C?': 'answer C' } },
    ];

    const drive = driveQuestionBridge({
      bridgeDir,
      streamConsumer: makeConsumer([
        { id: 'A', question: 'A?' },
        { id: 'B', question: 'B?' },
        { id: 'C', question: 'C?' },
      ]),
      childExit: childExit.promise,
      readAnswer: () => Promise.resolve(answers.shift() ?? { answers: {} }),
      emitMarker: (payload) => markers.push(payload),
      abortChild: vi.fn(),
      pollIntervalMs: 5,
      orderResolutionTimeoutMs: 20,
    });

    await waitFor(() => (markers.length === 3 ? markers : undefined));
    childExit.resolve(0);

    await expect(drive).resolves.toBe(0);
    expect(markers.map((marker) => marker.toolUseId)).toEqual(['A', 'B', 'C']);
    expect(await readAnswerFile(requestA)).toMatchObject({ answers: { 'A?': 'answer A' } });
    expect(await readAnswerFile(requestB)).toMatchObject({ answers: { 'B?': 'answer B' } });
    expect(await readAnswerFile(requestC)).toMatchObject({ answers: { 'C?': 'answer C' } });
  });

  it('waits for the earliest unanswered ordered request before surfacing later requests', async () => {
    const bridgeDir = path.join(workdir, 'bridge');
    const requestB = await writeRequest(bridgeDir, 'B', 'B?');
    const childExit = deferred<number>();
    const markers: DeferMarkerPayload[] = [];
    const answers: AnswerLine[] = [
      { answers: { 'A?': 'answer A' } },
      { answers: { 'B?': 'answer B' } },
    ];

    const drive = driveQuestionBridge({
      bridgeDir,
      streamConsumer: makeConsumer([
        { id: 'A', question: 'A?' },
        { id: 'B', question: 'B?' },
      ]),
      childExit: childExit.promise,
      readAnswer: () => Promise.resolve(answers.shift() ?? { answers: {} }),
      emitMarker: (payload) => markers.push(payload),
      abortChild: vi.fn(),
      pollIntervalMs: 5,
      orderResolutionTimeoutMs: 1_000,
    });

    await sleep(25);
    expect(markers).toEqual([]);

    const requestA = await writeRequest(bridgeDir, 'A', 'A?');
    await waitFor(() => (markers.length === 2 ? markers : undefined));
    childExit.resolve(0);

    await expect(drive).resolves.toBe(0);
    expect(markers.map((marker) => marker.toolUseId)).toEqual(['A', 'B']);
    expect(await readAnswerFile(requestA)).toMatchObject({ answers: { 'A?': 'answer A' } });
    expect(await readAnswerFile(requestB)).toMatchObject({ answers: { 'B?': 'answer B' } });
  });

  it('rejects when the earliest ordered request never writes a request file', async () => {
    const bridgeDir = path.join(workdir, 'bridge');
    await writeRequest(bridgeDir, 'B', 'B?');
    const abortChild = vi.fn();

    await expect(
      driveQuestionBridge({
        bridgeDir,
        streamConsumer: makeConsumer([
          { id: 'A', question: 'A?' },
          { id: 'B', question: 'B?' },
        ]),
        childExit: new Promise<number>(() => undefined),
        readAnswer: () => Promise.resolve({ answers: { 'B?': 'answer B' } }),
        emitMarker: vi.fn(),
        abortChild,
        pollIntervalMs: 5,
        orderResolutionTimeoutMs: 20,
      })
    ).rejects.toThrow('tool_use_id A was observed in Claude stream-json order');
    expect(abortChild).toHaveBeenCalledOnce();
  });

  it('rejects child exit after stream order appears but before the request file appears', async () => {
    const bridgeDir = path.join(workdir, 'bridge');
    const childExit = deferred<number>();
    const abortChild = vi.fn();
    const drive = driveQuestionBridge({
      bridgeDir,
      streamConsumer: makeConsumer([{ id: 'A', question: 'A?' }]),
      childExit: childExit.promise,
      readAnswer: () => Promise.resolve({ answers: { 'A?': 'answer A' } }),
      emitMarker: vi.fn(),
      abortChild,
      pollIntervalMs: 5,
      orderResolutionTimeoutMs: 1_000,
    });

    childExit.resolve(0);

    await expect(drive).rejects.toThrow(
      'Claude exited before AskUserQuestion tool_use_id A could be surfaced'
    );
    expect(abortChild).toHaveBeenCalledOnce();
  });

  it('rejects missing current-batch answers without writing an answer file', async () => {
    const bridgeDir = path.join(workdir, 'bridge');
    const request = await writeRequest(bridgeDir, 'B', 'B?');
    const abortChild = vi.fn();

    const drive = driveQuestionBridge({
      bridgeDir,
      streamConsumer: makeConsumer([{ id: 'B', question: 'B?' }]),
      childExit: new Promise<number>(() => undefined),
      readAnswer: () => Promise.resolve({ answers: { 'Other?': 'value' } }),
      emitMarker: vi.fn(),
      abortChild,
      pollIntervalMs: 5,
      orderResolutionTimeoutMs: 20,
    });

    await expect(drive).rejects.toThrow('Missing answers for deferred question batch: B?');
    expect(abortChild).toHaveBeenCalledOnce();
    await expect(readFile(request.answerPath, 'utf-8')).rejects.toThrow();
  });

  it('rejects unavailable stdin while a request is pending', async () => {
    const bridgeDir = path.join(workdir, 'bridge');
    const request = await writeRequest(bridgeDir, 'A', 'A?');
    const abortChild = vi.fn();

    const drive = driveQuestionBridge({
      bridgeDir,
      streamConsumer: makeConsumer([{ id: 'A', question: 'A?' }]),
      childExit: new Promise<number>(() => undefined),
      readAnswer: () =>
        Promise.reject(new Error('stdin closed before deferred answer was provided')),
      emitMarker: vi.fn(),
      abortChild,
      pollIntervalMs: 5,
      orderResolutionTimeoutMs: 20,
    });

    await expect(drive).rejects.toThrow('stdin closed before deferred answer was provided');
    expect(abortChild).toHaveBeenCalledOnce();
    await expect(readFile(request.answerPath, 'utf-8')).rejects.toThrow();
  });

  it('rejects malformed request JSON', async () => {
    const bridgeDir = path.join(workdir, 'bridge');
    await ensureBridgeDirs(bridgeDir);
    await writeFile(path.join(bridgeDir, 'requests', 'bad.json'), '{not valid');
    const abortChild = vi.fn();

    await expect(
      driveQuestionBridge({
        bridgeDir,
        streamConsumer: makeConsumer([{ id: 'A', question: 'A?' }]),
        childExit: new Promise<number>(() => undefined),
        readAnswer: () => Promise.resolve({ answers: {} }),
        emitMarker: vi.fn(),
        abortChild,
        pollIntervalMs: 5,
        orderResolutionTimeoutMs: 20,
      })
    ).rejects.toThrow();
    expect(abortChild).toHaveBeenCalledOnce();
  });

  it('rejects request files missing toolUseId', async () => {
    const bridgeDir = path.join(workdir, 'bridge');
    await ensureBridgeDirs(bridgeDir);
    await writeFile(
      path.join(bridgeDir, 'requests', 'missing-tool.json'),
      JSON.stringify({
        requestId: 'request-missing',
        sessionId: 'sess_123',
        questions: [makeQuestion('A?')],
        answerPath: path.join(bridgeDir, 'answers', 'request-missing.json'),
        createdAt: new Date().toISOString(),
      })
    );
    const abortChild = vi.fn();

    await expect(
      driveQuestionBridge({
        bridgeDir,
        streamConsumer: makeConsumer([{ id: 'A', question: 'A?' }]),
        childExit: new Promise<number>(() => undefined),
        readAnswer: () => Promise.resolve({ answers: {} }),
        emitMarker: vi.fn(),
        abortChild,
        pollIntervalMs: 5,
        orderResolutionTimeoutMs: 20,
      })
    ).rejects.toThrow('toolUseId missing');
    expect(abortChild).toHaveBeenCalledOnce();
  });

  it('rejects unmatched request order after the order timeout', async () => {
    const bridgeDir = path.join(workdir, 'bridge');
    await writeRequest(bridgeDir, 'unknown', 'Unknown?');
    const abortChild = vi.fn();

    await expect(
      driveQuestionBridge({
        bridgeDir,
        streamConsumer: makeConsumer([{ id: 'A', question: 'A?' }]),
        childExit: new Promise<number>(() => undefined),
        readAnswer: () => Promise.resolve({ answers: {} }),
        emitMarker: vi.fn(),
        abortChild,
        pollIntervalMs: 5,
        orderResolutionTimeoutMs: 20,
      })
    ).rejects.toThrow('was not observed in Claude stream-json order');
    expect(abortChild).toHaveBeenCalledOnce();
  });

  it('rejects hook failure files', async () => {
    const bridgeDir = path.join(workdir, 'bridge');
    await ensureBridgeDirs(bridgeDir);
    await writeFile(
      path.join(bridgeDir, 'failures', 'failure.json'),
      JSON.stringify({ requestId: 'request-A', message: 'hook failed', createdAt: 'now' })
    );
    const abortChild = vi.fn();

    await expect(
      driveQuestionBridge({
        bridgeDir,
        streamConsumer: makeConsumer([{ id: 'A', question: 'A?' }]),
        childExit: new Promise<number>(() => undefined),
        readAnswer: () => Promise.resolve({ answers: {} }),
        emitMarker: vi.fn(),
        abortChild,
        pollIntervalMs: 5,
        orderResolutionTimeoutMs: 20,
      })
    ).rejects.toThrow('AskUserQuestion hook failed: hook failed');
    expect(abortChild).toHaveBeenCalledOnce();
  });

  it('rejects child exit while a request is pending', async () => {
    const bridgeDir = path.join(workdir, 'bridge');
    await writeRequest(bridgeDir, 'A', 'A?');
    const childExit = deferred<number>();
    const abortChild = vi.fn();
    const markers: DeferMarkerPayload[] = [];
    const drive = driveQuestionBridge({
      bridgeDir,
      streamConsumer: makeConsumer([{ id: 'A', question: 'A?' }]),
      childExit: childExit.promise,
      readAnswer: async () => await new Promise<AnswerLine>(() => undefined),
      emitMarker: (payload) => markers.push(payload),
      abortChild,
      pollIntervalMs: 5,
      orderResolutionTimeoutMs: 20,
    });

    await waitFor(() => (markers.length === 1 ? markers[0] : undefined));
    childExit.resolve(1);

    await expect(drive).rejects.toThrow('while AskUserQuestion request request-A was awaiting');
    expect(abortChild).toHaveBeenCalledOnce();
  });
});
