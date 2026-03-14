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
