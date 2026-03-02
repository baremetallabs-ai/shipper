import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

interface CheckResult {
  ok: boolean;
  message: string;
}

export function checkGhInstalled(): CheckResult {
  try {
    execFileSync('gh', ['--version'], { stdio: 'ignore' });
    return { ok: true, message: 'gh is installed' };
  } catch {
    return {
      ok: false,
      message: 'GitHub CLI (gh) is not installed. Install it from https://cli.github.com/',
    };
  }
}

export function checkGhAuth(): CheckResult {
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' });
    return { ok: true, message: 'gh is authenticated' };
  } catch {
    return { ok: false, message: 'GitHub CLI is not authenticated. Run: gh auth login' };
  }
}

export function checkGitRepo(): CheckResult {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' });
    return { ok: true, message: 'Inside a git repository' };
  } catch {
    return { ok: false, message: 'Not inside a git repository. Run: git init' };
  }
}

export function checkGitHubRemote(): CheckResult {
  try {
    const output = execFileSync('gh', ['repo', 'view', '--json', 'name', '-q', '.name'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (output) {
      return { ok: true, message: `GitHub remote found: ${output}` };
    }
    return {
      ok: false,
      message: 'No GitHub remote found. Add a GitHub remote to this repository.',
    };
  } catch {
    return {
      ok: false,
      message: 'No GitHub remote found. Add a GitHub remote to this repository.',
    };
  }
}

export function checkShipperDir(): CheckResult {
  const shipperDir = path.resolve('.shipper', 'prompts');
  if (existsSync(shipperDir)) {
    return { ok: true, message: '.shipper directory exists' };
  }
  return { ok: false, message: '.shipper directory not found. Run: shipper init' };
}

export function ensureInitialized(): void {
  const check = checkShipperDir();
  if (!check.ok) {
    console.error(`Error: ${check.message}`);
    process.exit(1);
  }
}

export function runPrereqChecks(checks: Array<() => CheckResult>): boolean {
  for (const check of checks) {
    const result = check();
    if (!result.ok) {
      console.error(`Prereq failed: ${result.message}`);
      return false;
    }
  }
  return true;
}
