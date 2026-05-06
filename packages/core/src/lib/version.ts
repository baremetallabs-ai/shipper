import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';
import { getSettings } from './settings.js';

export const CLI_VERSION: string = process.env.SHIPPER_VERSION ?? '0.0.0-dev';

function readJsonObject(filePath: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeRepositoryUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;

  let normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;

  normalized = normalized.replace(/^git\+/, '');

  if (normalized.startsWith('git@github.com:')) {
    normalized = `github.com/${normalized.slice('git@github.com:'.length)}`;
  } else if (normalized.startsWith('ssh://git@github.com/')) {
    normalized = `github.com/${normalized.slice('ssh://git@github.com/'.length)}`;
  } else {
    normalized = normalized.replace(/^https?:\/\//, '');
  }

  return normalized.replace(/\/$/, '').replace(/\.git$/, '');
}

function getRepositoryUrl(pkg: Record<string, unknown> | undefined): unknown {
  const repository = pkg?.repository;

  if (repository && typeof repository === 'object' && !Array.isArray(repository)) {
    return (repository as Record<string, unknown>).url;
  }

  return repository;
}

function isShipperDogfoodRepo(cwd = process.cwd()): boolean {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const rootPackage = readJsonObject(path.join(root, 'package.json'));
    const cliPackage = readJsonObject(path.join(root, 'packages/cli/package.json'));

    return (
      rootPackage?.name === 'shipper-monorepo' &&
      cliPackage?.name === '@baremetallabs-ai/shipper-cli' &&
      normalizeRepositoryUrl(getRepositoryUrl(cliPackage)) === 'github.com/baremetallabs-ai/shipper'
    );
  } catch {
    return false;
  }
}

export function checkVersionFreshness(options: { cwd?: string } = {}): void {
  if (process.env.SHIPPER_SKIP_VERSION_CHECK === '1') return;

  const installed = CLI_VERSION;
  const recorded = getSettings().cliVersion;

  if (installed === '0.0.0-dev' || recorded === '0.0.0-dev') return;

  if (recorded !== installed) {
    if (isShipperDogfoodRepo(options.cwd)) {
      logger.warn(`Shipper dogfood mode: running CLI version (${installed}) differs from the recorded fingerprint (${recorded ?? '<missing>'}).
Run \`shipper init\` to refresh the fingerprint, or align \`packages/cli/package.json\` if the manifest bump was unintended.`);
      return;
    }

    const reason = recorded
      ? `Installed CLI version (${installed}) differs from initialized version (${recorded}).`
      : `No version fingerprint found in .shipper/settings.json.`;
    throw new Error(`${reason}\nRun \`shipper init\` to re-initialize.`);
  }
}
