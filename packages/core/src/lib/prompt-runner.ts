import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import { createWriteStream, readFileSync, statSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import { fetchIssue, fetchPR } from './github.js';
import { agentPrompts } from './prompts.js';
import { getSessionPaths, writeSessionMeta } from './session.js';
import {
  getSettings,
  resolveAgent,
  resolveModel,
  resolveMode,
  type AgentName,
  type CommandMode,
} from './settings.js';

export interface RunPromptOpts {
  userInput?: string;
  repo?: string;
  issueRef?: string;
  prRef?: string;
  cwd?: string;
  baseBranch?: string;
  mode?: CommandMode;
  agent?: AgentName;
  model?: string;
}

const CODEX_HEADLESS_CONFIG = 'sandbox_workspace_write.network_access=true';
const CODEX_HEADLESS_ARGS = ['exec', '--full-auto', '-c', CODEX_HEADLESS_CONFIG] as const;
const GH_MUTATION_PATTERNS = [
  /gh\s+issue\s+edit\b/,
  /gh\s+issue\s+comment\b/,
  /gh\s+pr\s+create\b/,
  /gh\s+pr\s+review\b/,
] as const;
const warnedPromptPaths = new Set<string>();

interface WorktreeDirs {
  gitDir: string;
  commonDir?: string;
}

function resolveWorktreeGitDir(cwd: string): WorktreeDirs | undefined {
  const dotGit = path.join(cwd, '.git');
  try {
    if (!statSync(dotGit).isFile()) return undefined;
  } catch {
    return undefined;
  }
  try {
    const content = readFileSync(dotGit, 'utf-8');
    const match = content.match(/^gitdir:\s*(.+)$/m);
    if (!match?.[1]) {
      console.warn(`Warning: .git file at ${dotGit} has no gitdir: line. Skipping --add-dir.`);
      return undefined;
    }
    const resolved = path.resolve(cwd, match[1].trim());
    try {
      statSync(resolved);
    } catch {
      console.warn(`Warning: gitdir path ${resolved} does not exist. Skipping --add-dir.`);
      return undefined;
    }

    // Resolve the shared git common dir (parent repo's .git/) so that operations
    // like `git push -u` can write to config, refs/remotes/, and logs/refs/.
    let commonDir: string | undefined;
    try {
      const commonDirContent = readFileSync(path.join(resolved, 'commondir'), 'utf-8');
      const commonDirResolved = path.resolve(resolved, commonDirContent.trim());
      try {
        statSync(commonDirResolved);
        commonDir = commonDirResolved;
      } catch {
        console.warn(
          `Warning: commondir path ${commonDirResolved} does not exist. Skipping common --add-dir.`
        );
      }
    } catch {
      // No commondir file — gitDir is the main repo .git, not a worktree sub-dir
    }

    return { gitDir: resolved, commonDir };
  } catch {
    console.warn(`Warning: Failed to read .git file at ${dotGit}. Skipping --add-dir.`);
    return undefined;
  }
}

function spawnAsync(
  command: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; logFile?: string }
): Promise<number> {
  return new Promise((resolve, reject) => {
    const stdio: StdioOptions = opts.logFile ? ['inherit', 'pipe', 'inherit'] : 'inherit';
    const child: ChildProcess = spawn(command, args, {
      stdio,
      env: process.env,
      cwd: opts.cwd,
    });
    const logStream = opts.logFile ? createWriteStream(opts.logFile) : undefined;

    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let exitCode = 1;
    let processClosed = false;
    let streamFinished = !logStream;

    const finalize = () => {
      if (!processClosed || !streamFinished) {
        return;
      }
      clearTimeout(killTimer);
      clearTimeout(graceTimer);
      resolve(exitCode);
    };

    if (logStream) {
      if (!child.stdout) {
        clearTimeout(killTimer);
        clearTimeout(graceTimer);
        reject(new Error(`Failed to capture stdout for ${command}`));
        return;
      }

      child.stdout.pipe(logStream);
      logStream.on('finish', () => {
        streamFinished = true;
        finalize();
      });
      logStream.on('error', (err: Error) => {
        clearTimeout(killTimer);
        clearTimeout(graceTimer);
        reject(err);
      });
    }

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      const timeoutMs = opts.timeoutMs;
      killTimer = setTimeout(() => {
        timedOut = true;
        const minutes = Math.round(timeoutMs / 60_000);
        console.error(`Agent timed out after ${minutes} minutes`);
        child.kill('SIGTERM');
        graceTimer = setTimeout(() => {
          child.kill('SIGKILL');
        }, 10_000);
      }, timeoutMs);
    }

    child.on('error', (err: Error) => {
      logStream?.destroy();
      clearTimeout(killTimer);
      clearTimeout(graceTimer);
      reject(err);
    });

    child.on('close', (code: number | null) => {
      exitCode = timedOut ? code || 1 : (code ?? 1);
      processClosed = true;
      finalize();
    });
  });
}

