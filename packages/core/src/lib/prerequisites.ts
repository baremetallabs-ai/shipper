import { execFile } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { gh } from './gh.js';
import { STAGE_LABEL_NAMES } from './labels.js';

const execFileAsync = promisify(execFile);

interface CheckResult {
  ok: boolean;
  message: string;
}

export async function checkGhInstalled(): Promise<CheckResult> {
  try {
    await gh(['--version']);
    return { ok: true, message: 'gh is installed' };
  } catch {
    return {
      ok: false,
      message: 'GitHub CLI (gh) is not installed. Install it from https://cli.github.com/',
    };
  }
}

export async function checkGhAuth(): Promise<CheckResult> {
  try {
    await gh(['auth', 'status']);
    return { ok: true, message: 'gh is authenticated' };
  } catch {
    return { ok: false, message: 'GitHub CLI is not authenticated. Run: gh auth login' };
  }
}

export async function checkGitRepo(): Promise<CheckResult> {
  try {
    await execFileAsync('git', ['rev-parse', '--git-dir']);
    return { ok: true, message: 'Inside a git repository' };
  } catch {
    return { ok: false, message: 'Not inside a git repository. Run: git init' };
  }
}

export async function checkGitHubRemote(repo?: string): Promise<CheckResult> {
  try {
    const { stdout } = await gh([
      'repo',
      'view',
      ...(repo ? ['-R', repo] : []),
      '--json',
      'name',
      '-q',
      '.name',
    ]);
    const output = stdout.trim();
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

export async function checkShipperDir(): Promise<CheckResult> {
  const shipperDir = path.resolve('.shipper');
  try {
    await access(shipperDir);
    return { ok: true, message: '.shipper directory exists' };
  } catch {
    return { ok: false, message: '.shipper directory not found. Run: shipper init' };
  }
}

export async function checkLabels(repo?: string): Promise<CheckResult> {
  try {
    const { stdout } = await gh([
      'label',
      'list',
      ...(repo ? ['-R', repo] : []),
      '--search',
      'shipper:',
      '--json',
      'name',
      '-q',
      '.[].name',
    ]);
    const output = stdout.trim();
    const existing = output ? output.split(/\r?\n/) : [];
    const missing = STAGE_LABEL_NAMES.filter((label) => !existing.includes(label));
    if (missing.length === 0) {
      return { ok: true, message: 'All required labels exist' };
    }
    return { ok: false, message: `Missing label(s): ${missing.join(', ')}` };
  } catch {
    return { ok: false, message: 'Could not check labels (gh label list failed)' };
  }
}

export async function runPrereqChecks(checks: Array<() => Promise<CheckResult>>): Promise<boolean> {
  for (const check of checks) {
    const result = await check();
    if (!result.ok) {
      console.error(`Prereq failed: ${result.message}`);
      return false;
    }
  }
  return true;
}

export async function runPreflight(repo?: string): Promise<void> {
  const checks = [checkGhInstalled, checkGhAuth, checkShipperDir, () => checkLabels(repo)];

  const failures: string[] = [];
  for (const check of checks) {
    const result = await check();
    if (!result.ok) {
      failures.push(result.message);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `${failures.map((msg) => `  ✗ ${msg}`).join('\n')}\n\nRun \`shipper init\` to fix these issues.`
    );
  }

  // Auto-create .shipper/tmp if missing (cheap, idempotent)
  await mkdir(path.resolve('.shipper', 'tmp'), { recursive: true });
}
