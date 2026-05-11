import { describe, expect, it } from 'vitest';
import {
  DEFER_MARKER_PREFIX,
  DEFER_MARKER_SUFFIX,
  findMissingAnswers,
  parseDeferMarker,
} from '../../src/lib/defer-loop.js';
import type { DeferQuestion } from '../../src/lib/defer-stream.js';

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

const QUESTIONS: DeferQuestion[] = [
  { question: 'First?', options: [], multiSelect: false },
  { question: 'Second?', options: [], multiSelect: false },
];

describe('findMissingAnswers', () => {
  it('returns an empty array when all current question texts are present', () => {
    expect(findMissingAnswers(QUESTIONS, { 'First?': 'one', 'Second?': 'two' })).toEqual([]);
  });

  it('returns the missing current question text', () => {
    expect(findMissingAnswers(QUESTIONS, { 'First?': 'one' })).toEqual(['Second?']);
  });

  it('counts an empty-string answer as present', () => {
    expect(findMissingAnswers(QUESTIONS, { 'First?': '', 'Second?': 'two' })).toEqual([]);
  });

  it('does not let extra answer keys satisfy a missing required key', () => {
    expect(findMissingAnswers(QUESTIONS, { 'First?': 'one', Other: 'value' })).toEqual(['Second?']);
  });
});
