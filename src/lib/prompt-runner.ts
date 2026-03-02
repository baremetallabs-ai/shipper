import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import { fetchIssue, fetchPR } from './github.js';

export interface RunPromptOpts {
  userInput?: string;
  issueRef?: string;
  prRef?: string;
  cwd?: string;
}

export function runPrompt(name: string, opts: RunPromptOpts): number {
  const promptPath = path.resolve('.shipper', 'prompts', `${name}.md`);

  let raw: string;
  try {
    raw = readFileSync(promptPath, 'utf-8');
  } catch {
    console.error(`Error: Could not read prompt file at ${promptPath}`);
    console.error('Run `shipper init` to set up prompts.');
    return 1;
  }

  const { frontmatter, body } = parseFrontmatter(raw);

  const args = [...frontmatter.args];
  args.push('--append-system-prompt', body);

  const messageParts: string[] = [];

  if (frontmatter['append-issue'] && opts.issueRef) {
    messageParts.push(fetchIssue(opts.issueRef));
  }

  if (frontmatter['append-pr'] && opts.prRef) {
    messageParts.push(fetchPR(opts.prRef));
  }

  if (frontmatter['append-user-input'] && opts.userInput) {
    messageParts.push(opts.userInput);
  }

  const userMessage = messageParts.join('\n\n---\n\n');
  if (userMessage) {
    args.push(userMessage);
  }

  const result = spawnSync(frontmatter.cmd, args, {
    stdio: 'inherit',
    env: process.env,
    cwd: opts.cwd,
  });

  if (result.error) {
    console.error(`Error: Failed to spawn ${frontmatter.cmd}: ${result.error.message}`);
    return 1;
  }

  return result.status ?? 1;
}
