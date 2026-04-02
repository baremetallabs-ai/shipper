import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, readFileSync, statSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { toError, toErrorMessage } from './errors.js';
import { parseFrontmatter } from './frontmatter.js';
import { fetchIssue, fetchPR } from './github.js';
import { agentPrompts } from './prompts.js';
import {
  PROTOCOL_INPUT_DISPLAY_DIR,
  TRUNCATION_THRESHOLD_BYTES,
  writeContextFile,
} from './output-protocol/protocol-io.js';
import { getSessionPaths, resolveSessionRepo, writeSessionMeta } from './session.js';
import {
  getSettings,
  resolveAgent,
  resolveModel,
  resolveMode,
  type AgentName,
  type CommandMode,
} from './settings.js';
import { logger } from './logger.js';
import { formatUsageLine, parseAgentUsage, type TokenUsage } from './usage.js';

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
  logFile?: string;
}

export interface PromptCommand {
  command: string;
  args: string[];
  cwd?: string;
  initialInput?: string;
}

const CODEX_HEADLESS_CONFIG = 'sandbox_workspace_write.network_access=true';
const CODEX_HEADLESS_JSON_ARG = '--json';
const CODEX_HEADLESS_ARGS = [
  'exec',
  '--full-auto',
  CODEX_HEADLESS_JSON_ARG,
  '-c',
  CODEX_HEADLESS_CONFIG,
] as const;
const COPILOT_HEADLESS_FLAGS = [
  '--autopilot',
  '--allow-all-tools',
  '--allow-all-urls',
  '--no-ask-user',
] as const;
const GH_MUTATION_PATTERNS = [
  /gh\s+issue\s+edit\b/,
  /gh\s+issue\s+comment\b/,
  /gh\s+pr\s+create\b/,
  /gh\s+pr\s+review\b/,
] as const;
const MAX_INPUT_BYTES = 200_000;
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
    // .git doesn't exist or isn't a file — not a worktree.
    return undefined;
  }
  try {
    const content = readFileSync(dotGit, 'utf-8');
    const match = content.match(/^gitdir:\s*(.+)$/m);
    if (!match?.[1]) {
      logger.warn(`Warning: .git file at ${dotGit} has no gitdir: line. Skipping --add-dir.`);
      return undefined;
    }
    const resolved = path.resolve(cwd, match[1].trim());
    try {
      statSync(resolved);
    } catch {
      logger.warn(`Warning: gitdir path ${resolved} does not exist. Skipping --add-dir.`);
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
        logger.warn(
          `Warning: commondir path ${commonDirResolved} does not exist. Skipping common --add-dir.`
        );
      }
    } catch {
      // No commondir file — gitDir is the main repo .git, not a worktree sub-dir
    }

    return { gitDir: resolved, commonDir };
  } catch {
    logger.warn(`Warning: Failed to read .git file at ${dotGit}. Skipping --add-dir.`);
    return undefined;
  }
}

