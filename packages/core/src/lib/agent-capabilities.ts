export const NEW_ISSUE_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type NewIssueImageMimeType = (typeof NEW_ISSUE_IMAGE_MIME_TYPES)[number];
export const NEW_ISSUE_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const NEW_ISSUE_MAX_IMAGES = 5;
export const NEW_ISSUE_IMAGE_CAPABLE_AGENTS = ['codex'] as const;
export const SHIPPER_NEW_ISSUE_SCREENSHOT_DIR_ENV = 'SHIPPER_NEW_ISSUE_SCREENSHOT_DIR';
export const NEW_ISSUE_IMAGE_EXTENSION_BY_MIME_TYPE = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
} as const satisfies Record<NewIssueImageMimeType, 'png' | 'jpg' | 'webp'>;

export function isNewIssueImageMimeType(value: string): value is NewIssueImageMimeType {
  return NEW_ISSUE_IMAGE_MIME_TYPES.includes(value as NewIssueImageMimeType);
}

export function supportsNewIssueImages(agent: string): boolean {
  return (NEW_ISSUE_IMAGE_CAPABLE_AGENTS as readonly string[]).includes(agent);
}
