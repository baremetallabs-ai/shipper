import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.js';

export function runPrompt(name: string, userInput: string): never {
  const promptPath = path.resolve('.shipper', 'prompts', `${name}.md`);

  let raw: string;
  try {
    raw = readFileSync(promptPath, 'utf-8');
  } catch {
    console.error(`Error: Could not read prompt file at ${promptPath}`);
    console.error('Run `shipper init` to set up prompts.');
    process.exit(1);
  }

  const { frontmatter, body } = parseFrontmatter(raw);

  const args = [...frontmatter.args];
  args.push('--append-system-prompt', body);

  if (userInput) {
    args.push(userInput);
  }

  const result = spawnSync(frontmatter.cmd, args, {
    stdio: 'inherit',
    env: process.env,
  });

  if (result.error) {
    console.error(`Error: Failed to spawn ${frontmatter.cmd}: ${result.error.message}`);
    process.exit(1);
  }

  process.exit(result.status ?? 1);
}
