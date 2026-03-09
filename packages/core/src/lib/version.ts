import { getSettings } from './settings.js';

export const CLI_VERSION: string = process.env.SHIPPER_VERSION ?? '0.0.0-dev';

export function checkVersionFreshness(): void {
  if (process.env.SHIPPER_SKIP_VERSION_CHECK === '1') return;

  const installed = CLI_VERSION;
  const recorded = getSettings().cliVersion;

  if (installed === '0.0.0-dev' || recorded === '0.0.0-dev') return;

  if (recorded !== installed) {
    const reason = recorded
      ? `Installed CLI version (${installed}) differs from initialized version (${recorded}).`
      : `No version fingerprint found in .shipper/settings.json.`;
    throw new Error(`${reason}\nRun \`shipper init\` to re-initialize.`);
  }
}
