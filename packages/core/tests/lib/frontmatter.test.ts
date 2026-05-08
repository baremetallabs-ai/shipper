import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { parseFrontmatter } from '../../src/lib/frontmatter.js';

const testDir = dirname(fileURLToPath(import.meta.url));

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
append-issue: true
append-pr: false
---

Body text here.`;

    const result = parseFrontmatter(input);
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
---

You are helping a developer turn a rough idea into a lightweight GitHub issue.`;

    const result = parseFrontmatter(input);
    expect(result.frontmatter.cmd).toBe('claude');
    expect(result.frontmatter.args).toEqual(['--model', 'opus']);
    expect(result.frontmatter['append-issue']).toBeUndefined();
  });

  it('ignores deprecated append-user-input while preserving recognized keys', () => {
    const input = `---
cmd: claude
append-user-input: true
append-issue: true
---

Body text here.`;

    const result = parseFrontmatter(input);
    const frontmatter = result.frontmatter as Record<string, unknown>;
    expect(frontmatter['append-user-input']).toBeUndefined();
    expect(result.frontmatter['append-issue']).toBe(true);
    expect(result.body).toBe('Body text here.');
  });

  it('parses every prompt that passes --settings as valid JSON', () => {
    const promptPaths = [
      '../../src/prompts/claude/implement.md',
      '../../src/prompts/claude/pr_open.md',
      '../../src/prompts/claude/pr_remediate.md',
    ];

    for (const promptPath of promptPaths) {
      const input = readFileSync(resolve(testDir, promptPath), 'utf8');
      const result = parseFrontmatter(input);
      const settingsIndex = result.frontmatter.args.indexOf('--settings');
      expect(settingsIndex, `${promptPath} is missing --settings`).toBeGreaterThanOrEqual(0);

      const settingsArg = result.frontmatter.args[settingsIndex + 1];
      expect(settingsArg, `${promptPath} is missing the settings payload`).toBeDefined();
      if (settingsArg === undefined) {
        throw new Error(`${promptPath} is missing the settings payload`);
      }
      expect(() => {
        JSON.parse(settingsArg);
      }).not.toThrow();
    }
  });

  it('does not pass sandbox settings in the Claude setup prompts', () => {
    const promptPaths = [
      '../../src/prompts/claude/setup.md',
      '../../src/prompts/claude/setup_remediate.md',
    ];

    for (const promptPath of promptPaths) {
      const input = readFileSync(resolve(testDir, promptPath), 'utf8');
      const result = parseFrontmatter(input);

      expect(result.frontmatter.args, `${promptPath} must not pass --settings`).not.toContain(
        '--settings'
      );
      expect(input, `${promptPath} must not contain sandbox configuration`).not.toMatch(/sandbox/i);
      expect(input, `${promptPath} must not auto-allow sandboxed Bash`).not.toContain(
        'autoAllowBashIfSandboxed'
      );
      expect(input, `${promptPath} must not mention stale cache troubleshooting`).not.toContain(
        'Sandbox cache errors'
      );
    }
  });

  it('keeps the Claude setup permission posture without stale sandbox copy', () => {
    const input = readFileSync(resolve(testDir, '../../src/prompts/claude/setup.md'), 'utf8');
    const result = parseFrontmatter(input);

    expect(result.frontmatter.args).toContain('--permission-mode');
    expect(result.frontmatter.args).toContain('acceptEdits');
    expect(input).not.toContain('Sandbox permission patterns');
    expect(input).not.toContain('sandboxed worktree');
    expect(input).not.toContain('using an absolute path will be denied');
  });

  it('keeps the Claude setup remediation transport and permission posture', () => {
    const input = readFileSync(
      resolve(testDir, '../../src/prompts/claude/setup_remediate.md'),
      'utf8'
    );
    const result = parseFrontmatter(input);

    expect(result.frontmatter.args).toContain('-p');
    expect(result.frontmatter.args).toContain('--permission-mode');
    expect(result.frontmatter.args).toContain('acceptEdits');
    expect(result.frontmatter['append-pr']).toBe(true);
  });

  it('keeps Codex and Copilot setup frontmatter unchanged', () => {
    const promptPaths = [
      { path: '../../src/prompts/codex/setup.md', cmd: 'codex' },
      { path: '../../src/prompts/copilot/setup.md', cmd: 'copilot' },
    ];

    for (const { path: promptPath, cmd } of promptPaths) {
      const input = readFileSync(resolve(testDir, promptPath), 'utf8');
      const result = parseFrontmatter(input);

      expect(result.frontmatter.cmd).toBe(cmd);
      expect(result.frontmatter.args).toEqual([]);
    }
  });

  it('requires append-pr on the setup remediation prompts', () => {
    const promptPaths = [
      '../../src/prompts/claude/setup_remediate.md',
      '../../src/prompts/codex/setup_remediate.md',
      '../../src/prompts/copilot/setup_remediate.md',
    ];

    for (const promptPath of promptPaths) {
      const input = readFileSync(resolve(testDir, promptPath), 'utf8');
      const result = parseFrontmatter(input);
      expect(result.frontmatter['append-pr'], `${promptPath} must append PR text`).toBe(true);
    }
  });
});
