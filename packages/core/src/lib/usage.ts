import { readFile } from 'node:fs/promises';
import type { AgentName } from './settings.js';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

const numberFormatter = new Intl.NumberFormat('en-US');

export async function parseAgentUsage(
  agent: AgentName,
  logFile: string
): Promise<TokenUsage | undefined> {
  let contents: string;
  try {
    contents = await readFile(logFile, 'utf-8');
  } catch {
    return undefined;
  }

  if (!contents.trim()) {
    return undefined;
  }

  try {
    return agent === 'claude' ? parseClaudeUsage(contents) : parseCodexUsage(contents);
  } catch {
    return undefined;
  }
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

function parseClaudeUsage(contents: string): TokenUsage | undefined {
  let lastUsage: TokenUsage | undefined;

  for (const line of contents.split(/\r?\n/)) {
    const record = parseJsonLine(line);
    const usage = record ? getUsageRecord(record.usage) : undefined;
    if (usage) {
      lastUsage = {
        inputTokens: getNumericField(usage.input_tokens),
        outputTokens: getNumericField(usage.output_tokens),
        cacheReadTokens: getNumericField(usage.cache_read_input_tokens),
        cacheWriteTokens: getNumericField(usage.cache_creation_input_tokens),
      };
    }
  }

  return lastUsage;
}

function parseCodexUsage(contents: string): TokenUsage | undefined {
  let lastUsage: TokenUsage | undefined;

  for (const line of contents.split(/\r?\n/)) {
    const record = parseJsonLine(line);
    if (!record || record.type !== 'turn.completed') {
      continue;
    }

    const usage = getUsageRecord(record.usage);
    if (!usage) {
      continue;
    }

    lastUsage = {
      inputTokens: getNumericField(usage.input_tokens),
      outputTokens: getNumericField(usage.output_tokens),
      cacheReadTokens: getNumericField(usage.cached_input_tokens),
      cacheWriteTokens: 0,
    };
  }

  return lastUsage;
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
