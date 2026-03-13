import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

export const SHIPPER_DIR = '.shipper';
export const INPUT_DIR = path.join(SHIPPER_DIR, 'input');
export const OUTPUT_DIR = path.join(SHIPPER_DIR, 'output');
export const RESULT_FILENAME = 'result.json';
const GITKEEP_FILENAME = '.gitkeep';

function resolveDir(cwd: string, relativeDir: string): string {
  return path.resolve(cwd, relativeDir);
}

async function scrubDir(dirPath: string): Promise<void> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.name !== GITKEEP_FILENAME)
      .map((entry) => rm(path.join(dirPath, entry.name), { recursive: true, force: true }))
  );
}

export async function ensureDirectories(cwd = process.cwd()): Promise<void> {
  await Promise.all([
    mkdir(resolveDir(cwd, INPUT_DIR), { recursive: true }),
    mkdir(resolveDir(cwd, OUTPUT_DIR), { recursive: true }),
  ]);
}

export async function scrubInputDir(cwd = process.cwd()): Promise<void> {
  await scrubDir(resolveDir(cwd, INPUT_DIR));
}

export async function scrubOutputDir(cwd = process.cwd()): Promise<void> {
  await scrubDir(resolveDir(cwd, OUTPUT_DIR));
}
