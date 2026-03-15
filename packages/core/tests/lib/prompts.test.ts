import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('groom prompts', () => {
  it.each(['claude', 'codex'])(
    'documents priority choices and label reconciliation for %s',
    (agent) => {
      const prompt = readFileSync(
        new URL(`../../src/prompts/${agent}/groom.md`, import.meta.url),
        'utf-8'
      );

      expect(prompt).toContain('After all other product decisions are resolved');
      expect(prompt).toContain('**High**');
      expect(prompt).toContain('**Normal**');
      expect(prompt).toContain('**Low**');
      expect(prompt).toContain('shipper:priority-high');
      expect(prompt).toContain('shipper:priority-low');
      expect(prompt).toContain('--remove-label "shipper:priority-low"');
      expect(prompt).toContain('--remove-label "shipper:priority-high"');
    }
  );
});

describe('pr_open prompts', () => {
  it.each(['claude', 'codex'])(
    'write PR protocol artifacts and avoid direct GitHub commands for %s',
    (agent) => {
      const prompt = readFileSync(
        new URL(`../../src/prompts/${agent}/pr_open.md`, import.meta.url),
        'utf-8'
      );

      expect(prompt).toContain('.shipper/output/pr-body-<number>.md');
      expect(prompt).toContain('.shipper/output/pr-spec-<number>.json');
      expect(prompt).toContain('.shipper/output/result.json');
      expect(prompt).toContain('{{BASE_BRANCH}}');
      expect(prompt).not.toContain('<base branch from context>');
      expect(prompt).not.toContain('gh pr create');
      expect(prompt).not.toContain('gh pr checks');
      expect(prompt).not.toContain('gh issue comment');
      expect(prompt).not.toContain('gh issue edit');
    }
  );
});

describe('pr_review prompts', () => {
  it.each(['claude', 'codex'])(
    'read pre-flight review context and avoid direct GitHub commands for %s',
    (agent) => {
      const prompt = readFileSync(
        new URL(`../../src/prompts/${agent}/pr_review.md`, import.meta.url),
        'utf-8'
      );

      expect(prompt).toContain('.shipper/input/pr-diff.patch');
      expect(prompt).toContain('.shipper/input/pr-files.json');
      expect(prompt).toContain('.shipper/input/pr-metadata.json');
      expect(prompt).toContain('.shipper/output/review-payload-<number>.json');
      expect(prompt).toContain('.shipper/output/result.json');
      expect(prompt).not.toContain('gh pr diff');
      expect(prompt).not.toContain('gh pr view');
      expect(prompt).not.toContain('gh repo view');
      expect(prompt).not.toContain('gh issue comment');
      expect(prompt).not.toContain('gh issue edit');
      expect(prompt).not.toContain('./.shipper/scripts/gh-api-');
    }
  );
});
