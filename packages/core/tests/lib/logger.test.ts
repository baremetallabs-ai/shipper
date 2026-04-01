import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger, formatDuration, logger as defaultLogger } from '../../src/lib/logger.js';

const logMock = vi.spyOn(console, 'log').mockImplementation(() => {});
const warnMock = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    logMock.mockClear();
    warnMock.mockClear();
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

  it('omits the issue marker when no issue number is provided', () => {
    const logger = createLogger();

    logger.stageStart('merge', '');
    logger.stageFailed('merge', '', 5_000);

    expect(errorMock.mock.calls).toEqual([
      ['[shipper] ▶ stage:merge starting'],
      ['[shipper] ✗ stage:merge failed (5s)'],
    ]);
  });

  it('skips writes to an ended optional stream', () => {
    const stream = new PassThrough();
    const logger = createLogger({ stream });

    stream.end();

    expect(() => {
      logger.stageStart('plan', '42');
    }).not.toThrow();
    expect(errorMock.mock.calls).toEqual([['[shipper] ▶ stage:plan #42 starting']]);
  });

  it('writes log messages to stdout with the shipper prefix', () => {
    const logger = createLogger();

    logger.log('hello');

    expect(logMock.mock.calls).toEqual([['[shipper] hello']]);
    expect(warnMock).not.toHaveBeenCalled();
    expect(errorMock).not.toHaveBeenCalled();
  });

  it('writes warn messages to console.warn with the shipper prefix', () => {
    const logger = createLogger();

    logger.warn('careful');

    expect(warnMock.mock.calls).toEqual([['[shipper] careful']]);
    expect(logMock).not.toHaveBeenCalled();
    expect(errorMock).not.toHaveBeenCalled();
  });

  it('writes error messages to stderr with the shipper prefix', () => {
    const logger = createLogger();

    logger.error('broken');

    expect(errorMock.mock.calls).toEqual([['[shipper] broken']]);
    expect(logMock).not.toHaveBeenCalled();
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('mirrors general-purpose messages to the optional stream', () => {
    const stream = new PassThrough();
    let captured = '';
    stream.on('data', (chunk: Buffer | string) => {
      captured += chunk.toString();
    });

    const logger = createLogger({ stream });
    logger.log('hello');
    logger.warn('careful');
    logger.error('broken');

    expect(logMock.mock.calls).toEqual([['[shipper] hello']]);
    expect(warnMock.mock.calls).toEqual([['[shipper] careful']]);
    expect(errorMock.mock.calls).toEqual([['[shipper] broken']]);
    expect(captured).toBe('[shipper] hello\n[shipper] careful\n[shipper] broken\n');
  });

  it('skips writes to a destroyed optional stream for general-purpose messages', () => {
    const stream = new PassThrough();
    const logger = createLogger({ stream });

    stream.destroy();

    expect(() => {
      logger.log('hello');
      logger.warn('careful');
      logger.error('broken');
    }).not.toThrow();
    expect(logMock.mock.calls).toEqual([['[shipper] hello']]);
    expect(warnMock.mock.calls).toEqual([['[shipper] careful']]);
    expect(errorMock.mock.calls).toEqual([['[shipper] broken']]);
  });

  it('exports a default logger instance', () => {
    defaultLogger.log('from default');

    expect(logMock.mock.calls).toEqual([['[shipper] from default']]);
  });

  it('preserves leading newlines before the shipper prefix', () => {
    const logger = createLogger();

    logger.log('\nhello');
    logger.warn('\ncareful');
    logger.error('\nbroken');

    expect(logMock.mock.calls).toEqual([['\n[shipper] hello']]);
    expect(warnMock.mock.calls).toEqual([['\n[shipper] careful']]);
    expect(errorMock.mock.calls).toEqual([['\n[shipper] broken']]);
  });
});
