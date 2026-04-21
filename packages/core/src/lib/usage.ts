import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { logger } from './logger.js';
import type { AgentName } from './settings.js';
import type { TokenUsage } from './token-usage.js';

export type { TokenUsage };

const numberFormatter = new Intl.NumberFormat('en-US');

export async function parseAgentUsage(
  agent: AgentName,
  logFile: string
): Promise<TokenUsage | undefined> {
  const parseUsageRecord = selectUsageParser(agent);
  let lastUsage: TokenUsage | undefined;

  const logStream = createReadStream(logFile, { encoding: 'utf-8' });
  const lines = createInterface({
    input: logStream,
    crlfDelay: Infinity,
  });

  try {
    for await (const line of lines) {
      const record = parseJsonLine(line);
      const usage = record ? parseUsageRecord(record) : undefined;
      if (usage) {
        lastUsage = usage;
      }
    }
  } catch {
    logger.warn(`Failed to parse usage from ${logFile}`);
    return undefined;
  } finally {
    lines.close();
    logStream.destroy();
  }

  return lastUsage;
}

export function formatUsageLine(usage: TokenUsage): string {
  return `Usage: ${numberFormatter.format(usage.inputTokens)} input │ ${numberFormatter.format(
    usage.outputTokens
  )} output │ ${numberFormatter.format(
    usage.cacheReadTokens
  )} cache read │ ${numberFormatter.format(usage.cacheWriteTokens)} cache write tokens`;
}

export function totalTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.outputTokens;
}

function getClaudeUsageRecord(record: Record<string, unknown>): TokenUsage | undefined {
  const usage = getUsageRecord(record.usage);
  if (!usage) {
    return undefined;
  }

  return {
    inputTokens: getNumericField(usage.input_tokens),
    outputTokens: getNumericField(usage.output_tokens),
    cacheReadTokens: getNumericField(usage.cache_read_input_tokens),
    cacheWriteTokens: getNumericField(usage.cache_creation_input_tokens),
  };
}

function getCodexUsageRecord(record: Record<string, unknown>): TokenUsage | undefined {
  if (record.type !== 'turn.completed') {
    return undefined;
  }

  const usage = getUsageRecord(record.usage);
  if (!usage) {
    return undefined;
  }

  return {
    inputTokens: getNumericField(usage.input_tokens),
    outputTokens: getNumericField(usage.output_tokens),
    cacheReadTokens: getNumericField(usage.cached_input_tokens),
    cacheWriteTokens: 0,
  };
}

function getCopilotUsageRecord(record: Record<string, unknown>): TokenUsage | undefined {
  if (record.type !== 'session.shutdown') {
    return undefined;
  }

  const data = getUsageRecord(record.data);
  const modelMetrics = getUsageRecord(data?.modelMetrics);
  if (!modelMetrics) {
    return undefined;
  }

  let totalUsage: TokenUsage | undefined;

  for (const modelMetric of Object.values(modelMetrics)) {
    const metricRecord = getUsageRecord(modelMetric);
    const usage = getUsageRecord(metricRecord?.usage);
    if (!usage) {
      continue;
    }

    totalUsage ??= {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    totalUsage.inputTokens += getNumericField(usage.inputTokens);
    totalUsage.outputTokens += getNumericField(usage.outputTokens);
    totalUsage.cacheReadTokens += getNumericField(usage.cacheReadTokens);
    totalUsage.cacheWriteTokens += getNumericField(usage.cacheWriteTokens);
  }

  return totalUsage;
}

function selectUsageParser(
  agent: AgentName
): (record: Record<string, unknown>) => TokenUsage | undefined {
  switch (agent) {
    case 'claude':
      return getClaudeUsageRecord;
    case 'codex':
      return getCodexUsageRecord;
    case 'copilot':
      return getCopilotUsageRecord;
    default: {
      const exhaustiveCheck: never = agent;
      throw new Error(`Unsupported agent: ${String(exhaustiveCheck)}`);
    }
  }
}

function parseJsonLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    // Malformed JSON line — expected for truncated writes; skip.
    return undefined;
  }
}

function getUsageRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function getNumericField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
