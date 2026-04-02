import { describe, expect, it } from 'vitest';

import { toError, toErrorMessage } from '../../src/lib/errors.js';

describe('toError', () => {
  it('preserves Error instances', () => {
    const error = new Error('boom');

    expect(toError(error)).toBe(error);
  });

  it.each([
    ['string', 'failure', 'failure'],
    ['undefined', undefined, 'undefined'],
    ['null', null, 'null'],
    ['plain object', { boom: true }, '[object Object]'],
    ['number', 42, '42'],
    ['boolean', false, 'false'],
  ])('wraps %s inputs in Error objects', (_label, input, expectedMessage) => {
    const error = toError(input);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(expectedMessage);
  });
});

describe('toErrorMessage', () => {
  it('preserves Error messages', () => {
    expect(toErrorMessage(new Error('boom'))).toBe('boom');
  });

  it.each([
    ['string', 'failure', 'failure'],
    ['undefined', undefined, 'undefined'],
    ['null', null, 'null'],
    ['plain object', { boom: true }, '[object Object]'],
    ['number', 42, '42'],
    ['boolean', false, 'false'],
  ])('stringifies %s inputs', (_label, input, expectedMessage) => {
    expect(toErrorMessage(input)).toBe(expectedMessage);
  });
});
