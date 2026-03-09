import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import { fetchIssue, fetchPR } from './github.js';
import { agentPrompts } from './prompts.js';
import { resolveAgent, resolveMode, type CommandMode } from './settings.js';

export interface RunPromptOpts {
  userInput?: string;
  issueRef?: string;
  prRef?: string;
  cwd?: string;
  baseBranch?: string;
  mode?: CommandMode;
}

const CODEX_HEADLESS_CONFIG = 'sandbox_workspace_write.network_access=true';
const CODEX_HEADLESS_ARGS = ['exec', '--full-auto', '-c', CODEX_HEADLESS_CONFIG] as const;

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
      `Update the prompt file's frontmatter to "cmd: ${agent}", or change commands.${name}.agent in settings.`
    );
    return 1;
  }

  let promptBody = body;
  if (opts.baseBranch) {
    promptBody = promptBody.replaceAll('{{BASE_BRANCH}}', opts.baseBranch);
  }

  const args = [...frontmatter.args];
  const effectiveMode = resolveMode(name, opts.mode);

  if (effectiveMode === 'headless') {
    if (agent === 'claude' && !args.includes('-p')) {
      args.unshift('-p');
    } else if (agent === 'codex') {
      normalizeCodexHeadlessArgs(args);
    }
  } else if (effectiveMode === 'interactive') {
    if (agent === 'claude') {
      const pIdx = args.indexOf('-p');
      if (pIdx !== -1) args.splice(pIdx, 1);
    } else if (agent === 'codex') {
      stripCodexHeadlessArgs(args);
    }
  }

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

function normalizeCodexHeadlessArgs(args: string[]): void {
  const execIdx = args.indexOf('exec');
  if (execIdx === -1) {
    args.unshift(...CODEX_HEADLESS_ARGS);
    return;
  }

  if (!args.includes('--full-auto')) {
    args.splice(execIdx + 1, 0, '--full-auto');
  }

  if (findCodexSandboxConfigIndex(args) === -1) {
    const fullAutoIdx = args.indexOf('--full-auto');
    const insertIdx = fullAutoIdx === -1 ? execIdx + 1 : fullAutoIdx + 1;
    args.splice(insertIdx, 0, '-c', CODEX_HEADLESS_CONFIG);
  }
}

function stripCodexHeadlessArgs(args: string[]): void {
  const execIdx = args.indexOf('exec');
  if (execIdx !== -1) {
    args.splice(execIdx, 1);
  }

  const fullAutoIdx = args.indexOf('--full-auto');
  if (fullAutoIdx !== -1) {
    args.splice(fullAutoIdx, 1);
  }

  const configIdx = findCodexSandboxConfigIndex(args);
  if (configIdx !== -1) {
    args.splice(configIdx, 2);
  }
}

function findCodexSandboxConfigIndex(args: string[]): number {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-c' && args[i + 1] === CODEX_HEADLESS_CONFIG) {
      return i;
    }
  }
  return -1;
}
