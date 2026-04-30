/* global console, process */

import { mkdir, readdir, rm, stat, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultSource = path.resolve(scriptDir, '../../docs/src/content/docs');
const defaultTarget = path.resolve(scriptDir, '../dist/docs');
const markdownExtension = /\.(?:md|mdx)$/;

async function assertDirectory(candidate, label) {
  try {
    if (!(await stat(candidate)).isDirectory()) {
      throw new Error(`${label} is not a directory: ${candidate}`);
    }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`${label} directory is missing: ${candidate}`);
    }
    throw error;
  }
}

async function collectSnapshotFiles(source) {
  const files = [];

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      if (!entry.isFile() || !markdownExtension.test(entry.name)) {
        continue;
      }

      const relative = path.relative(source, fullPath);
      if (relative === 'index.mdx') {
        continue;
      }
      files.push({ fullPath, relative });
    }
  }

  await walk(source);
  return files.sort((a, b) => a.relative.localeCompare(b.relative));
}

export async function copyDocsSnapshot(options = {}) {
  const source = path.resolve(options.source ?? defaultSource);
  const target = path.resolve(options.target ?? defaultTarget);

  await assertDirectory(source, 'Docs corpus source');
  await rm(target, { recursive: true, force: true });

  const files = await collectSnapshotFiles(source);
  for (const file of files) {
    const targetPath = path.join(target, file.relative);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(file.fullPath, targetPath);
  }

  return { source, target, copied: files.map((file) => file.relative) };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--source') {
      const value = argv[index + 1];
      if (!value) throw new Error('--source requires a value.');
      options.source = value;
      index += 1;
    } else if (arg === '--target') {
      const value = argv[index + 1];
      if (!value) throw new Error('--target requires a value.');
      options.target = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await copyDocsSnapshot(parseArgs(process.argv.slice(2)));
  console.log(`Copied ${result.copied.length} documentation file(s) to ${result.target}`);
}
