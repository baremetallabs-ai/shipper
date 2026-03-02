import { describe, it, expect } from 'vitest';
import { parseFrontmatter } from '../../src/lib/frontmatter.js';

describe('parseFrontmatter', () => {
  it('parses cmd and args from frontmatter', () => {
    const input = `---
cmd: claude
args:
  - --model
  - opus
---

You are a helpful assistant.`;

    const result = parseFrontmatter(input);
    expect(result.frontmatter.cmd).toBe('claude');
    expect(result.frontmatter.args).toEqual(['--model', 'opus']);
    expect(result.body).toBe('You are a helpful assistant.');
  });

  it('parses boolean flags', () => {
    const input = `---
cmd: claude
args:
  - --model
  - opus
append-user-input: true
append-issue: true
append-pr: false
---

Body text here.`;

    const result = parseFrontmatter(input);
    expect(result.frontmatter['append-user-input']).toBe(true);
    expect(result.frontmatter['append-issue']).toBe(true);
    expect(result.frontmatter['append-pr']).toBe(false);
  });

  it('throws when frontmatter delimiters are missing', () => {
    expect(() => parseFrontmatter('no frontmatter here')).toThrow('missing frontmatter');
  });

  it('throws when cmd is missing', () => {
    const input = `---
args:
  - --model
---

Body.`;

    expect(() => parseFrontmatter(input)).toThrow('missing required "cmd"');
  });

  it('handles empty args list', () => {
    const input = `---
cmd: claude
---

Body.`;

    const result = parseFrontmatter(input);
    expect(result.frontmatter.cmd).toBe('claude');
    expect(result.frontmatter.args).toEqual([]);
    expect(result.body).toBe('Body.');
  });

  it('preserves body content with markdown', () => {
    const input = `---
cmd: claude
args:
  - --model
  - opus
---

# Title

Some **bold** text.

- list item 1
- list item 2`;

    const result = parseFrontmatter(input);
    expect(result.body).toContain('# Title');
    expect(result.body).toContain('**bold**');
    expect(result.body).toContain('- list item 1');
  });

  it('parses the actual new.md prompt format', () => {
    const input = `---
cmd: claude
args:
  - --model
  - opus
append-user-input: true
---

You are helping a developer turn a rough idea into a lightweight GitHub issue.`;

    const result = parseFrontmatter(input);
    expect(result.frontmatter.cmd).toBe('claude');
    expect(result.frontmatter.args).toEqual(['--model', 'opus']);
    expect(result.frontmatter['append-user-input']).toBe(true);
    expect(result.frontmatter['append-issue']).toBeUndefined();
  });
});
