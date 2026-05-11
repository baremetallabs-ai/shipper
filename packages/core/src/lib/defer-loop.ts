import * as readline from 'node:readline';
import type { DeferQuestion } from './defer-stream.js';
import { logger } from './logger.js';

export const DEFER_MARKER_PREFIX = '<<<SHIPPER_DEFER>>>';
export const DEFER_MARKER_SUFFIX = '<<<END_SHIPPER_DEFER>>>';

export interface DeferMarkerPayload {
  sessionId: string;
  questions: DeferQuestion[];
  toolUseId?: string;
}

export interface AnswerLine {
  answers: Record<string, string>;
}

export function emitDeferMarker(payload: DeferMarkerPayload): void {
  const json = JSON.stringify(payload);
  process.stdout.write(`\n${DEFER_MARKER_PREFIX}${json}${DEFER_MARKER_SUFFIX}\n`);
}

export function parseDeferMarker(line: string): DeferMarkerPayload | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith(DEFER_MARKER_PREFIX)) return undefined;
  const afterPrefix = trimmed.slice(DEFER_MARKER_PREFIX.length);
  const suffixIdx = afterPrefix.indexOf(DEFER_MARKER_SUFFIX);
  const json = suffixIdx === -1 ? afterPrefix : afterPrefix.slice(0, suffixIdx);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    typeof (parsed as Record<string, unknown>).sessionId === 'string' &&
    Array.isArray((parsed as Record<string, unknown>).questions)
  ) {
    const obj = parsed as Record<string, unknown>;
    const result: DeferMarkerPayload = {
      sessionId: obj.sessionId as string,
      questions: obj.questions as DeferMarkerPayload['questions'],
    };
    if (typeof obj.toolUseId === 'string') {
      result.toolUseId = obj.toolUseId;
    }
    return result;
  }
  return undefined;
}

let stdinReader: readline.Interface | undefined;

function getStdinReader(): readline.Interface {
  if (!stdinReader) {
    stdinReader = readline.createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
    });
  }
  return stdinReader;
}

export function closeStdinReader(): void {
  if (stdinReader) {
    stdinReader.close();
    stdinReader = undefined;
  }
  // Belt-and-suspenders: ensure stdin doesn't keep the Node event loop alive.
  // readline.close() calls pause() on the underlying stream, but on some platforms
  // a piped stdin (e.g. when the CLI runs as an MCP child) can still hold an active
  // handle. unref() tells Node not to wait on it.
  const stdin = process.stdin as { unref?: () => void };
  if (typeof stdin.unref === 'function') {
    stdin.unref();
  }
}

export async function readNextAnswerLine(): Promise<AnswerLine> {
  const reader = getStdinReader();
  return await new Promise<AnswerLine>((resolve, reject) => {
    const onLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) {
        // Skip blank lines, wait for the next one.
        reader.once('line', onLine);
        return;
      }
      reader.off('close', onClose);
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (!parsed || typeof parsed !== 'object') {
        reject(new Error('Expected JSON object on stdin'));
        return;
      }
      const answersValue = (parsed as Record<string, unknown>).answers;
      if (!answersValue || typeof answersValue !== 'object' || Array.isArray(answersValue)) {
        reject(new Error('`answers` must be an object'));
        return;
      }
      const normalized: Record<string, string> = {};
      for (const [k, v] of Object.entries(answersValue as Record<string, unknown>)) {
        normalized[k] = String(v);
      }
      resolve({ answers: normalized });
    };
    const onClose = (): void => {
      reader.off('line', onLine);
      reject(new Error('stdin closed before deferred answer was provided'));
    };
    reader.once('line', onLine);
    reader.once('close', onClose);
  });
}

export function findMissingAnswers(
  questions: DeferQuestion[],
  answers: Record<string, string>
): string[] {
  const missing: string[] = [];
  for (const question of questions) {
    if (!Object.prototype.hasOwnProperty.call(answers, question.question)) {
      missing.push(question.question);
    }
  }
  return missing;
}

/** Logs a defer/resume cycle for visibility in CLI logs. */
export function logDeferCycle(sessionId: string, questionCount: number): void {
  logger.log(
    `Worker deferred ${questionCount} question(s); awaiting orchestrator answer (session ${sessionId}).`
  );
}
