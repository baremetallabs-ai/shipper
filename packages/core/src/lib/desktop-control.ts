import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const SHIPPER_DESKTOP_CONTROL_DIR_ENV = 'SHIPPER_DESKTOP_CONTROL_DIR';
export const DESKTOP_CONTROL_STATE_FILE = 'state.json';
export const DESKTOP_FINALIZE_SENTINEL_FILE = 'finalize-requested';
export const DESKTOP_AGENT_GRACE_TIMEOUT_MS = 15_000;
export const DESKTOP_WRAPPER_DRAIN_TIMEOUT_MS = 5_000;

export interface DesktopControlState {
  stage: 'groom';
  worktreePath: string;
  outputDir: string;
}

function isDesktopControlState(value: unknown): value is DesktopControlState {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    record.stage === 'groom' &&
    typeof record.worktreePath === 'string' &&
    record.worktreePath.length > 0 &&
    typeof record.outputDir === 'string' &&
    record.outputDir.length > 0
  );
}

function statePath(controlDir: string): string {
  return path.join(controlDir, DESKTOP_CONTROL_STATE_FILE);
}

function finalizeSentinelPath(controlDir: string): string {
  return path.join(controlDir, DESKTOP_FINALIZE_SENTINEL_FILE);
}

export function resolveDesktopControlDir(
  env: Record<string, string | undefined> = process.env
): string | null {
  const controlDir = env[SHIPPER_DESKTOP_CONTROL_DIR_ENV];
  return controlDir && controlDir.length > 0 ? controlDir : null;
}

export async function writeDesktopControlState(
  controlDir: string,
  state: DesktopControlState
): Promise<void> {
  await mkdir(controlDir, { recursive: true });
  await writeFile(statePath(controlDir), `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}

export async function readDesktopControlState(
  controlDir: string
): Promise<DesktopControlState | null> {
  let raw: string;
  try {
    raw = await readFile(statePath(controlDir), 'utf-8');
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return isDesktopControlState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function requestDesktopFinalize(controlDir: string): Promise<void> {
  await mkdir(controlDir, { recursive: true });
  await writeFile(finalizeSentinelPath(controlDir), '', 'utf-8');
}

export async function isDesktopFinalizeRequested(controlDir: string): Promise<boolean> {
  try {
    await access(finalizeSentinelPath(controlDir));
    return true;
  } catch {
    return false;
  }
}

export async function hasDesktopResultArtifact(controlDir: string): Promise<boolean> {
  const state = await readDesktopControlState(controlDir);
  if (!state) {
    return false;
  }

  try {
    await access(path.join(state.outputDir, 'result.json'));
    return true;
  } catch {
    return false;
  }
}
