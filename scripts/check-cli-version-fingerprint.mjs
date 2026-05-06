import { error as writeError } from 'node:console';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const settingsPath = '.shipper/settings.json';
const cliPackagePath = 'packages/cli/package.json';
const missing = '<missing>';

function readJson(relativePath) {
  const filePath = path.join(process.cwd(), relativePath);

  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeError(`Unable to read ${relativePath}: ${message}`);
    process.exitCode = 1;
    return undefined;
  }
}

function readString(value) {
  return typeof value === 'string' ? value : undefined;
}

const settings = readJson(settingsPath);
const cliPackage = readJson(cliPackagePath);

if (process.exitCode) {
  process.exit();
}

const recorded = readString(settings?.cliVersion);
const cliVersion = readString(cliPackage?.version);
const recordedDisplay = recorded ?? missing;
const cliVersionDisplay = cliVersion ?? missing;

if (recorded !== undefined && cliVersion !== undefined && recorded === cliVersion) {
  process.exit();
}

writeError(`Shipper CLI version fingerprint drift detected

${settingsPath} cliVersion: ${recordedDisplay}
${cliPackagePath} version: ${cliVersionDisplay}

Run \`shipper init\` to refresh the fingerprint, or revert/align \`packages/cli/package.json\` if the manifest bump was unintended.`);
process.exitCode = 1;
