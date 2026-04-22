import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractFinalMessage } from '../../src/lib/transcript.js';

function writeTempLog(contents: string): { dir: string; file: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'transcript-log-'));
  const file = path.join(dir, 'session.jsonl');
  writeFileSync(file, contents, 'utf-8');
  return { dir, file };
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('extractFinalMessage', () => {
  it('returns the last Claude assistant text block verbatim', async () => {
    const { dir, file } = writeTempLog(
      [
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'First answer' }],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Implemented the change.' },
              { type: 'tool_use', name: 'shell' },
              { type: 'text', text: 'Tests are green.' },
            ],
          },
        }),
      ].join('\n')
    );
    tempDirs.push(dir);

    await expect(extractFinalMessage('claude', file)).resolves.toBe(
      'Implemented the change.\nTests are green.'
    );
  });

  it('returns the last Codex assistant output_text message verbatim', async () => {
    const { dir, file } = writeTempLog(
      [
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Initial status' }],
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'output_text', text: 'Created the issue.' },
              { type: 'output_text', text: 'URL: https://github.com/owner/repo/issues/42' },
            ],
          },
        }),
      ].join('\n')
    );
    tempDirs.push(dir);

    await expect(extractFinalMessage('codex', file)).resolves.toBe(
      'Created the issue.\nURL: https://github.com/owner/repo/issues/42'
    );
  });

  it('returns recognizable Copilot assistant text', async () => {
    const { dir, file } = writeTempLog(
      [
        JSON.stringify({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Working on it.' }],
        }),
        JSON.stringify({
          type: 'message',
          role: 'assistant',
          text: 'Finished the implementation.',
        }),
      ].join('\n')
    );
    tempDirs.push(dir);

    await expect(extractFinalMessage('copilot', file)).resolves.toBe(
      'Finished the implementation.'
    );
  });

  it('skips malformed JSON lines and keeps the last valid assistant message', async () => {
    const { dir, file } = writeTempLog(
      [
        'not json',
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Valid final message' }],
          },
        }),
      ].join('\n')
    );
    tempDirs.push(dir);

    await expect(extractFinalMessage('claude', file)).resolves.toBe('Valid final message');
  });

  it('returns undefined for missing files', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'transcript-log-'));
    tempDirs.push(dir);

    await expect(
      extractFinalMessage('claude', path.join(dir, 'missing.jsonl'))
    ).resolves.toBeUndefined();
  });

  it('returns undefined for empty files', async () => {
    const { dir, file } = writeTempLog('\n');
    tempDirs.push(dir);

    await expect(extractFinalMessage('claude', file)).resolves.toBeUndefined();
  });

  it('returns undefined for raw Codex stdout captures', async () => {
    const { dir, file } = writeTempLog('OpenAI Codex v1.0.0\nStarting session...\n');
    tempDirs.push(dir);

    await expect(extractFinalMessage('codex', file)).resolves.toBeUndefined();
  });

  it('returns undefined when Copilot records do not expose recognizable assistant text', async () => {
    const { dir, file } = writeTempLog(
      JSON.stringify({
        type: 'session.shutdown',
        data: { exitCode: 0 },
      })
    );
    tempDirs.push(dir);

    await expect(extractFinalMessage('copilot', file)).resolves.toBeUndefined();
  });
});
