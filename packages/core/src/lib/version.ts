import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';
import { getSettings } from './settings.js';

export const CLI_VERSION: string = process.env.SHIPPER_VERSION ?? '0.0.0-dev';

type ComparableVersion = { major: number; minor: number; patch: number };

const COMPARABLE_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseComparableVersion(value: unknown): ComparableVersion | undefined {
  if (typeof value !== 'string') return undefined;

  const match = COMPARABLE_VERSION_RE.exec(value);
  if (!match) return undefined;

  const [, majorText, minorText, patchText] = match;

  const major = Number(majorText);
  const minor = Number(minorText);
  const patch = Number(patchText);

  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    !Number.isSafeInteger(patch)
  ) {
    return undefined;
  }

  return { major, minor, patch };
}

function compareComparableVersions(a: ComparableVersion, b: ComparableVersion): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

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

  if (isShipperDogfoodRepo(options.cwd)) {
    if (recorded !== installed) {
      logger.warn(`Shipper dogfood mode: running CLI version (${installed}) differs from the recorded fingerprint (${recorded ?? '<missing>'}).
Run \`shipper init\` to refresh the fingerprint, or align \`packages/cli/package.json\` if the manifest bump was unintended.`);
    }
    return;
  }

  const installedVersion = parseComparableVersion(installed);
  const recordedVersion = parseComparableVersion(recorded);

  if (!installedVersion || !recordedVersion) {
    throw new Error(`Cannot verify Shipper CLI version freshness. Installed CLI version (${installed}) and recorded fingerprint (${recorded ?? '<missing>'}) must both be comparable major.minor.patch versions.
Run \`shipper init\` to re-initialize.`);
  }

  const comparison = compareComparableVersions(installedVersion, recordedVersion);
  if (comparison === 0) return;

  if (comparison < 0) {
    throw new Error(`Installed CLI version (${installed}) is older than the initialized version (${recorded}). Downgrades are blocked.
Run \`shipper init\` to re-initialize.`);
  }

  if (installedVersion.major !== recordedVersion.major) {
    throw new Error(`Installed CLI version (${installed}) differs from initialized version (${recorded}) at the major version level.
Run \`shipper init\` to re-initialize.`);
  }

  logger.warn(`Installed CLI version (${installed}) is newer than the recorded fingerprint (${recorded}) within the same major version.
Run \`shipper init\` to refresh the fingerprint.`);
}
