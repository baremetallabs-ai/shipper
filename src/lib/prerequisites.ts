import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
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
    return { ok: true, message: '.shipper/prompts directory exists' };
  }
  return { ok: false, message: '.shipper/prompts directory not found. Run: shipper init' };
}

const REQUIRED_LABELS = [
  'shipper:new',
  'shipper:groomed',
  'shipper:designed',
  'shipper:planned',
  'shipper:implemented',
  'shipper:pr-open',
  'shipper:ready',
];

export function checkLabels(): CheckResult {
  try {
    const output = execFileSync(
      'gh',
      ['label', 'list', '--search', 'shipper:', '--json', 'name', '-q', '.[].name'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    const existing = output ? output.split(/\r?\n/) : [];
    const missing = REQUIRED_LABELS.filter((l) => !existing.includes(l));
    if (missing.length === 0) {
      return { ok: true, message: 'All required labels exist' };
    }
    return { ok: false, message: `Missing label(s): ${missing.join(', ')}` };
  } catch {
    return { ok: false, message: 'Could not check labels (gh label list failed)' };
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

export function runPreflight(): void {
  const checks = [checkGhInstalled, checkGhAuth, checkShipperDir, checkLabels];

  const failures: string[] = [];
  for (const check of checks) {
    const result = check();
    if (!result.ok) {
      failures.push(result.message);
    }
  }

  if (failures.length > 0) {
    for (const msg of failures) {
      console.error(`  ✗ ${msg}`);
    }
    console.error('\nRun `shipper init` to fix these issues.');
    process.exit(1);
  }

  // Auto-create .shipper/tmp if missing (cheap, idempotent)
  mkdirSync(path.resolve('.shipper', 'tmp'), { recursive: true });
}