export async function runPrompt(name: string, opts: RunPromptOpts): Promise<number> {
  const agent = resolveAgent(name, opts.agent);
  const model = resolveModel(name, opts.model);
  const promptPath = path.resolve('.shipper', 'prompts', agent, `${name}.md`);

  let raw: string;
  let isLocalOverride = false;
  try {
    raw = await readFile(promptPath, 'utf-8');
    isLocalOverride = true;
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

  if (
    isLocalOverride &&
    !warnedPromptPaths.has(promptPath) &&
    GH_MUTATION_PATTERNS.some((pattern) => pattern.test(body))
  ) {
    warnedPromptPaths.add(promptPath);
    console.warn(
      `Warning: Ejected prompt '${name}' contains gh commands for state mutations.\nThese are now handled by shipper. Re-eject with 'shipper eject ${name}' or manually update.`
    );
  }

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
  const timeoutMinutes = getSettings().agentTimeoutMinutes;
  const timeoutMs =
    effectiveMode === 'headless' && timeoutMinutes > 0 ? timeoutMinutes * 60_000 : undefined;
  const repoForSession = opts.repo ?? path.basename(process.cwd());
  let logFile: string | undefined;
  let metaFile: string | undefined;

  if (effectiveMode === 'headless') {
    try {
      const sessionPaths = getSessionPaths(opts.repo, opts.issueRef, name);
      await mkdir(path.dirname(sessionPaths.logFile), { recursive: true });
      logFile = sessionPaths.logFile;
      metaFile = sessionPaths.metaFile;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`Warning: Failed to initialize session logging: ${message}`);
    }
  }

  if (agent === 'claude') {
    if (effectiveMode === 'headless' && !args.includes('-p')) {
      args.unshift('-p');
    }
    if (effectiveMode === 'headless') {
      if (!args.includes('--verbose')) {
        args.push('--verbose');
      }
      args.push('--output-format', 'stream-json');
    } else if (effectiveMode === 'interactive') {
      const pIdx = args.indexOf('-p');
      if (pIdx !== -1) args.splice(pIdx, 1);
    }
  } else {
    if (effectiveMode === 'headless') {
      normalizeCodexHeadlessArgs(args);
    } else if (effectiveMode === 'interactive') {
      stripCodexHeadlessArgs(args);
    }

    if (opts.cwd) {
      const worktreeDirs = resolveWorktreeGitDir(opts.cwd);
      if (worktreeDirs) {
        const execIdx = args.indexOf('exec');
        const insertIdx = execIdx === -1 ? 0 : execIdx;
        const addDirArgs = ['--add-dir', worktreeDirs.gitDir];
        if (worktreeDirs.commonDir) {
          addDirArgs.push('--add-dir', worktreeDirs.commonDir);
        }
        args.splice(insertIdx, 0, ...addDirArgs);
      }
    }
  }

  if (model) {
    if (agent === 'claude') {
      args.push('--model', model);
    } else {
      const execIdx = args.indexOf('exec');
      const insertIdx = execIdx === -1 ? 0 : execIdx;
      args.splice(insertIdx, 0, '-m', model);
    }
  }

  if (agent === 'claude') {
    args.push('--append-system-prompt', promptBody);
  } else {
    args.push(promptBody);
  }

  const messageParts: string[] = [];

  if (frontmatter['append-issue']) {
    if (!opts.repo) {
      throw new Error(`Prompt "${name}" requires opts.repo when append-issue is enabled.`);
    }
    if (opts.issueRef) {
      messageParts.push(await fetchIssue(opts.repo, opts.issueRef));
    }
  }

  if (frontmatter['append-pr']) {
    if (!opts.repo) {
      throw new Error(`Prompt "${name}" requires opts.repo when append-pr is enabled.`);
    }
    if (opts.prRef) {
      messageParts.push(await fetchPR(opts.repo, opts.prRef));
    }
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
    const exitCode = await spawnAsync(agent, args, { cwd: opts.cwd, timeoutMs, logFile });

    if (metaFile && logFile) {
      try {
        await writeSessionMeta(metaFile, {
          repo: repoForSession,
          issue: opts.issueRef ?? 'unlinked',
          stage: name,
          agent,
          model: model ?? 'default',
          timestamp: new Date().toISOString(),
          exitCode,
          logFile,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`Warning: Failed to write session metadata: ${message}`);
      }
    }

    return exitCode;
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
