import { describe, expect, it } from 'vitest';
import { StreamJsonDeferConsumer } from '../../src/lib/defer-stream.js';

const SAMPLE_QUESTIONS = [
  {
    question: 'Which framework?',
    header: 'Framework',
    options: [
      { label: 'React', description: 'React lib' },
      { label: 'Vue', description: 'Vue framework' },
    ],
    multiSelect: false,
  },
];

function makeStreamLines(events: object[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

describe('StreamJsonDeferConsumer', () => {
  it('returns deferred event when stream-json result has stop_reason tool_deferred', () => {
    const consumer = new StreamJsonDeferConsumer();
    const stream = makeStreamLines([
      { type: 'system', subtype: 'init' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'thinking…' }] } },
      {
        type: 'result',
        subtype: 'success',
        stop_reason: 'tool_deferred',
        session_id: 'sess_abc123',
        deferred_tool_use: {
          id: 'toolu_01abc',
          name: 'AskUserQuestion',
          input: { questions: SAMPLE_QUESTIONS },
        },
      },
    ]);
    consumer.consume(stream);
    consumer.flush();

    const result = consumer.getResult();
    expect(result).toBeDefined();
    expect(result?.kind).toBe('deferred');
    if (result?.kind !== 'deferred') return;
    expect(result.sessionId).toBe('sess_abc123');
    expect(result.toolUseId).toBe('toolu_01abc');
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0]?.question).toBe('Which framework?');
    expect(result.questions[0]?.options).toHaveLength(2);
  });

  it('returns completed event when stream-json result has a non-defer stop_reason', () => {
    const consumer = new StreamJsonDeferConsumer();
    consumer.consume(
      makeStreamLines([
        { type: 'system' },
        {
          type: 'result',
          subtype: 'success',
          stop_reason: 'end_turn',
          session_id: 'sess_done',
        },
      ])
    );
    const result = consumer.getResult();
    expect(result?.kind).toBe('completed');
    if (result?.kind !== 'completed') return;
    expect(result.sessionId).toBe('sess_done');
    expect(result.stopReason).toBe('end_turn');
  });

  it('handles chunks split across newlines', () => {
    const consumer = new StreamJsonDeferConsumer();
    const events = [
      { type: 'system' },
      {
        type: 'result',
        stop_reason: 'tool_deferred',
        session_id: 'sess_split',
        deferred_tool_use: { input: { questions: SAMPLE_QUESTIONS } },
      },
    ];
    const full = makeStreamLines(events);
    const half = Math.floor(full.length / 2);
    consumer.consume(full.slice(0, half));
    consumer.consume(full.slice(half));
    consumer.flush();

    const result = consumer.getResult();
    expect(result?.kind).toBe('deferred');
  });

  it('records AskUserQuestion tool uses in assistant content order', () => {
    const consumer = new StreamJsonDeferConsumer();
    consumer.consume(
      makeStreamLines([
        {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'A',
                name: 'AskUserQuestion',
                input: { questions: [{ ...SAMPLE_QUESTIONS[0], question: 'A?' }] },
              },
              {
                type: 'tool_use',
                id: 'B',
                name: 'AskUserQuestion',
                input: { questions: [{ ...SAMPLE_QUESTIONS[0], question: 'B?' }] },
              },
              {
                type: 'tool_use',
                id: 'C',
                name: 'AskUserQuestion',
                input: { questions: [{ ...SAMPLE_QUESTIONS[0], question: 'C?' }] },
              },
            ],
          },
        },
      ])
    );

    expect(consumer.getQuestionToolUseOrder()).toEqual([
      { toolUseId: 'A', questions: [{ ...SAMPLE_QUESTIONS[0], question: 'A?' }] },
      { toolUseId: 'B', questions: [{ ...SAMPLE_QUESTIONS[0], question: 'B?' }] },
      { toolUseId: 'C', questions: [{ ...SAMPLE_QUESTIONS[0], question: 'C?' }] },
    ]);
  });

  it('records AskUserQuestion tool uses when assistant JSON arrives split across chunks', () => {
    const consumer = new StreamJsonDeferConsumer();
    const full = makeStreamLines([
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_split',
              name: 'AskUserQuestion',
              input: { questions: SAMPLE_QUESTIONS },
            },
          ],
        },
      },
    ]);
    const split = Math.floor(full.length / 2);
    consumer.consume(full.slice(0, split));
    consumer.consume(full.slice(split));
    consumer.flush();

    expect(consumer.getQuestionToolUseOrder()).toEqual([
      { toolUseId: 'toolu_split', questions: SAMPLE_QUESTIONS },
    ]);
  });

  it('ignores non-question tool uses and duplicate AskUserQuestion ids', () => {
    const consumer = new StreamJsonDeferConsumer();
    consumer.consume(
      makeStreamLines([
        {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'toolu_shell',
                name: 'Bash',
                input: { command: 'pwd' },
              },
              {
                type: 'tool_use',
                id: 'toolu_question',
                name: 'AskUserQuestion',
                input: { questions: [{ ...SAMPLE_QUESTIONS[0], question: 'First?' }] },
              },
              {
                type: 'tool_use',
                id: 'toolu_question',
                name: 'AskUserQuestion',
                input: { questions: [{ ...SAMPLE_QUESTIONS[0], question: 'Duplicate?' }] },
              },
            ],
          },
        },
      ])
    );

    expect(consumer.getQuestionToolUseOrder()).toEqual([
      { toolUseId: 'toolu_question', questions: [{ ...SAMPLE_QUESTIONS[0], question: 'First?' }] },
    ]);
  });

  it('ignores malformed JSON lines', () => {
    const consumer = new StreamJsonDeferConsumer();
    consumer.consume('not json\n');
    consumer.consume(JSON.stringify({ type: 'result', stop_reason: 'end_turn' }) + '\n');
    consumer.flush();
    expect(consumer.getResult()?.kind).toBe('completed');
  });

  it('returns undefined when no result event is seen', () => {
    const consumer = new StreamJsonDeferConsumer();
    consumer.consume(JSON.stringify({ type: 'system' }) + '\n');
    consumer.flush();
    expect(consumer.getResult()).toBeUndefined();
  });

  it('keeps completion metadata from the final result event', () => {
    const consumer = new StreamJsonDeferConsumer();
    consumer.consume(
      makeStreamLines([
        {
          type: 'result',
          stop_reason: 'tool_deferred',
          session_id: 's1',
          deferred_tool_use: { input: { questions: [] } },
        },
        { type: 'result', stop_reason: 'end_turn', session_id: 's2' },
      ])
    );
    const result = consumer.getResult();
    expect(result?.kind).toBe('completed');
    if (result?.kind !== 'completed') return;
    expect(result.sessionId).toBe('s2');
  });
});
