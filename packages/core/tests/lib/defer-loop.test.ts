import { describe, expect, it } from 'vitest';
import {
  DEFER_MARKER_PREFIX,
  DEFER_MARKER_SUFFIX,
  buildClaudeResumeArgs,
  parseDeferMarker,
} from '../../src/lib/defer-loop.js';

describe('parseDeferMarker', () => {
  it('parses a well-formed defer marker line', () => {
    const payload = {
      sessionId: 'sess-abc',
      questions: [
        {
          question: 'Pick one?',
          header: 'Q',
          options: [
            { label: 'A', description: 'a' },
            { label: 'B', description: 'b' },
          ],
          multiSelect: false,
        },
      ],
      toolUseId: 'tool-1',
    };
    const line = `${DEFER_MARKER_PREFIX}${JSON.stringify(payload)}${DEFER_MARKER_SUFFIX}`;
    const parsed = parseDeferMarker(line);
    expect(parsed?.sessionId).toBe('sess-abc');
    expect(parsed?.toolUseId).toBe('tool-1');
    expect(parsed?.questions).toHaveLength(1);
  });

  it('parses without the trailing suffix', () => {
    const payload = { sessionId: 's', questions: [] };
    const line = `${DEFER_MARKER_PREFIX}${JSON.stringify(payload)}`;
    const parsed = parseDeferMarker(line);
    expect(parsed?.sessionId).toBe('s');
  });

  it('returns undefined for unrelated lines', () => {
    expect(parseDeferMarker('regular log line')).toBeUndefined();
    expect(parseDeferMarker(`${DEFER_MARKER_PREFIX}{not valid json`)).toBeUndefined();
    expect(parseDeferMarker(`${DEFER_MARKER_PREFIX}{}`)).toBeUndefined();
    expect(
      parseDeferMarker(`${DEFER_MARKER_PREFIX}${JSON.stringify({ sessionId: 's' })}`)
    ).toBeUndefined();
  });
});

describe('buildClaudeResumeArgs', () => {
  it('appends --resume <sessionId> to the base args', () => {
    const args = buildClaudeResumeArgs(
      ['-p', '--verbose', '--output-format', 'stream-json'],
      'abc'
    );
    expect(args).toEqual(['-p', '--verbose', '--output-format', 'stream-json', '--resume', 'abc']);
  });

  it('does not mutate the input array', () => {
    const base = ['-p'];
    buildClaudeResumeArgs(base, 'x');
    expect(base).toEqual(['-p']);
  });
});