function spawnAsync(
  command: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; logFile?: string; initialInput?: string }
): Promise<number> {
  return new Promise((resolve, reject) => {
    const hasInitialInput = opts.initialInput !== undefined;
    const stdio:
      | 'inherit'
      | ['inherit', 'pipe', 'inherit']
      | ['pipe', 'inherit', 'inherit']
      | ['pipe', 'pipe', 'inherit'] = hasInitialInput
      ? opts.logFile
        ? ['pipe', 'pipe', 'inherit']
        : ['pipe', 'inherit', 'inherit']
      : opts.logFile
        ? ['inherit', 'pipe', 'inherit']
        : 'inherit';
    const child: ChildProcess = spawn(command, args, {
      stdio,
      env: process.env,
      cwd: opts.cwd,
    });
    let logCompletion: Promise<void> | undefined;
    const childStdin = child.stdin;
    let stdinCleanup: (() => void) | undefined;

    if (hasInitialInput) {
      if (!childStdin) {
        reject(new Error(`Failed to capture stdin for ${command}`));
        return;
      }

      childStdin.write(`${opts.initialInput}\n`);
      process.stdin.pipe(childStdin);
      stdinCleanup = () => {
        process.stdin.unpipe(childStdin);
        process.stdin.pause();
      };
    }

    if (opts.logFile) {
      const stdout = child.stdout;
      if (!stdout) {
        reject(new Error(`Failed to capture stdout for ${command}`));
        return;
      }

      try {
        const logStream = createWriteStream(opts.logFile);
        logCompletion = new Promise((logResolve, logReject) => {
          let settled = false;

          const resolveLog = (): void => {
            if (settled) return;
            settled = true;
            logResolve();
          };

          const rejectLog = (err: unknown): void => {
            if (settled) return;
            settled = true;
            stdout.unpipe(logStream);
            stdout.resume();
            logReject(toError(err));
          };

          logStream.on('finish', resolveLog);
          logStream.on('error', rejectLog);
          stdout.on('error', rejectLog);
        });
        stdout.pipe(logStream);
      } catch (err) {
        stdout.resume();
        logger.warn(`Warning: Session log capture failed: ${toErrorMessage(err)}`);
      }
    }

    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      const timeoutMs = opts.timeoutMs;
      killTimer = setTimeout(() => {
        timedOut = true;
        const minutes = Math.round(timeoutMs / 60_000);
        logger.error(`Agent timed out after ${minutes} minutes`);
        child.kill('SIGTERM');
        graceTimer = setTimeout(() => {
          child.kill('SIGKILL');
        }, 10_000);
      }, timeoutMs);
    }

    child.on('error', (err) => {
      clearTimeout(killTimer);
      clearTimeout(graceTimer);
      stdinCleanup?.();
      reject(toError(err));
    });

    const handleClose = async (code: number | null): Promise<void> => {
      clearTimeout(killTimer);
      clearTimeout(graceTimer);
      stdinCleanup?.();
      if (logCompletion) {
        try {
          await logCompletion;
        } catch (err) {
          logger.warn(`Warning: Session log capture failed: ${toErrorMessage(err)}`);
        }
      }
      resolve(timedOut ? code || 1 : (code ?? 1));
    };

    child.on('close', (code) => {
      void handleClose(code);
    });
  });
}

