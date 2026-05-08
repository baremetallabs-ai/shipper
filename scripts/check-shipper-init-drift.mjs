#!/usr/bin/env node
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkerPath = path.join(repoRoot, 'packages/cli/dist/scripts/check-init-drift.js');
const buildInputs = [
  'packages/core/src',
  'packages/core/package.json',
  'packages/core/tsup.config.ts',
  'packages/cli/src',
  'packages/cli/package.json',
  'packages/cli/tsup.config.ts',
];

async function pathMtimeMs(filepath) {
  try {
    return (await stat(filepath)).mtimeMs;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function latestMtimeMs(filepath) {
  const entry = await stat(filepath);
  if (!entry.isDirectory()) {
    return entry.mtimeMs;
  }

  const children = await readdir(filepath, { withFileTypes: true });
  let latest = entry.mtimeMs;
  for (const child of children) {
    const childPath = path.join(filepath, child.name);
    const childMtime = child.isDirectory()
      ? await latestMtimeMs(childPath)
      : (await stat(childPath)).mtimeMs;
    latest = Math.max(latest, childMtime);
  }
  return latest;
}

async function shouldBuildChecker() {
  const checkerMtime = await pathMtimeMs(checkerPath);
  if (checkerMtime === undefined) {
    return true;
  }

  for (const input of buildInputs) {
    if ((await latestMtimeMs(path.join(repoRoot, input))) > checkerMtime) {
      return true;
    }
  }

  return false;
}

async function run(command, args, options = {}) {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: options.stdio ?? 'pipe',
    });
    const stdout = [];
    const stderr = [];

    child.stdout?.on('data', (chunk) => stdout.push(chunk));
    child.stderr?.on('data', (chunk) => stderr.push(chunk));

    child.on('error', (error) => {
      resolve({ code: 1, stdout: '', stderr: String(error) });
    });
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf-8'),
        stderr: Buffer.concat(stderr).toString('utf-8'),
      });
    });
  });
}

if (await shouldBuildChecker()) {
  const result = await run('npm', ['run', 'build', '--workspace=packages/cli', '--silent']);
  if (result.code !== 0) {
    process.stderr.write('Failed to build the Shipper init drift checker.\n');
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.code);
  }
}

const result = await run(process.execPath, [checkerPath], { stdio: 'inherit' });
process.exit(result.code);
