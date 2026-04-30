import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'shipper-docs-snapshot-test-'));
  tempRoots.push(tempRoot);
  return tempRoot;
}

async function writeFixture(root: string, relativePath: string, content: string): Promise<void> {
  const fullPath = path.join(root, relativePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content);
}

function runCopy(source: string, target: string): void {
  const result = spawnSync(
    process.execPath,
    ['scripts/copy-docs-snapshot.mjs', '--source', source, '--target', target],
    {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
      encoding: 'utf8',
    }
  );
  if (result.status !== 0) {
    throw new Error(`copy-docs-snapshot failed:\n${result.stderr}\n${result.stdout}`);
  }
}

describe('copy docs snapshot script', () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((tempRoot) => rm(tempRoot, { recursive: true })));
  });

  it('copies markdown docs, preserves subdirectories, skips root splash and stale files', async () => {
    const tempRoot = await makeTempRoot();
    const source = path.join(tempRoot, 'source');
    const target = path.join(tempRoot, 'target');

    await writeFixture(source, 'index.mdx', '# Splash\n');
    await writeFixture(source, 'agents/setup.md', '# Setup\n');
    await writeFixture(source, 'reference/mcp/index.md', '# MCP index\n');
    await writeFixture(source, 'notes.txt', 'ignore me\n');
    await writeFixture(target, 'stale.md', '# Stale\n');

    runCopy(source, target);

    expect(existsSync(path.join(target, 'index.mdx'))).toBe(false);
    expect(existsSync(path.join(target, 'notes.txt'))).toBe(false);
    expect(existsSync(path.join(target, 'stale.md'))).toBe(false);
    expect(await readFile(path.join(target, 'agents/setup.md'), 'utf8')).toBe('# Setup\n');
    expect(await readFile(path.join(target, 'reference/mcp/index.md'), 'utf8')).toBe(
      '# MCP index\n'
    );
  });
});
