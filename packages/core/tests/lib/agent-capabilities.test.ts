import { describe, expect, it } from 'vitest';

import {
  NEW_ISSUE_IMAGE_EXTENSION_BY_MIME_TYPE,
  NEW_ISSUE_IMAGE_CAPABLE_AGENTS,
  NEW_ISSUE_IMAGE_MIME_TYPES,
  NEW_ISSUE_MAX_IMAGE_BYTES,
  NEW_ISSUE_MAX_IMAGES,
  isNewIssueImageMimeType,
  supportsNewIssueImages,
} from '../../src/lib/agent-capabilities.js';

describe('New Issue image capabilities', () => {
  it('defines the accepted screenshot MIME types and limits', () => {
    expect(NEW_ISSUE_IMAGE_MIME_TYPES).toEqual(['image/png', 'image/jpeg', 'image/webp']);
    expect(NEW_ISSUE_MAX_IMAGE_BYTES).toBe(10 * 1024 * 1024);
    expect(NEW_ISSUE_MAX_IMAGES).toBe(5);
  });

  it('recognizes only supported screenshot MIME types', () => {
    expect(isNewIssueImageMimeType('image/png')).toBe(true);
    expect(isNewIssueImageMimeType('image/jpeg')).toBe(true);
    expect(isNewIssueImageMimeType('image/webp')).toBe(true);
    expect(isNewIssueImageMimeType('image/bmp')).toBe(false);
    expect(isNewIssueImageMimeType('image/tiff')).toBe(false);
  });

  it('maps MIME types to staging filename extensions', () => {
    expect(NEW_ISSUE_IMAGE_EXTENSION_BY_MIME_TYPE).toEqual({
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/webp': 'webp',
    });
  });

  it('supports New Issue images only for Codex', () => {
    expect(NEW_ISSUE_IMAGE_CAPABLE_AGENTS).toEqual(['codex']);
    expect(supportsNewIssueImages('codex')).toBe(true);
    expect(supportsNewIssueImages('claude')).toBe(false);
    expect(supportsNewIssueImages('copilot')).toBe(false);
  });
});