async function resolvePromptCommand(
  name: string,
  opts: RunPromptOpts,
  effectiveMode: CommandMode
): Promise<{ agent: AgentName; args: string[]; promptBody: string }> {
  const agent = resolveAgent(name, opts.agent);
  if (agent === 'copilot') {
    try {
      execFileSync('copilot', ['--version'], { stdio: 'ignore' });
    } catch (err) {
      const error = toError(err) as Error & { code?: string | number };
      if (error.code === 'ENOENT') {
        throw new Error(
          'copilot binary not found on PATH.\n' +
            'Install the GitHub Copilot CLI: https://docs.github.com/copilot/cli'
        );
      }

      throw error;
    }
  }
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
      throw new Error(
        `No prompt found for step "${name}" (agent: ${agent}).\nNo local file at ${promptPath} and no bundled default available.`
      );
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
    logger.warn(
      `Warning: Ejected prompt '${name}' contains gh commands for state mutations.\nThese are now handled by shipper. Re-eject with 'shipper eject ${name}' or manually update.`
    );
  }

  if (frontmatter.cmd !== agent) {
    throw new Error(
      `Agent mismatch for step "${name}". Settings resolve to "${agent}", but prompt frontmatter specifies "cmd: ${frontmatter.cmd}" in ${promptPath}.\nUpdate the prompt file's frontmatter to "cmd: ${agent}", or change commands.${name}.agent in settings.`
    );
  }

  let promptBody = body;
  if (opts.baseBranch) {
    promptBody = promptBody.replaceAll('{{BASE_BRANCH}}', opts.baseBranch);
  }

  const args = [...frontmatter.args];

  switch (agent) {
    case 'claude': {
      if (effectiveMode === 'headless' && !args.includes('-p')) {
        args.unshift('-p');
      }
      if (effectiveMode === 'headless' && !args.includes('--verbose')) {
        args.push('--verbose');
      }
      if (effectiveMode === 'headless' && !args.includes('--output-format')) {
        args.push('--output-format', 'stream-json');
      }
      if (effectiveMode === 'interactive') {
        const pIdx = args.indexOf('-p');
        if (pIdx !== -1) args.splice(pIdx, 1);
      }
      break;
    }
    case 'codex': {
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
      break;
    }
    case 'copilot':
      if (effectiveMode === 'headless') {
        normalizeCopilotHeadlessArgs(args);
      } else {
        stripCopilotHeadlessArgs(args);
      }
      break;
    default: {
      const exhaustiveCheck: never = agent;
      throw new Error(`Unsupported agent: ${String(exhaustiveCheck)}`);
    }
  }

  if (model) {
    if (agent === 'codex') {
      const execIdx = args.indexOf('exec');
      const insertIdx = execIdx === -1 ? 0 : execIdx;
      args.splice(insertIdx, 0, '-m', model);
    } else {
      args.push('--model', model);
    }
  }

  if (agent === 'claude') {
    args.push('--append-system-prompt', promptBody);
  } else if (agent === 'copilot') {
    if (effectiveMode === 'headless') {
      args.push('-p', promptBody);
    }
  } else {
    args.push(promptBody);
  }

  const messageParts: string[] = [];

  if (frontmatter['append-issue']) {
    if (!opts.repo) {
      throw new Error(`Prompt "${name}" requires opts.repo when append-issue is enabled.`);
    }
    if (opts.issueRef) {
      const content = await fetchIssue(opts.repo, opts.issueRef);
      if (Buffer.byteLength(content, 'utf-8') > TRUNCATION_THRESHOLD_BYTES) {
        const cwd = opts.cwd ?? process.cwd();
        const filename = `issue-${opts.issueRef}.md`;
        await writeContextFile(cwd, filename, content);
        messageParts.push(
          `The full issue content has been written to ${PROTOCOL_INPUT_DISPLAY_DIR}/${filename} because it exceeds the inline size limit. Read this file to access the complete issue with all comments.`
        );
      } else {
        messageParts.push(content);
      }
    }
  }

  if (frontmatter['append-pr']) {
    if (!opts.repo) {
      throw new Error(`Prompt "${name}" requires opts.repo when append-pr is enabled.`);
    }
    if (opts.prRef) {
      const content = await fetchPR(opts.repo, opts.prRef);
      if (Buffer.byteLength(content, 'utf-8') > TRUNCATION_THRESHOLD_BYTES) {
        const cwd = opts.cwd ?? process.cwd();
        const filename = `pr-${opts.prRef}.md`;
        await writeContextFile(cwd, filename, content);
        messageParts.push(
          `The full PR content has been written to ${PROTOCOL_INPUT_DISPLAY_DIR}/${filename} because it exceeds the inline size limit. Read this file to access the complete PR with all reviews and comments.`
        );
      } else {
        messageParts.push(content);
      }
    }
  }

  if (frontmatter['append-user-input'] && opts.userInput) {
    messageParts.push(opts.userInput);
  }

  const userMessage = messageParts.join('\n\n---\n\n');
  if (userMessage) {
    if (agent === 'claude') {
      args.push(userMessage);
    } else {
      const promptIdx = args.indexOf(promptBody);
      if (promptIdx !== -1) {
        args[promptIdx] = promptBody + '\n\n---\n\n' + userMessage;
      } else {
        promptBody = promptBody + '\n\n---\n\n' + userMessage;
      }
    }
  }

  const totalBytes =
    args.reduce((sum, arg) => sum + Buffer.byteLength(arg, 'utf-8'), 0) +
    (agent === 'copilot' && effectiveMode !== 'headless'
      ? Buffer.byteLength(promptBody, 'utf-8')
      : 0);
  if (totalBytes > MAX_INPUT_BYTES) {
    throw new Error(
      `Total prompt input size (${totalBytes} bytes) exceeds the ${MAX_INPUT_BYTES}-byte budget. Reduce input size before calling runPrompt.`
    );
  }

  return { agent, args, promptBody };
}

