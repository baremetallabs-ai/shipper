import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

  it('strips double quotes from cmd value', () => {
    const input = `---
cmd: "claude"
---

Body.`;

    const result = parseFrontmatter(input);
    expect(result.frontmatter.cmd).toBe('claude');
  });

  it('strips single quotes from cmd value', () => {
    const input = `---
cmd: 'claude'
---

Body.`;

    const result = parseFrontmatter(input);
    expect(result.frontmatter.cmd).toBe('claude');
  });

  it('strips double quotes from args items', () => {
    const input = `---
cmd: claude
args:
  - "--model"
  - "opus"
---

Body.`;

    const result = parseFrontmatter(input);
    expect(result.frontmatter.args).toEqual(['--model', 'opus']);
  });

  it('strips single quotes from args items', () => {
    const input = `---
cmd: claude
args:
  - '--model'
  - 'opus'
---

Body.`;

    const result = parseFrontmatter(input);
    expect(result.frontmatter.args).toEqual(['--model', 'opus']);
  });

  it('strips quotes from boolean flag values', () => {
    const input = `---
cmd: claude
append-issue: "true"
---

Body.`;

    const result = parseFrontmatter(input);
    expect(result.frontmatter['append-issue']).toBe(true);
  });

  it('leaves mismatched quotes as-is', () => {
    const input = `---
cmd: "claude'
---

Body.`;

    const result = parseFrontmatter(input);
    expect(result.frontmatter.cmd).toBe('"claude\'');
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

  it('parses every prompt that passes --settings as valid JSON', () => {
    const promptPaths = [
      'src/prompts/claude/implement.md',
      'src/prompts/claude/pr_open.md',
      'src/prompts/claude/pr_remediate.md',
      'src/prompts/claude/setup.md',
    ];

    for (const promptPath of promptPaths) {
      const input = readFileSync(resolve(promptPath), 'utf8');
      const result = parseFrontmatter(input);
      const settingsIndex = result.frontmatter.args.indexOf('--settings');
      expect(settingsIndex, `${promptPath} is missing --settings`).toBeGreaterThanOrEqual(0);

      const settingsArg = result.frontmatter.args[settingsIndex + 1];
      expect(settingsArg, `${promptPath} is missing the settings payload`).toBeDefined();
      if (settingsArg === undefined) {
        throw new Error(`${promptPath} is missing the settings payload`);
      }
      expect(() => JSON.parse(settingsArg)).not.toThrow();
    }
  });
});
