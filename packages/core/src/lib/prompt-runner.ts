import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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

function spawnAsync(command: string, args: string[], opts: { cwd?: string }): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: process.env,
      cwd: opts.cwd,
    });

    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

export async function runPrompt(name: string, opts: RunPromptOpts): Promise<number> {
  const agent = resolveAgent(name);
  const promptPath = path.resolve('.shipper', 'prompts', agent, `${name}.md`);

  let raw: string;
  try {
    raw = await readFile(promptPath, 'utf-8');
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
    messageParts.push(await fetchIssue(opts.issueRef));
  }

  if (frontmatter['append-pr'] && opts.prRef) {
    messageParts.push(await fetchPR(opts.prRef));
  }

  if (frontmatter['append-user-input'] && opts.userInput) {
    messageParts.push(opts.userInput);
  }

  const userMessage = messageParts.join('\n\n---\n\n');
  if (userMessage) {
    if (agent === 'codex') {
      // Codex exec accepts only one positional [PROMPT] arg — no separate user
      // message mechanism. Replace the prompt arg with prompt + user message combined.
      const promptIdx = args.indexOf(promptBody);
      if (promptIdx !== -1) {
        args[promptIdx] = promptBody + '\n\n---\n\n' + userMessage;
      }
    } else {
      args.push(userMessage);
    }
  }

  try {
    return await spawnAsync(agent, args, { cwd: opts.cwd });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: Failed to spawn ${agent}: ${message}`);
    return 1;
  }
}
