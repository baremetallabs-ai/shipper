import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, ipcMain } from 'electron';
import {
  acquireIssueLock,
  buildPromptCommand,
  checkGhAuth,
  checkGhInstalled,
  checkLabels,
  executeReset,
  ensureRepoClone,
  getSettings,
  getCurrentStage,
  getStageIndex,
  getStageLabel,
  getValidTargets,
  gh,
  isLockStale,
  listIssues,
  LOCKED_LABEL,
  parseStage,
  PRIORITY_HIGH_LABEL,
  PRIORITY_LOW_LABEL,
  releaseIssueLock,
  renewIssueLock,
  scanArtifacts,
  type ListIssueItem,
  type WorkflowStage,
} from '@dnsquared/shipper-core';

import { PtyManager } from './pty-manager.js';
import { BackgroundManager } from './background-manager.js';

interface AppConfig {
  repos: string[];
  activeRepo: string;
  autoMergeRepos: string[];
}

interface ParseConfigResult {
  config: AppConfig;
  changed: boolean;
}

interface ListIssuesSuccess {
  ok: true;
  issues: Awaited<ReturnType<typeof listIssues>>;
}

interface ListIssuesFailure {
  ok: false;
  error: string;
}

interface SpawnPtyPayload {
  repo: string;
  cols: number;
  rows: number;
}

interface SpawnShipperGroomPayload extends SpawnPtyPayload {
  issueNumber: number;
}

interface AdoptIssuePayload {
  repo: string;
  issueNumber: number;
}

interface SpawnBackgroundCommandPayload {
  repo: string;
}

interface SpawnBackgroundNewPayload extends SpawnBackgroundCommandPayload {
  request: string;
}

interface SpawnBackgroundShipPayload extends SpawnBackgroundCommandPayload {
  issueNumber: number;
  merge: boolean;
}

interface SessionIdPayload {
  sessionId: string;
}

interface ResetIssuePayload extends AdoptIssuePayload {
  targetStage: WorkflowStage;
}

interface ArtifactScanSummary {
  targetStage: WorkflowStage;
  targetLabel: string;
  labelsToRemove: string[];
  addTarget: boolean;
  prs: Array<{ number: number; headRefName: string }>;
  branchesToDelete: string[];
  localBranches: string[];
  localWorktrees: string[];
  commentCount: number;
}

interface RawListIssueData {
  number: number;
  title: string;
  state: string;
  labels: { name: string }[];
  author: { login: string } | null;
  createdAt: string;
}

interface RawResetIssueData {
  number: number;
  state: string;
  labels: { name: string }[];
}

interface RawCreatedIssueData {
  number: number;
  title: string;
  url: string;
  createdAt: string;
}

const defaultConfig: AppConfig = { repos: [], activeRepo: '', autoMergeRepos: [] };
const ptyManager = new PtyManager();
const backgroundManager = new BackgroundManager();
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const preloadPath = fileURLToPath(new URL('../preload/index.cjs', import.meta.url));
const rendererPath = fileURLToPath(new URL('../renderer/index.html', import.meta.url));

function getConfigPath(): string {
  return join(app.getPath('userData'), 'config.json');
}

function readConfig(): AppConfig {
  const configPath = getConfigPath();

  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
    const parsedConfig = parseConfig(parsed);
    if (parsedConfig !== null) {
      if (parsedConfig.changed) {
        writeConfig(parsedConfig.config);
      }

      return parsedConfig.config;
    }

    const legacyRepo =
      typeof parsed === 'object' && parsed !== null && 'repo' in parsed
        ? parseRepo(parsed.repo)
        : null;
    if (legacyRepo !== null) {
      const migratedConfig: AppConfig = {
        repos: [legacyRepo],
        activeRepo: legacyRepo,
        autoMergeRepos: [],
      };
      writeConfig(migratedConfig);
      return migratedConfig;
    }

    return defaultConfig;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return defaultConfig;
    }

    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return defaultConfig;
    }

    throw error;
  }
}

function writeConfig(config: AppConfig): void {
  const configPath = getConfigPath();
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

function parseRepo(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const repo = value.trim();
  return repoPattern.test(repo) ? repo : null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function parseSpawnPtyPayload(value: unknown): SpawnPtyPayload | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('repo' in value) ||
    !('cols' in value) ||
    !('rows' in value)
  ) {
    return null;
  }

  const repo = parseRepo(value.repo);
  if (repo === null || !isPositiveInteger(value.cols) || !isPositiveInteger(value.rows)) {
    return null;
  }

  return {
    repo,
    cols: value.cols,
    rows: value.rows,
  };
}