export async function buildPromptCommand(
  name: string,
  opts: RunPromptOpts
): Promise<PromptCommand> {
  const { agent, args, promptBody } = await resolvePromptCommand(name, opts, 'interactive');
  const initialInput = agent === 'copilot' ? promptBody : undefined;
  return { command: agent, args, cwd: opts.cwd, initialInput };
}

export async function runPrompt(name: string, opts: RunPromptOpts): Promise<number> {
  const effectiveMode = resolveMode(name, opts.mode);

  let resolved: Awaited<ReturnType<typeof resolvePromptCommand>>;
  try {
    resolved = await resolvePromptCommand(name, opts, effectiveMode);
  } catch (err) {
    logger.error(`Error: ${toErrorMessage(err)}`);
    return 1;
  }

  const { agent, args } = resolved;
  const timeoutMinutes = getSettings().agentTimeoutMinutes;
  const timeoutMs =
    effectiveMode === 'headless' && timeoutMinutes > 0 ? timeoutMinutes * 60_000 : undefined;
  let sessionRepo: Awaited<ReturnType<typeof resolveSessionRepo>> | undefined;
  let logFile: string | undefined;
  let metaFile: string | undefined;
  let sessionTimestamp: Date | undefined;

  try {
    sessionRepo = await resolveSessionRepo({ repo: opts.repo, cwd: opts.cwd });
    sessionTimestamp = new Date();
    const sessionPaths = getSessionPaths(
      sessionRepo.repoSlug,
      opts.issueRef,
      name,
      sessionTimestamp
    );
    await mkdir(path.dirname(sessionPaths.logFile), { recursive: true });
    logFile = sessionPaths.logFile;
    metaFile = sessionPaths.metaFile;
  } catch (err) {
    sessionRepo = undefined;
    sessionTimestamp = undefined;
    logger.warn(`Warning: Failed to initialize session logging: ${toErrorMessage(err)}`);
  }

  const effectiveModel = getEffectiveModel(agent, args);

  try {
    const trackUsage = canTrackUsage(agent, args);
    if (trackUsage) {
      ensureJsonOutputFormat(agent, args);
    }

    const spawnLogFile =
      opts.logFile ?? (trackUsage || effectiveMode === 'headless' ? logFile : undefined);
    const initialInput =
      agent === 'copilot' && effectiveMode !== 'headless' ? resolved.promptBody : undefined;
    const exitCode = await spawnAsync(agent, args, {
      cwd: opts.cwd,
      timeoutMs,
      logFile: spawnLogFile,
      initialInput,
    });
    let usage: TokenUsage | undefined;

    if (trackUsage && spawnLogFile) {
      try {
        usage = await parseAgentUsage(agent, spawnLogFile);
      } catch {
        logger.warn(`Failed to parse agent usage from ${spawnLogFile}`);
        usage = undefined;
      }

      if (usage) {
        logger.log(formatUsageLine(usage));
      }
    }

    if (metaFile && logFile && sessionTimestamp) {
      try {
        await writeSessionMeta(metaFile, {
          repo: sessionRepo?.repo ?? '_unlinked',
          issue: opts.issueRef ?? 'unlinked',
          stage: name,
          agent,
          model: effectiveModel ?? 'default',
          timestamp: sessionTimestamp.toISOString(),
          exitCode,
          logFile: spawnLogFile,
          usage,
        });
      } catch (err) {
        logger.warn(`Warning: Failed to write session metadata: ${toErrorMessage(err)}`);
      }
    }

    return exitCode;
  } catch (err) {
    logger.error(`Error: Failed to spawn ${agent}: ${toErrorMessage(err)}`);
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

  if (!args.includes(CODEX_HEADLESS_JSON_ARG)) {
    const fullAutoIdx = args.indexOf('--full-auto');
    const insertIdx = fullAutoIdx === -1 ? execIdx + 1 : fullAutoIdx + 1;
    args.splice(insertIdx, 0, CODEX_HEADLESS_JSON_ARG);
  }

  if (findCodexSandboxConfigIndex(args) === -1) {
    const jsonIdx = args.indexOf(CODEX_HEADLESS_JSON_ARG);
    const insertIdx = jsonIdx === -1 ? execIdx + 1 : jsonIdx + 1;
    args.splice(insertIdx, 0, '-c', CODEX_HEADLESS_CONFIG);
  }
}

function stripCodexHeadlessArgs(args: string[]): void {
  const execIdx = args.indexOf('exec');
  if (execIdx !== -1) {
    args.splice(execIdx, 1);
  }

  const jsonIdx = args.indexOf(CODEX_HEADLESS_JSON_ARG);
  if (jsonIdx !== -1) {
    args.splice(jsonIdx, 1);
  }
}

function normalizeCopilotHeadlessArgs(args: string[]): void {
  for (const flag of COPILOT_HEADLESS_FLAGS) {
    if (!args.includes(flag)) {
      args.push(flag);
    }
  }
}

function stripCopilotHeadlessArgs(args: string[]): void {
  for (let i = args.length - 1; i >= 0; i--) {
    if (COPILOT_HEADLESS_FLAGS.includes(args[i] as (typeof COPILOT_HEADLESS_FLAGS)[number])) {
      args.splice(i, 1);
    }
  }

  for (let i = args.length - 1; i >= 0; i--) {
    if (args[i] === '-p' || args[i] === '--prompt') {
      args.splice(i, args[i + 1] === undefined ? 1 : 2);
    }
  }
}

function canTrackUsage(agent: AgentName, args: string[]): boolean {
  switch (agent) {
    case 'claude':
      return args.includes('-p');
    case 'codex':
      return args.includes('exec');
    case 'copilot':
      return false;
    default: {
      const exhaustiveCheck: never = agent;
      throw new Error(`Unsupported agent: ${String(exhaustiveCheck)}`);
    }
  }
}

function ensureJsonOutputFormat(agent: AgentName, args: string[]): void {
  switch (agent) {
    case 'claude': {
      if (!args.includes('--output-format')) {
        const appendSystemPromptIdx = args.indexOf('--append-system-prompt');
        const insertIdx = appendSystemPromptIdx === -1 ? args.length : appendSystemPromptIdx;
        args.splice(insertIdx, 0, '--output-format', 'stream-json');
      }
      // Claude CLI requires --verbose when using --output-format=stream-json with --print
      if (args.includes('-p') && !args.includes('--verbose')) {
        const outputFmtIdx = args.indexOf('--output-format');
        const insertIdx = outputFmtIdx === -1 ? args.length : outputFmtIdx;
        args.splice(insertIdx, 0, '--verbose');
      }
      return;
    }
    case 'codex': {
      if (args.includes(CODEX_HEADLESS_JSON_ARG)) {
        return;
      }

      const execIdx = args.indexOf('exec');
      const insertIdx = execIdx + 1;
      args.splice(insertIdx, 0, CODEX_HEADLESS_JSON_ARG);
      return;
    }
    case 'copilot':
      return;
    default: {
      const exhaustiveCheck: never = agent;
      throw new Error(`Unsupported agent: ${String(exhaustiveCheck)}`);
    }
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

function getEffectiveModel(agent: AgentName, args: string[]): string | undefined {
  const flag = agent === 'codex' ? '-m' : '--model';

  for (let i = args.length - 2; i >= 0; i--) {
    if (args[i] === flag) {
      return args[i + 1];
    }
  }

  return undefined;
}
