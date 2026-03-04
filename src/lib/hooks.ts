import { execSync } from 'node:child_process';

export function runAdvisoryHook(
  label: string,
  command: string,
  env: Record<string, string>,
  cwd?: string
): void {
  try {
    execSync(command, {
      stdio: ['inherit', 'inherit', 'pipe'],
      env: { ...process.env, ...env },
      cwd,
    });
    console.log(`  ${label} hook completed.`);
  } catch (err) {
    const rawStatus =
      err && typeof err === 'object' && 'status' in err
        ? (err as { status: unknown }).status
        : undefined;
    const code = typeof rawStatus === 'number' ? rawStatus : 'unknown';
    const stderr =
      err && typeof err === 'object' && 'stderr' in err
        ? String((err as { stderr: unknown }).stderr).trim()
        : '';
    console.warn(`  Warning: ${label} hook exited with code ${code}${stderr ? ': ' + stderr : ''}`);
  }
}