function parseSpawnShipperGroomPayload(value: unknown): SpawnShipperGroomPayload | null {
  if (typeof value !== 'object' || value === null || !('issueNumber' in value)) {
    return null;
  }

  const payload = parseSpawnPtyPayload(value);
  if (payload === null || !isPositiveInteger(value.issueNumber)) {
    return null;
  }

  return {
    ...payload,
    issueNumber: value.issueNumber,
  };
}

function parseAdoptIssuePayload(value: unknown): AdoptIssuePayload | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('repo' in value) ||
    !('issueNumber' in value)
  ) {
    return null;
  }

  const repo = parseRepo(value.repo);
  if (repo === null || !isPositiveInteger(value.issueNumber)) {
    return null;
  }

  return {
    repo,
    issueNumber: value.issueNumber,
  };
}

function parseSpawnBackgroundCommandPayload(value: unknown): SpawnBackgroundCommandPayload | null {
  if (typeof value !== 'object' || value === null || !('repo' in value)) {
    return null;
  }

  const repo = parseRepo(value.repo);
  if (repo === null) {
    return null;
  }

  return { repo };
}

function parseSpawnBackgroundNewPayload(value: unknown): SpawnBackgroundNewPayload | null {
  if (typeof value !== 'object' || value === null || !('request' in value)) {
    return null;
  }

  const payload = parseSpawnBackgroundCommandPayload(value);
  if (payload === null || typeof value.request !== 'string') {
    return null;
  }

  return {
    ...payload,
    request: value.request,
  };
}

function parseSpawnBackgroundShipPayload(value: unknown): SpawnBackgroundShipPayload | null {
  if (typeof value !== 'object' || value === null || !('issueNumber' in value)) {
    return null;
  }

  const payload = parseSpawnBackgroundCommandPayload(value);
  if (payload === null || !isPositiveInteger(value.issueNumber)) {
    return null;
  }

  return {
    ...payload,
    issueNumber: value.issueNumber,
    merge: 'merge' in value && typeof value.merge === 'boolean' ? value.merge : false,
  };
}

function parseSessionIdPayload(value: unknown): SessionIdPayload | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('sessionId' in value) ||
    typeof value.sessionId !== 'string'
  ) {
    return null;
  }

  return {
    sessionId: value.sessionId,
  };
}

function parseResetIssuePayload(value: unknown): ResetIssuePayload | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('repo' in value) ||
    !('issueNumber' in value) ||
    !('targetStage' in value)
  ) {
    return null;
  }

  const repo = parseRepo(value.repo);
  const targetStage = typeof value.targetStage === 'string' ? parseStage(value.targetStage) : null;
  if (repo === null || !isPositiveInteger(value.issueNumber) || targetStage === null) {
    return null;
  }

  return {
    repo,
    issueNumber: value.issueNumber,
    targetStage,
  };
}

function parseRepoPayload(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('repo' in value)) {
    return null;
  }

  return parseRepo(value.repo);
}

