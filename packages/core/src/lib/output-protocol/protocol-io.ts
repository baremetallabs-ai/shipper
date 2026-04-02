import { mkdir, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const PROTOCOL_INPUT_DIR = path.join('.shipper', 'input');
export const PROTOCOL_OUTPUT_DIR = path.join('.shipper', 'output');
const TRUNCATION_THRESHOLD_BYTES = 50_000;
const TRUNCATION_HEAD_LINES = 50;
const TRUNCATION_TAIL_LINES = 50;
const TRUNCATION_HEAD_BYTES = 25_000;
const TRUNCATION_TAIL_BYTES = 25_000;
const PROTOCOL_INPUT_DISPLAY_DIR = path.posix.join('.shipper', 'input');

function resolveContainedPath(rootDir: string, relativePath: string, label: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`${label} must be a relative path`);
  }

  const resolvedPath = path.resolve(rootDir, relativePath);
  const relativeToRoot = path.relative(rootDir, resolvedPath);
  if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    throw new Error(`${label} must stay within ${rootDir}`);
  }

  return resolvedPath;
}

export function resolveOutputPath(cwd: string, outputPath: string, label = 'output path'): string {
  const outputDir = path.resolve(cwd, PROTOCOL_OUTPUT_DIR);
  const resolvedPath = path.resolve(cwd, outputPath);
  const relativeToOutputDir = path.relative(outputDir, resolvedPath);
  if (relativeToOutputDir.startsWith('..') || path.isAbsolute(relativeToOutputDir)) {
    throw new Error(`${label} must stay within ${outputDir}`);
  }

  return resolvedPath;
}

export async function setupProtocolDirs(cwd: string): Promise<void> {
  await mkdir(path.resolve(cwd, PROTOCOL_INPUT_DIR), { recursive: true });
  await mkdir(path.resolve(cwd, PROTOCOL_OUTPUT_DIR), { recursive: true });
}

export async function scrubOutputDir(cwd: string): Promise<void> {
  const outputDir = path.resolve(cwd, PROTOCOL_OUTPUT_DIR);
  await mkdir(outputDir, { recursive: true });

  const entries = await readdir(outputDir, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.name !== '.gitkeep')
      .map(async (entry) => {
        const entryPath = path.join(outputDir, entry.name);
        if (entry.isDirectory()) {
          await rm(entryPath, { recursive: true, force: true });
          return;
        }

        await unlink(entryPath);
      })
  );
}

export async function writeContextFile(
  cwd: string,
  filename: string,
  content: string
): Promise<void> {
  const inputDir = path.resolve(cwd, PROTOCOL_INPUT_DIR);
  const filePath = resolveContainedPath(inputDir, filename, 'context filename');
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf-8');
}

function truncateByBytes(text: string, maxBytes: number, fromEnd = false): string {
  const buffer = Buffer.from(text, 'utf-8');
  if (buffer.length <= maxBytes) {
    return text;
  }

  if (maxBytes <= 0) {
    return '';
  }

  if (fromEnd) {
    let sliceStart = buffer.length - maxBytes;
    while (sliceStart < buffer.length) {
      const byte = buffer[sliceStart];
      if (byte === undefined || (byte & 0xc0) !== 0x80) {
        break;
      }
      sliceStart++;
    }
    return buffer.subarray(sliceStart).toString('utf-8');
  }

  let sliceEnd = maxBytes;
  while (sliceEnd > 0) {
    const byte = buffer[sliceEnd];
    if (byte === undefined || (byte & 0xc0) !== 0x80) {
      break;
    }
    sliceEnd--;
  }
  return buffer.subarray(0, sliceEnd).toString('utf-8');
}

export async function truncateLargeInput(
  cwd: string,
  text: string,
  filename: string
): Promise<string> {
  if (Buffer.byteLength(text, 'utf-8') <= TRUNCATION_THRESHOLD_BYTES) {
    return text;
  }

  await writeContextFile(cwd, filename, text);

  const filePath = path.posix.join(PROTOCOL_INPUT_DISPLAY_DIR, filename);
  const lines = text.split('\n');
  const headLines = lines.slice(0, TRUNCATION_HEAD_LINES);
  const tailLines = lines.slice(-TRUNCATION_TAIL_LINES);
  const omittedLineCount = lines.length - headLines.length - tailLines.length;

  if (omittedLineCount > 0) {
    const sections = [
      truncateByBytes(headLines.join('\n'), TRUNCATION_HEAD_BYTES),
      `[${omittedLineCount} lines omitted; full output written to ${filePath}]`,
      truncateByBytes(tailLines.join('\n'), TRUNCATION_TAIL_BYTES, true),
    ];
    return sections.filter((section) => section.length > 0).join('\n\n');
  }

  const head = truncateByBytes(text, TRUNCATION_HEAD_BYTES);
  const tail = truncateByBytes(text, TRUNCATION_TAIL_BYTES, true);
  const omittedBytes = Math.max(
    Buffer.byteLength(text, 'utf-8') -
      Buffer.byteLength(head, 'utf-8') -
      Buffer.byteLength(tail, 'utf-8'),
    0
  );

  return [head, `[${omittedBytes} bytes omitted; full output written to ${filePath}]`, tail]
    .filter((section) => section.length > 0)
    .join('\n\n');
}
