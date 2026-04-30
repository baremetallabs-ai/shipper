import { afterEach, describe, expect, it } from 'vitest';
import { MCP_GROOMING_FLAG, isMcpGroomingEnabled } from '../../src/lib/feature-flags.js';

const ORIGINAL = process.env[MCP_GROOMING_FLAG];

afterEach(() => {
  if (ORIGINAL === undefined) {
    Reflect.deleteProperty(process.env, MCP_GROOMING_FLAG);
  } else {
    process.env[MCP_GROOMING_FLAG] = ORIGINAL;
  }
});

describe('isMcpGroomingEnabled', () => {
  it('returns false when the flag is unset', () => {
    Reflect.deleteProperty(process.env, MCP_GROOMING_FLAG);
    expect(isMcpGroomingEnabled()).toBe(false);
  });

  it('returns true for truthy values', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on', 'enabled']) {
      process.env[MCP_GROOMING_FLAG] = value;
      expect(isMcpGroomingEnabled()).toBe(true);
    }
  });

  it('returns false for falsy values', () => {
    for (const value of ['0', 'false', 'FALSE', 'no', '']) {
      process.env[MCP_GROOMING_FLAG] = value;
      expect(isMcpGroomingEnabled()).toBe(false);
    }
  });
});