function parseIssueListJson(repo: string, json: string): RawListIssueData[] {
  try {
    return JSON.parse(json) as RawListIssueData[];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const preview = json.length > 200 ? `${json.slice(0, 200)}…` : json;
    throw new Error(`Failed to list adoptable issues for ${repo}: ${message}. Output: ${preview}`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readConfiguredAgentFromSettings(
  filepath: string
): 'claude' | 'codex' | 'copilot' | undefined {
  try {
    const data = JSON.parse(readFileSync(filepath, 'utf8')) as Record<string, unknown>;
    const commands = isPlainObject(data.commands) ? data.commands : undefined;
    const commandDefault = isPlainObject(commands?.default) ? commands.default : undefined;
    const agents = isPlainObject(data.agents) ? data.agents : undefined;

    const configuredAgent =
      typeof commandDefault?.agent === 'string'
        ? commandDefault.agent
        : typeof agents?.default === 'string'
          ? agents.default
          : typeof data.agent === 'string'
            ? data.agent
            : undefined;

    return configuredAgent === 'claude' ||
      configuredAgent === 'codex' ||
      configuredAgent === 'copilot'
      ? configuredAgent
      : undefined;
  } catch {
    // Missing or malformed settings file — fall through to default.
    return undefined;
  }
}

function resolveInitAgent(repoPath: string): 'claude' | 'codex' | 'copilot' {
  const localAgent = readConfiguredAgentFromSettings(
    join(repoPath, '.shipper', 'settings.local.json')
  );
  if (localAgent) {
    return localAgent;
  }

  const storedAgent = readConfiguredAgentFromSettings(join(repoPath, '.shipper', 'settings.json'));
  return storedAgent ?? 'claude';
}

function getRepoSlug(repo: string): string {
  return repo.replaceAll('/', '-');
}

function createDesktopNewLogFile(repo: string): string {
  const sessionsDir = join(app.getPath('home'), '.shipper', 'sessions', getRepoSlug(repo));
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  return join(sessionsDir, `desktop-${randomUUID()}.jsonl`);
}

function parseCreatedIssueList(repo: string, json: string): RawCreatedIssueData[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error('GitHub CLI returned an invalid issue list.');
    }

    return parsed.map((entry) => {
      if (
        !isPlainObject(entry) ||
        typeof entry.number !== 'number' ||
        typeof entry.title !== 'string' ||
        typeof entry.url !== 'string' ||
        typeof entry.createdAt !== 'string'
      ) {
        throw new Error('GitHub CLI returned an invalid created issue payload.');
      }

      return {
        number: entry.number,
        title: entry.title,
        url: entry.url,
        createdAt: entry.createdAt,
      };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse created issue metadata for ${repo}: ${message}`);
  }
}

async function resolveCreatedIssueMeta(
  repo: string,
  spawnedAt: number | null
): Promise<{ issueNumber?: number; issueUrl?: string }> {
  if (spawnedAt === null) {
    return {};
  }

  try {
    const result = await gh([
      'issue',
      'list',
      '-R',
      repo,
      '--label',
      'shipper:new',
      '--state',
      'open',
      '--json',
      'number,title,url,createdAt',
      '--limit',
      '20',
    ]);
    const issues = parseCreatedIssueList(repo, result.stdout);
    const spawnedAtIso = new Date(spawnedAt).toISOString();
    const match = issues
      .filter((issue) => issue.createdAt >= spawnedAtIso)
      .sort((left, right) => right.number - left.number)[0];

    return match ? { issueNumber: match.number, issueUrl: match.url } : {};
  } catch {
    console.warn(`[shipper] Failed to find matching created issue for ${repo}`);
    return {};
  }
}

function parseResetIssueJson(repo: string, issueNumber: number, json: string): RawResetIssueData {
  try {
    const parsed: unknown = JSON.parse(json);
    if (
      !isPlainObject(parsed) ||
      typeof parsed.number !== 'number' ||
      typeof parsed.state !== 'string' ||
      !Array.isArray(parsed.labels)
    ) {
      throw new Error('GitHub CLI returned an invalid issue payload.');
    }

    return {
      number: parsed.number,
      state: parsed.state,
      labels: parsed.labels.map((label) => {
        if (!isPlainObject(label) || typeof label.name !== 'string') {
          throw new Error('GitHub CLI returned an invalid issue label.');
        }

        return { name: label.name };
      }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to fetch reset data for issue #${issueNumber} in ${repo}: ${message}`);
  }
}

function getRepoName(repo: string): string {
  const repoName = repo.split('/')[1];
  if (!repoName) {
    throw new Error(`Invalid repository name: ${repo}`);
  }

  return repoName;
}

async function loadResetIssue(repo: string, issueNumber: number): Promise<RawResetIssueData> {
  const result = await gh([
    'issue',
    'view',
    String(issueNumber),
    '-R',
    repo,
    '--json',
    'number,state,labels',
  ]);

  return parseResetIssueJson(repo, issueNumber, result.stdout);
}

async function getResetValidationError(
  repo: string,
  issue: RawResetIssueData,
  targetStage: WorkflowStage
): Promise<string | null> {
  const labels = issue.labels.map((label) => label.name);

  if (labels.includes(LOCKED_LABEL) && !(await isLockStale(repo, String(issue.number)))) {
    return `Issue #${issue.number} is locked by another shipper instance. Reset is unavailable until that run finishes.`;
  }

  const currentStage = getCurrentStage(labels);
  const validTargets = getValidTargets(currentStage);
  if (validTargets.includes(targetStage)) {
    return null;
  }

  const currentIndex = getStageIndex(currentStage.stage);
  const targetIndex = getStageIndex(targetStage);
  const sameImplementedStage = currentStage.hasPrLabels && targetStage === 'implemented';

  if (targetIndex === currentIndex && !sameImplementedStage) {
    return `Issue #${issue.number} is already at ${getStageLabel(targetStage)}. Reset only works backward.`;
  }

  if (targetIndex > currentIndex) {
    return `${getStageLabel(targetStage)} is ahead of the current stage ${getStageLabel(currentStage.stage)}. Reset only works backward.`;
  }

  return `Issue #${issue.number} cannot be reset to ${getStageLabel(targetStage)}.`;
}

function toArtifactScanSummary(
  scan: Awaited<ReturnType<typeof scanArtifacts>>
): ArtifactScanSummary {
  return {
    targetStage: scan.targetStage,
    targetLabel: scan.targetLabel,
    labelsToRemove: scan.labelsToRemove,
    addTarget: scan.addTarget,
    prs: scan.prs.map((pr) => ({
      number: pr.number,
      headRefName: pr.headRefName,
    })),
    branchesToDelete: scan.branchesToDelete,
    localBranches: scan.localBranches,
    localWorktrees: scan.localWorktrees,
    commentCount: scan.commentIds.length,
  };
}

function toRepoKey(repo: string): string {
  return repo.trim().toLowerCase();
}

function parseConfig(value: unknown): ParseConfigResult | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('repos' in value) ||
    !Array.isArray(value.repos) ||
    !('activeRepo' in value)
  ) {
    return null;
  }

  const repos: string[] = [];
  const seenRepos = new Set<string>();
  let changed = false;

  for (const repo of value.repos) {
    const parsedRepo = parseRepo(repo);
    if (parsedRepo === null) {
      return null;
    }

    if (repo !== parsedRepo) {
      changed = true;
    }

    const repoKey = toRepoKey(parsedRepo);
    if (seenRepos.has(repoKey)) {
      changed = true;
      continue;
    }

    seenRepos.add(repoKey);
    repos.push(parsedRepo);
  }

  const repoByKey = new Map(repos.map((repo) => [toRepoKey(repo), repo]));

  if (typeof value.activeRepo !== 'string') {
    return null;
  }

  if (repos.length === 0) {
    const hasAutoMergeRepos =
      'autoMergeRepos' in value &&
      Array.isArray(value.autoMergeRepos) &&
      value.autoMergeRepos.length > 0;
    return {
      config: { repos, activeRepo: '', autoMergeRepos: [] },
      changed:
        changed ||
        value.activeRepo.trim().length > 0 ||
        !('autoMergeRepos' in value) ||
        !Array.isArray(value.autoMergeRepos) ||
        hasAutoMergeRepos,
    };
  }

  const fallbackActiveRepo = repos[0];
  if (fallbackActiveRepo === undefined) {
    return {
      config: { repos: [], activeRepo: '', autoMergeRepos: [] },
      changed: true,
    };
  }

  const autoMergeRepos: string[] = [];
  const seenAutoMergeRepos = new Set<string>();
  const rawAutoMergeRepos =
    'autoMergeRepos' in value && Array.isArray(value.autoMergeRepos) ? value.autoMergeRepos : null;

  if (rawAutoMergeRepos === null) {
    changed = true;
  } else {
    for (const repo of rawAutoMergeRepos) {
      const parsedRepo = parseRepo(repo);
      if (parsedRepo === null) {
        changed = true;
        continue;
      }

      if (repo !== parsedRepo) {
        changed = true;
      }

      const repoKey = toRepoKey(parsedRepo);
      const matchingRepo = repoByKey.get(repoKey);
      if (matchingRepo === undefined) {
        changed = true;
        continue;
      }

      if (seenAutoMergeRepos.has(repoKey)) {
        changed = true;
        continue;
      }

      seenAutoMergeRepos.add(repoKey);
      if (matchingRepo !== parsedRepo) {
        changed = true;
      }
      autoMergeRepos.push(matchingRepo);
    }
  }

  const parsedActiveRepo = parseRepo(value.activeRepo);
  if (parsedActiveRepo === null) {
    return {
      config: { repos, activeRepo: fallbackActiveRepo, autoMergeRepos },
      changed: true,
    };
  }

  const matchingActiveRepo = repos.find((repo) => toRepoKey(repo) === toRepoKey(parsedActiveRepo));
  if (matchingActiveRepo === undefined) {
    return {
      config: { repos, activeRepo: fallbackActiveRepo, autoMergeRepos },
      changed: true,
    };
  }

  return {
    config: { repos, activeRepo: matchingActiveRepo, autoMergeRepos },
    changed: changed || value.activeRepo !== matchingActiveRepo,
  };
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
    },
  });

  ptyManager.setWindow(window);
  backgroundManager.setWindow(window);

  window.on('close', () => {
    ptyManager.destroyAll();
    backgroundManager.destroyAll();
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    void window.loadURL(rendererUrl);
  } else {
    void window.loadFile(rendererPath);
  }

  return window;
}

