import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Settings } from '../../src/lib/settings.js';
import { vi } from 'vitest';

type EnvMap = Record<string, string | undefined>;

interface RunGitOptions {
  env?: EnvMap;
}

interface GitClone {
  cloneDir: string;
  cleanup: () => void;
}

function buildCleanEnv(extraEnv?: EnvMap): EnvMap {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith('GIT_') && key !== 'SHIPPER_ORIGINAL_PRE_PUSH'
      )
    ),
    ...extraEnv,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function execGit(cwd: string, args: string[], opts?: RunGitOptions): string {
  return execFileSync('git', args, {
    cwd,
    env: buildCleanEnv(opts?.env),
    stdio: 'pipe',
    encoding: 'utf8',
  });
}

function ensureDir(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeExecutable(filePath: string, content: string): void {
  ensureDir(filePath);
  writeFileSync(filePath, content);
  chmodSync(filePath, 0o755);
}

function configureUser(cwd: string): void {
  execGit(cwd, ['config', 'user.name', 'Test User']);
  execGit(cwd, ['config', 'user.email', 'test@example.com']);
}

export interface GitFixture {
  tempDir: string;
  remoteDir: string;
  repoDir: string;
  worktreeDir: string;
  branchName: string;
  runGit: (cwd: string, args: string[], opts?: RunGitOptions) => string;
  readFile: (cwd: string, relativePath: string) => string;
  writeFile: (cwd: string, relativePath: string, content: string) => void;
  appendFile: (cwd: string, relativePath: string, content: string) => void;
  commitAll: (cwd: string, message: string) => string;
  commitFile: (cwd: string, relativePath: string, content: string, message: string) => string;
  currentHead: (cwd: string) => string;
  currentBranch: (cwd: string) => string;
  createRemoteClone: (name: string) => GitClone;
  writeRelativePrePushHook: (content: string, hooksPath?: string) => string;
  writeRemotePreReceiveHook: (content: string) => string;
  writeSettings: (settings?: Partial<Settings>) => void;
  importWorktreeModule: (
    settings?: Partial<Settings>
  ) => Promise<typeof import('../../src/lib/worktree.js')>;
  cleanup: () => void;
}

export function sh(value: string): string {
  return shellQuote(value);
}

export function createGitFixture(name: string, branchName = 'feature'): GitFixture {
  const tempDir = mkdtempSync(path.join(tmpdir(), `shipper-${name}-`));

  const remoteDir = path.join(tempDir, 'remote.git');
  const repoDir = path.join(tempDir, 'repo');
  const worktreeDir = path.join(tempDir, 'worktree');

  execGit(tempDir, ['init', '--bare', remoteDir]);
  mkdirSync(repoDir, { recursive: true });
  execGit(tempDir, ['init', '--initial-branch=main', repoDir]);
  configureUser(repoDir);
  writeFileSync(path.join(repoDir, 'README.md'), '# fixture\n');
  execGit(repoDir, ['add', 'README.md']);
  execGit(repoDir, ['commit', '-m', 'init']);
  execGit(repoDir, ['remote', 'add', 'origin', remoteDir]);
  execGit(repoDir, ['push', '-u', 'origin', 'main']);
  execGit(remoteDir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  execGit(repoDir, ['worktree', 'add', '-b', branchName, worktreeDir]);
  configureUser(worktreeDir);

  const readFile = (cwd: string, relativePath: string): string =>
    readFileSync(path.join(cwd, relativePath), 'utf8');
  const writeFile = (cwd: string, relativePath: string, content: string): void => {
    const filePath = path.join(cwd, relativePath);
    ensureDir(filePath);
    writeFileSync(filePath, content);
  };
  const appendFile = (cwd: string, relativePath: string, content: string): void => {
    const filePath = path.join(cwd, relativePath);
    ensureDir(filePath);
    appendFileSync(filePath, content);
  };
  const commitAll = (cwd: string, message: string): string => {
    execGit(cwd, ['add', '-A']);
    execGit(cwd, ['commit', '-m', message]);
    return execGit(cwd, ['rev-parse', 'HEAD']).trim();
  };
  const commitFile = (
    cwd: string,
    relativePath: string,
    content: string,
    message: string
  ): string => {
    writeFile(cwd, relativePath, content);
    execGit(cwd, ['add', relativePath]);
    execGit(cwd, ['commit', '-m', message]);
    return execGit(cwd, ['rev-parse', 'HEAD']).trim();
  };
  const currentHead = (cwd: string): string => execGit(cwd, ['rev-parse', 'HEAD']).trim();
  const currentBranch = (cwd: string): string =>
    execGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const createRemoteClone = (cloneName: string): GitClone => {
    const cloneDir = path.join(tempDir, cloneName);
    execGit(tempDir, ['clone', remoteDir, cloneDir]);
    configureUser(cloneDir);
    return {
      cloneDir,
      cleanup: () => {
        rmSync(cloneDir, { recursive: true, force: true });
      },
    };
  };
  const writeRelativePrePushHook = (content: string, hooksPath = '.husky'): string => {
    execGit(repoDir, ['config', 'core.hooksPath', hooksPath]);
    const hookPath = path.join(repoDir, hooksPath, 'pre-push');
    writeExecutable(hookPath, content);
    return hookPath;
  };
  const writeRemotePreReceiveHook = (content: string): string => {
    const hookPath = path.join(remoteDir, 'hooks', 'pre-receive');
    writeExecutable(hookPath, content);
    return hookPath;
  };
  const writeSettings = (settings?: Partial<Settings>): void => {
    const shipperDir = path.join(repoDir, '.shipper');
    mkdirSync(shipperDir, { recursive: true });
    const settingsPath = path.join(shipperDir, 'settings.json');
    const localPath = path.join(shipperDir, 'settings.local.json');
    rmSync(localPath, { force: true });
    if (!settings) {
      rmSync(settingsPath, { force: true });
      return;
    }
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  };
  const importWorktreeModule = async (
    settings?: Partial<Settings>
  ): Promise<typeof import('../../src/lib/worktree.js')> => {
    writeSettings(settings);
    const previousCwd = process.cwd();
    process.chdir(repoDir);
    try {
      vi.resetModules();
      const settingsModule = await import('../../src/lib/settings.js');
      await settingsModule.loadSettings();
      return await import('../../src/lib/worktree.js');
    } finally {
      process.chdir(previousCwd);
    }
  };
  const cleanup = (): void => {
    rmSync(tempDir, { recursive: true, force: true });
  };

  return {
    tempDir,
    remoteDir,
    repoDir,
    worktreeDir,
    branchName,
    runGit: execGit,
    readFile,
    writeFile,
    appendFile,
    commitAll,
    commitFile,
    currentHead,
    currentBranch,
    createRemoteClone,
    writeRelativePrePushHook,
    writeRemotePreReceiveHook,
    writeSettings,
    importWorktreeModule,
    cleanup,
  };
}

export function hasPath(cwd: string, relativePath: string): boolean {
  return existsSync(path.join(cwd, relativePath));
}
