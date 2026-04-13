import { describe, it, expect } from 'vitest';
import { formatSpawnResult, formatToolError } from '../src/helpers.js';

describe('formatToolError', () => {
  it('returns isError with Error message', () => {
    const result = formatToolError(new Error('boom'));
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('boom');
  });

  it('handles non-Error inputs', () => {
    const result = formatToolError('just a string');
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('just a string');
  });
});

describe('formatSpawnResult', () => {
  it('formats a successful run without isError', () => {
    const result = formatSpawnResult(
      { exitCode: 0, stdout: 'all good\n', stderr: '', timedOut: false },
      'shipper merge --once'
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('[exit 0] shipper merge --once');
    expect(result.content[0]?.text).toContain('all good');
  });

  it('flags non-zero exit as an error', () => {
    const result = formatSpawnResult(
      { exitCode: 1, stdout: '', stderr: 'bad thing', timedOut: false },
      'shipper next 42 --mode headless'
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('[exit 1]');
    expect(result.content[0]?.text).toContain('bad thing');
  });

  it('flags a timeout as an error', () => {
    const result = formatSpawnResult(
      { exitCode: -1, stdout: 'partial', stderr: '', timedOut: true },
      'shipper ship 1 --mode headless'
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('[timed out]');
  });
});
