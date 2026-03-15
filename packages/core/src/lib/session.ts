import path from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';

export interface SessionMeta {
  repo: string;
  issue: string;
  stage: string;
  agent: string;
  model: string;
  timestamp: string;
  exitCode: number;
  logFile: string;
}

export function getSessionDir(repo?: string): string {
  const slug = repo ? repo.replace('/', '-') : path.basename(process.cwd());
  return path.join(homedir(), '.shipper', 'sessions', slug);
}

export function getSessionPaths(
  repo: string | undefined,
  issue: string | undefined,
  stage: string
): { logFile: string; metaFile: string } {
  const dir = getSessionDir(repo);
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  const prefix = `${issue ?? 'unlinked'}-${stage}-${timestamp}`;
  return {
    logFile: path.join(dir, `${prefix}.jsonl`),
    metaFile: path.join(dir, `${prefix}.meta.json`),
  };
}

export async function writeSessionMeta(metaFile: string, meta: SessionMeta): Promise<void> {
  await mkdir(path.dirname(metaFile), { recursive: true });
  await writeFile(metaFile, JSON.stringify(meta, null, 2));
}
