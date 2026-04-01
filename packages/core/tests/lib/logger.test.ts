import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger, formatDuration } from '../../src/lib/logger.js';

const errorMock = vi.spyOn(console, 'error').mockImplementation(() => {});

describe('formatDuration', () => {
  it('clamps sub-second durations to 0s', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(999)).toBe('0s');
  });

  it('renders sub-minute durations as seconds', () => {
    expect(formatDuration(45_000)).toBe('45s');
  });

  it('renders minute-plus-second durations', () => {
    expect(formatDuration(61_000)).toBe('1m 1s');
  });

  it('renders hour-plus-minute-plus-second durations', () => {
    expect(formatDuration(3_661_000)).toBe('1h 1m 1s');
  });
});

describe('createLogger', () => {
  beforeEach(() => {
    errorMock.mockClear();
  });

  it('formats each lifecycle message exactly', () => {
    const logger = createLogger();

    logger.stageStart('implement', '529');
    logger.stageComplete('implement', '529', 61_000);
    logger.stageFailed('implement', '529', 3_661_000);
    logger.worktreeStep('running agent');

    expect(errorMock.mock.calls).toEqual([
      ['[shipper] ▶ stage:implement #529 starting'],
      ['[shipper] ✓ stage:implement #529 complete (1m 1s)'],
      ['[shipper] ✗ stage:implement #529 failed (1h 1m 1s)'],
      ['[shipper]   worktree: running agent'],
    ]);
  });

  it('mirrors lifecycle messages to the optional stream', () => {
    const stream = new PassThrough();
    let captured = '';
    stream.on('data', (chunk: Buffer | string) => {
      captured += chunk.toString();
    });

    const logger = createLogger({ stream });
    logger.stageStart('plan', '42');
    logger.worktreeStep('creating branch');

    expect(errorMock.mock.calls).toEqual([
      ['[shipper] ▶ stage:plan #42 starting'],
      ['[shipper]   worktree: creating branch'],
    ]);
    expect(captured).toBe(
      '[shipper] ▶ stage:plan #42 starting\n[shipper]   worktree: creating branch\n'
    );
  });
});
