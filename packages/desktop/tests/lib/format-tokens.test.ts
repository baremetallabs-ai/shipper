import { describe, expect, it } from 'vitest';

import { formatCompactTokens } from '../../src/renderer/lib/format-tokens.js';

describe('formatCompactTokens', () => {
  it.each([
    [0, '0'],
    [999, '999'],
    [1_000, '1k'],
    [12_345, '12.3k'],
    [999_949, '999.9k'],
    [999_950, '1M'],
    [999_999, '1M'],
    [1_000_000, '1M'],
    [1_400_000, '1.4M'],
  ])('formats %d as %s', (input, expected) => {
    expect(formatCompactTokens(input)).toBe(expected);
  });
});
