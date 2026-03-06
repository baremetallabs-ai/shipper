import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import { fetchIssue, fetchPR } from './github.js';
import { agentPrompts } from './prompts.js';
import { resolveAgent } from './settings.js';

export interface RunPromptOpts {
  userInput?: string;
  issueRef?: string;
  prRef?: string;
  cwd?: string;
  baseBranch?: string;
}

export function runPrompt(name: string, opts: RunPromptOpts): number {
  const agent = resolveAgent(name);
  const promptPath = path.resolve('.shipper', 'prompts', agent, `${name}.md`);

  let raw: string;
  try {
    raw = readFileSync(promptPath, 'utf-8');
  } catch {
    const bundled = agentPrompts[agent]?.[`${name}.md`];
    if (!bundled) {
      console.error(`Error: No prompt found for step "${name}" (agent: ${agent}).`);
      console.error(`No local file at ${promptPath} and no bundled default available.`);
      return 1;
    }
    raw = bundled;
  }

  const { frontmatter, body } = parseFrontmatter(raw);

  if (frontmatter.cmd !== agent) {
    console.error(
      `Error: Agent mismatch for step "${name}". Settings resolve to "${agent}", but prompt frontmatter specifies "cmd: ${frontmatter.cmd}" in ${promptPath}.`
    );
    console.error(
      `Update the prompt file's frontmatter to "cmd: ${agent}", or change agents.${name} in settings.`
    );
    return 1;
  }

  let promptBody = body;
  if (opts.baseBranch) {
    promptBody = promptBody.replaceAll('{{BASE_BRANCH}}', opts.baseBranch);
  }

  const args = [...frontmatter.args];

  if (agent === 'claude') {
    args.push('--append-system-prompt', promptBody);
  } else if (agent === 'codex') {
    args.push(promptBody);
  } else {
    args.push('--append-system-prompt', promptBody);
  }

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

  const result = spawnSync(agent, args, {
    stdio: 'inherit',
    env: process.env,
    cwd: opts.cwd,
  });

  if (result.error) {
    console.error(`Error: Failed to spawn ${agent}: ${result.error.message}`);
    return 1;
  }

  return result.status ?? 1;
}
