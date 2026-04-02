import { getSettings } from '../settings.js';
import {
  INSTALL_OUTPUT_MAX_BUFFER,
  MAX_REBASE_ATTEMPTS,
  execAsync,
  formatCommandFailure,
} from './helpers.js';

export async function runPostRebaseInstall(cwd: string): Promise<string | undefined> {
  const { installCommand } = getSettings();
  if (!installCommand) {
    return undefined;
  }

  const result = await execAsync(installCommand, [], {
    cwd,
    shell: true,
    maxBuffer: INSTALL_OUTPUT_MAX_BUFFER,
  });
  if (result.code === 0) {
    return undefined;
  }

  return formatCommandFailure(installCommand, [], result);
}

export async function installWithRemediation(
  cwd: string,
  remediate?: (installError: string) => Promise<number>
): Promise<number | undefined> {
  let installError = await runPostRebaseInstall(cwd);
  if (!installError) {
    return undefined;
  }

  if (!remediate) {
    throw new Error(`Post-rebase install failed:\n${installError}`);
  }

  for (let attempt = 1; attempt <= MAX_REBASE_ATTEMPTS; attempt++) {
    const agentCode = await remediate(installError);
    if (agentCode !== 0) {
      return agentCode;
    }

    installError = await runPostRebaseInstall(cwd);
    if (!installError) {
      return undefined;
    }
  }

  throw new Error(
    `Post-rebase install failed after ${MAX_REBASE_ATTEMPTS} remediation attempts:\n${installError}`
  );
}
