import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatUsageLine,
  parseAgentUsage,
  totalTokens,
  type TokenUsage,
} from '../../src/lib/usage.js';

function writeTempLog(contents: string): { dir: string; file: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'usage-log-'));
  const file = path.join(dir, 'session.jsonl');
  writeFileSync(file, contents, 'utf-8');
  return { dir, file };
}

const tempDirs: string[] = [];

function makeUsage(usage: Partial<TokenUsage> = {}): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...usage,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('parseAgentUsage', () => {
  it('parses the last Claude usage record from a complete stream-json log', async () => {
    const { dir, file } = writeTempLog(
      [
        JSON.stringify({ type: 'assistant', message: 'working' }),
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          usage: {
            input_tokens: 45_230,
            output_tokens: 12_108,
            cache_read_input_tokens: 8_500,
            cache_creation_input_tokens: 2_100,
          },
        }),
      ].join('\n')
    );
    tempDirs.push(dir);

    await expect(parseAgentUsage('claude', file)).resolves.toEqual(
      makeUsage({
        inputTokens: 45_230,
        outputTokens: 12_108,
        cacheReadTokens: 8_500,
        cacheWriteTokens: 2_100,
      })
    );
  });

  it('preserves the last valid Claude usage snapshot in a truncated log', async () => {
    const { dir, file } = writeTempLog(
      [
        JSON.stringify({
          type: 'assistant',
          usage: {
            input_tokens: 100,
            output_tokens: 10,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 5,
          },
        }),
        '{"type":"result","usage":',
      ].join('\n')
    );
    tempDirs.push(dir);

    await expect(parseAgentUsage('claude', file)).resolves.toEqual(
      makeUsage({
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 20,
        cacheWriteTokens: 5,
      })
    );
  });

  it('skips malformed JSONL records while parsing Claude usage', async () => {
    const { dir, file } = writeTempLog(
      [
        'not json',
        JSON.stringify({
          type: 'assistant',
          usage: {
            input_tokens: 15,
            output_tokens: 6,
            cache_read_input_tokens: 4,
            cache_creation_input_tokens: 1,
          },
        }),
      ].join('\n')
    );
    tempDirs.push(dir);

    await expect(parseAgentUsage('claude', file)).resolves.toEqual(
      makeUsage({
        inputTokens: 15,
        outputTokens: 6,
        cacheReadTokens: 4,
        cacheWriteTokens: 1,
      })
    );
  });

  it('returns undefined for an empty log file', async () => {
    const { dir, file } = writeTempLog('\n');
    tempDirs.push(dir);

    await expect(parseAgentUsage('claude', file)).resolves.toBeUndefined();
  });

  it('returns undefined when no usage-bearing records exist', async () => {
    const { dir, file } = writeTempLog(JSON.stringify({ type: 'assistant', message: 'hello' }));
    tempDirs.push(dir);

    await expect(parseAgentUsage('claude', file)).resolves.toBeUndefined();
  });

  it('warns and returns undefined when the usage log cannot be read', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'usage-log-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'missing.jsonl');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await expect(parseAgentUsage('claude', file)).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(`[shipper] Failed to parse usage from ${file}`);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('parses the final Codex turn.completed usage payload', async () => {
    const { dir, file } = writeTempLog(
      [
        JSON.stringify({ type: 'turn.started', id: 'turn-1' }),
        JSON.stringify({
          type: 'turn.completed',
          usage: {
            input_tokens: 10_605,
            cached_input_tokens: 8_576,
            output_tokens: 26,
          },
        }),
      ].join('\n')
    );
    tempDirs.push(dir);

    await expect(parseAgentUsage('codex', file)).resolves.toEqual(
      makeUsage({
        inputTokens: 10_605,
        outputTokens: 26,
        cacheReadTokens: 8_576,
        cacheWriteTokens: 0,
      })
    );
  });
});

describe('formatUsageLine', () => {
  it('formats grouped token counts in the required one-line layout', () => {
    expect(
      formatUsageLine(
        makeUsage({
          inputTokens: 45_230,
          outputTokens: 12_108,
          cacheReadTokens: 8_500,
          cacheWriteTokens: 2_100,
        })
      )
    ).toBe('Usage: 45,230 input │ 12,108 output │ 8,500 cache read │ 2,100 cache write tokens');
  });
});

describe('totalTokens', () => {
  it('returns the canonical input plus output rollup', () => {
    expect(totalTokens(makeUsage({ inputTokens: 11, outputTokens: 7 }))).toBe(18);
  });
});