function registerIpcHandlers(): void {
  ipcMain.handle('check-prerequisites', async () => {
    const ghInstalled = await checkGhInstalled();
    const ghAuth = ghInstalled.ok ? await checkGhAuth() : { ok: false, message: '' };
    return { ghInstalled, ghAuth };
  });

  ipcMain.handle('check-init', async (_event, payload: unknown) => {
    const repo = parseRepoPayload(payload);
    if (repo === null) {
      return { initialized: false, error: 'Invalid repo payload.' };
    }

    try {
      const result = await checkLabels(repo);
      if (!result.ok && result.message.startsWith('Could not check')) {
        return { initialized: false, error: result.message };
      }
      return { initialized: result.ok };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { initialized: false, error: message };
    }
  });

  ipcMain.handle('list-issues', async (_event, payload: unknown) => {
    const repo = parseRepoPayload(payload);

    if (repo === null) {
      const response: ListIssuesFailure = {
        ok: false,
        error: 'Enter a repository in owner/repo format.',
      };
      return response;
    }

    try {
      const issues = await listIssues(repo);
      const response: ListIssuesSuccess = { ok: true, issues };
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const response: ListIssuesFailure = { ok: false, error: message };
      return response;
    }
  });

  ipcMain.handle('list-adoptable-issues', async (_event, payload: unknown) => {
    const repo = parseRepoPayload(payload);

    if (repo === null) {
      const response: ListIssuesFailure = {
        ok: false,
        error: 'Enter a repository in owner/repo format.',
      };
      return response;
    }

    try {
      const result = await gh([
        'issue',
        'list',
        '-R',
        repo,
        '--state',
        'open',
        '--limit',
        '1000',
        '--json',
        'number,title,labels,state,author,createdAt',
      ]);
      const rawIssues = parseIssueListJson(repo, result.stdout);
      const issues: ListIssueItem[] = rawIssues
        .map((issue) => ({
          number: issue.number,
          title: issue.title,
          labels: issue.labels.map((label) => label.name),
          state: issue.state,
          author: issue.author?.login ?? 'ghost',
          createdAt: issue.createdAt,
        }))
        .filter((issue) => !issue.labels.some((label) => label.startsWith('shipper:')));
      const response: ListIssuesSuccess = { ok: true, issues };
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const response: ListIssuesFailure = { ok: false, error: message };
      return response;
    }
  });

  ipcMain.handle('scan-reset', async (_event, payload: unknown) => {
    const parsedPayload = parseResetIssuePayload(payload);
    if (parsedPayload === null) {
      return {
        ok: false,
        error:
          'Enter a repository in owner/repo format, a positive issue number, and a valid reset stage.',
      };
    }

    try {
      const issue = await loadResetIssue(parsedPayload.repo, parsedPayload.issueNumber);
      if (issue.state !== 'OPEN') {
        return {
          ok: false,
          error: `Issue #${parsedPayload.issueNumber} is closed. Reset only works on open issues.`,
        };
      }

      const validationError = await getResetValidationError(
        parsedPayload.repo,
        issue,
        parsedPayload.targetStage
      );
      if (validationError !== null) {
        return { ok: false, error: validationError };
      }

      const scan = await scanArtifacts(
        parsedPayload.issueNumber,
        parsedPayload.repo,
        parsedPayload.targetStage,
        issue.labels.map((label) => label.name),
        { repoName: getRepoName(parsedPayload.repo) }
      );

      return {
        ok: true,
        scan: toArtifactScanSummary(scan),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  });

  ipcMain.handle('execute-reset', async (_event, payload: unknown) => {
    const parsedPayload = parseResetIssuePayload(payload);
    if (parsedPayload === null) {
      return {
        ok: false,
        error:
          'Enter a repository in owner/repo format, a positive issue number, and a valid reset stage.',
      };
    }

    try {
      const issue = await loadResetIssue(parsedPayload.repo, parsedPayload.issueNumber);
      if (issue.state !== 'OPEN') {
        return {
          ok: false,
          error: `Issue #${parsedPayload.issueNumber} is closed. Reset only works on open issues.`,
        };
      }

      const validationError = await getResetValidationError(
        parsedPayload.repo,
        issue,
        parsedPayload.targetStage
      );
      if (validationError !== null) {
        return { ok: false, error: validationError };
      }

      const issueNumber = String(parsedPayload.issueNumber);
      await acquireIssueLock(parsedPayload.repo, issueNumber);

      try {
        const scan = await scanArtifacts(
          parsedPayload.issueNumber,
          parsedPayload.repo,
          parsedPayload.targetStage,
          issue.labels.map((label) => label.name),
          { repoName: getRepoName(parsedPayload.repo) }
        );

        await executeReset(parsedPayload.issueNumber, scan, parsedPayload.repo);
        return { ok: true };
      } finally {
        await releaseIssueLock(parsedPayload.repo, issueNumber);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  });

  ipcMain.handle('check-lock-stale', async (_event, payload: unknown) => {
    try {
      const parsedPayload = parseAdoptIssuePayload(payload);
      if (parsedPayload === null) {
        return { stale: false };
      }

      const stale = await isLockStale(parsedPayload.repo, String(parsedPayload.issueNumber));
      return { stale };
    } catch {
      console.warn('[shipper] Failed to check lock staleness');
      return { stale: false };
    }
  });

  ipcMain.handle('unlock-issue', async (_event, payload: unknown) => {
    const parsedPayload = parseAdoptIssuePayload(payload);
    if (parsedPayload === null) {
      return {
        ok: false,
        error: 'Enter a repository in owner/repo format and a positive issue number.',
      };
    }

    try {
      await gh([
        'issue',
        'edit',
        String(parsedPayload.issueNumber),
        '-R',
        parsedPayload.repo,
        '--remove-label',
        LOCKED_LABEL,
      ]);

      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  });

  ipcMain.handle('close-not-planned', async (_event, payload: unknown) => {
    const parsedPayload = parseAdoptIssuePayload(payload);
    if (parsedPayload === null) {
      return {
        ok: false,
        error: 'Enter a repository in owner/repo format and a positive issue number.',
      };
    }

    try {
      const issue = await loadResetIssue(parsedPayload.repo, parsedPayload.issueNumber);
      if (issue.state !== 'OPEN') {
        return {
          ok: false,
          error: `Issue #${issue.number} is already closed.`,
        };
      }

      if (issue.labels.some((label) => label.name === LOCKED_LABEL)) {
        return {
          ok: false,
          error: `Issue #${issue.number} is locked. Close as not planned is unavailable until that run finishes.`,
        };
      }

      await gh([
        'issue',
        'close',
        String(issue.number),
        '-R',
        parsedPayload.repo,
        '--reason',
        'not planned',
      ]);

      const shipperLabels = issue.labels
        .map((label) => label.name)
        .filter((label) => label.startsWith('shipper:'));
      if (shipperLabels.length > 0) {
        await gh([
          'issue',
          'edit',
          String(issue.number),
          '-R',
          parsedPayload.repo,
          '--remove-label',
          shipperLabels.join(','),
        ]);
      }

      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  });

  ipcMain.handle('set-priority', async (_event, payload: unknown) => {
    const parsedPayload = parseAdoptIssuePayload(payload);
    if (parsedPayload === null) {
      return {
        ok: false,
        error: 'Enter a repository in owner/repo format and a positive issue number.',
      };
    }

    const level =
      typeof payload === 'object' && payload !== null && 'level' in payload ? payload.level : null;
    if (level !== 'high' && level !== 'normal' && level !== 'low') {
      return { ok: false, error: 'Invalid priority level.' };
    }

    try {
      const args = ['issue', 'edit', String(parsedPayload.issueNumber), '-R', parsedPayload.repo];
      if (level === 'high') {
        args.push('--add-label', PRIORITY_HIGH_LABEL, '--remove-label', PRIORITY_LOW_LABEL);
      } else if (level === 'low') {
        args.push('--add-label', PRIORITY_LOW_LABEL, '--remove-label', PRIORITY_HIGH_LABEL);
      } else {
        args.push('--remove-label', PRIORITY_HIGH_LABEL, '--remove-label', PRIORITY_LOW_LABEL);
      }

      await gh(args);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  });

  ipcMain.handle('get-config', () => readConfig());
  ipcMain.handle('list-repos', async () => {
    const result = await gh(['repo', 'list', '--json', 'nameWithOwner', '--limit', '100']);
    const parsed = JSON.parse(result.stdout) as Array<{ nameWithOwner: string }>;
    return parsed.map((repo) => repo.nameWithOwner);
  });
  ipcMain.handle('set-config', (_event, config: unknown) => {
    const parsedConfig = parseConfig(config);
    if (parsedConfig === null) {
      throw new Error('Invalid config payload.');
    }

    writeConfig(parsedConfig.config);
  });

  ipcMain.handle('pty-spawn-shipper-groom', async (_event, payload: unknown) => {
    const parsedPayload = parseSpawnShipperGroomPayload(payload);
    if (parsedPayload === null) {
      throw new Error('Invalid pty-spawn-shipper-groom payload.');
    }

    const issueNumber = String(parsedPayload.issueNumber);
    await acquireIssueLock(parsedPayload.repo, issueNumber);
    const heartbeatCancelled = { value: false };
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let lockReleased = false;

    const releaseLock = async (): Promise<void> => {
      if (lockReleased) {
        return;
      }

      lockReleased = true;
      heartbeatCancelled.value = true;
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      await releaseIssueLock(parsedPayload.repo, issueNumber);
    };

    try {
      const repoPath = await ensureRepoClone(parsedPayload.repo);

      const cmd = await buildPromptCommand('groom', {
        issueRef: issueNumber,
        repo: parsedPayload.repo,
        cwd: repoPath,
        mode: 'interactive',
      });

      const heartbeatMs = (getSettings().lockTimeoutMinutes / 3) * 60_000;
      heartbeatTimer = setInterval(() => {
        void renewIssueLock(parsedPayload.repo, issueNumber, heartbeatCancelled);
      }, heartbeatMs);

      const sessionId = randomUUID();
      ptyManager.spawn(sessionId, cmd.command, cmd.args, {
        cols: parsedPayload.cols,
        rows: parsedPayload.rows,
        cwd: cmd.cwd ?? repoPath,
        initialInput: cmd.initialInput,
      });
      ptyManager.onSessionExit(sessionId, () => {
        void releaseLock();
      });

      return { sessionId };
    } catch (error) {
      await releaseLock();
      throw error;
    }
  });

  ipcMain.handle('bg-spawn-new', async (_event, payload: unknown) => {
    const parsedPayload = parseSpawnBackgroundNewPayload(payload);
    if (parsedPayload === null) {
      throw new Error('Invalid bg-spawn-new payload.');
    }

    const repoPath = await ensureRepoClone(parsedPayload.repo);
    const logFile = createDesktopNewLogFile(parsedPayload.repo);
    const sessionId = randomUUID();

    return backgroundManager.spawn({
      sessionId,
      command: 'new',
      repo: parsedPayload.repo,
      commandName: 'shipper',
      args: ['new', parsedPayload.request, '--mode', 'headless', '--log-file', logFile],
      cwd: repoPath,
      logFile,
      meta: {
        request: parsedPayload.request,
        logFile,
      },
      onComplete: async (session) => resolveCreatedIssueMeta(parsedPayload.repo, session.spawnedAt),
    });
  });

  ipcMain.handle('bg-spawn-ship', async (_event, payload: unknown) => {
    const parsedPayload = parseSpawnBackgroundShipPayload(payload);
    if (parsedPayload === null) {
      throw new Error('Invalid bg-spawn-ship payload.');
    }

    const repoPath = await ensureRepoClone(parsedPayload.repo);
    const sessionId = randomUUID();
    const args = ['ship', String(parsedPayload.issueNumber), '--mode', 'headless'];
    if (parsedPayload.merge) {
      args.push('--merge');
    }

    return backgroundManager.spawn({
      sessionId,
      command: 'ship',
      repo: parsedPayload.repo,
      commandName: 'shipper',
      args,
      cwd: repoPath,
      meta: {
        issueNumber: parsedPayload.issueNumber,
        merge: parsedPayload.merge,
      },
    });
  });

  ipcMain.handle('bg-spawn-init', async (_event, payload: unknown) => {
    const parsedPayload = parseSpawnBackgroundCommandPayload(payload);
    if (parsedPayload === null) {
      throw new Error('Invalid bg-spawn-init payload.');
    }

    const repoPath = await ensureRepoClone(parsedPayload.repo);
    const agent = resolveInitAgent(repoPath);
    const sessionId = randomUUID();

    return backgroundManager.spawn({
      sessionId,
      command: 'init',
      repo: parsedPayload.repo,
      commandName: 'shipper',
      args: ['init', '--agent', agent],
      cwd: repoPath,
    });
  });

  ipcMain.handle('bg-spawn-unblock', async (_event, payload: unknown) => {
    const parsedPayload = parseAdoptIssuePayload(payload);
    if (parsedPayload === null) {
      throw new Error('Invalid bg-spawn-unblock payload.');
    }

    const repoPath = await ensureRepoClone(parsedPayload.repo);
    const sessionId = randomUUID();

    return backgroundManager.spawn({
      sessionId,
      command: 'unblock',
      repo: parsedPayload.repo,
      commandName: 'shipper',
      args: ['unblock', String(parsedPayload.issueNumber), '--mode', 'headless'],
      cwd: repoPath,
      meta: { issueNumber: parsedPayload.issueNumber },
    });
  });

  ipcMain.handle('bg-kill', (_event, payload: unknown) => {
    const parsedPayload = parseSessionIdPayload(payload);
    if (parsedPayload === null) {
      throw new Error('Invalid bg-kill payload.');
    }

    backgroundManager.kill(parsedPayload.sessionId);
  });

  ipcMain.handle('bg-get-output', (_event, payload: unknown) => {
    const parsedPayload = parseSessionIdPayload(payload);
    if (parsedPayload === null) {
      throw new Error('Invalid bg-get-output payload.');
    }

    return backgroundManager.getOutput(parsedPayload.sessionId);
  });

  ipcMain.handle('adopt-issue', async (_event, payload: unknown) => {
    const parsedPayload = parseAdoptIssuePayload(payload);
    if (parsedPayload === null) {
      return {
        ok: false,
        error: 'Enter a repository in owner/repo format and a positive issue number.',
      };
    }

    try {
      await gh([
        'issue',
        'edit',
        String(parsedPayload.issueNumber),
        '-R',
        parsedPayload.repo,
        '--add-label',
        'shipper:new',
      ]);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  });

  ipcMain.handle('pty-write', (_event, payload: unknown) => {
    if (
      typeof payload !== 'object' ||
      payload === null ||
      !('sessionId' in payload) ||
      typeof payload.sessionId !== 'string' ||
      !('data' in payload) ||
      typeof payload.data !== 'string'
    ) {
      throw new Error('Invalid pty-write payload.');
    }

    ptyManager.write(payload.sessionId, payload.data);
  });

  ipcMain.handle('pty-resize', (_event, payload: unknown) => {
    if (
      typeof payload !== 'object' ||
      payload === null ||
      !('sessionId' in payload) ||
      typeof payload.sessionId !== 'string' ||
      !('cols' in payload) ||
      typeof payload.cols !== 'number' ||
      !('rows' in payload) ||
      typeof payload.rows !== 'number'
    ) {
      throw new Error('Invalid pty-resize payload.');
    }

    ptyManager.resize(payload.sessionId, payload.cols, payload.rows);
  });

  ipcMain.handle('pty-kill', (_event, payload: unknown) => {
    if (
      typeof payload !== 'object' ||
      payload === null ||
      !('sessionId' in payload) ||
      typeof payload.sessionId !== 'string'
    ) {
      throw new Error('Invalid pty-kill payload.');
    }

    ptyManager.kill(payload.sessionId);
  });
}

void app.whenReady().then(() => {
  registerIpcHandlers();

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
