import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { AgentName } from './settings.js';

export async function extractFinalMessage(
  agent: AgentName,
  logFile: string
): Promise<string | undefined> {
  let finalMessage: string | undefined;

  const logStream = createReadStream(logFile, { encoding: 'utf-8' });
  const lines = createInterface({
    input: logStream,
    crlfDelay: Infinity,
  });

  try {
    for await (const line of lines) {
      const record = parseJsonLine(line);
      if (!record) {
        continue;
      }

      const message = extractMessage(agent, record);
      if (message !== undefined) {
        finalMessage = message;
      }
    }
  } catch {
    return undefined;
  } finally {
    lines.close();
    logStream.destroy();
  }

  return finalMessage;
}

function extractMessage(agent: AgentName, record: Record<string, unknown>): string | undefined {
  switch (agent) {
    case 'claude':
      return getClaudeMessage(record);
    case 'codex':
      return getCodexMessage(record);
    case 'copilot':
      return getCopilotMessage(record);
    default: {
      const exhaustiveCheck: never = agent;
      throw new Error(`Unsupported agent: ${String(exhaustiveCheck)}`);
    }
  }
}

function getClaudeMessage(record: Record<string, unknown>): string | undefined {
  if (record.type !== 'assistant') {
    return undefined;
  }

  return joinTextBlocks(getRecord(record.message)?.content, 'text');
}

function getCodexMessage(record: Record<string, unknown>): string | undefined {
  if (record.type !== 'response_item') {
    return undefined;
  }

  const payload = getRecord(record.payload);
  if (!payload || payload.type !== 'message' || payload.role !== 'assistant') {
    return undefined;
  }

  return joinTextBlocks(payload.content, 'output_text');
}

function getCopilotMessage(record: Record<string, unknown>): string | undefined {
  const topLevelMessage = getMessageText(record);
  if (topLevelMessage !== undefined) {
    return topLevelMessage;
  }

  const event = getRecord(record.event);
  if (!event) {
    return undefined;
  }

  return getMessageText(event);
}

function getMessageText(record: Record<string, unknown>): string | undefined {
  if (record.role !== 'assistant' && record.author !== 'assistant') {
    return undefined;
  }

  const content = joinTextBlocks(record.content, 'text');
  if (content !== undefined) {
    return content;
  }

  if (typeof record.text === 'string') {
    return record.text;
  }

  if (typeof record.message === 'string') {
    return record.message;
  }

  const message = getRecord(record.message);
  if (!message) {
    return undefined;
  }

  return (
    joinTextBlocks(message.content, 'text') ??
    (typeof message.text === 'string' ? message.text : undefined)
  );
}

function joinTextBlocks(value: unknown, blockType: string): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const parts = value
    .map((entry) => getRecord(entry))
    .flatMap((entry) =>
      entry?.type === blockType && typeof entry.text === 'string' ? [entry.text] : []
    );

  return parts.length > 0 ? parts.join('\n') : undefined;
}

function parseJsonLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    return getRecord(parsed);
  } catch {
    return undefined;
  }
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}
