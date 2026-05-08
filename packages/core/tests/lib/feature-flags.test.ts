import { afterEach, describe, expect, it } from 'vitest';
import {
  DESIGN_ADVERSARY_FLAG,
  MCP_GROOMING_FLAG,
  isDesignAdversaryEnabled,
  isMcpGroomingEnabled,
} from '../../src/lib/feature-flags.js';

const ORIGINAL_MCP = process.env[MCP_GROOMING_FLAG];
const ORIGINAL_ADVERSARY = process.env[DESIGN_ADVERSARY_FLAG];

afterEach(() => {
  if (ORIGINAL_MCP === undefined) {
    Reflect.deleteProperty(process.env, MCP_GROOMING_FLAG);
  } else {
    process.env[MCP_GROOMING_FLAG] = ORIGINAL_MCP;
  }
  if (ORIGINAL_ADVERSARY === undefined) {
    Reflect.deleteProperty(process.env, DESIGN_ADVERSARY_FLAG);
  } else {
    process.env[DESIGN_ADVERSARY_FLAG] = ORIGINAL_ADVERSARY;
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

describe('isDesignAdversaryEnabled', () => {
  it('returns false when the flag is unset', () => {
    Reflect.deleteProperty(process.env, DESIGN_ADVERSARY_FLAG);
    expect(isDesignAdversaryEnabled()).toBe(false);
  });

  it('returns true for truthy values', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on', 'enabled']) {
      process.env[DESIGN_ADVERSARY_FLAG] = value;
      expect(isDesignAdversaryEnabled()).toBe(true);
    }
  });

  it('returns false for falsy values', () => {
    for (const value of ['0', 'false', 'FALSE', 'no', '']) {
      process.env[DESIGN_ADVERSARY_FLAG] = value;
      expect(isDesignAdversaryEnabled()).toBe(false);
    }
  });
});
