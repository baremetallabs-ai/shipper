export type DiffLineRange = [number, number];

export interface DiffFileHunks {
  left: DiffLineRange[];
  right: DiffLineRange[];
}

const DIFF_HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function unescapeQuotedDiffPath(rawPath: string): string {
  let unescaped = '';

  for (let index = 0; index < rawPath.length; index += 1) {
    const character = rawPath[index];
    if (character !== '\\') {
      unescaped += character;
      continue;
    }

    const nextCharacter = rawPath[index + 1];
    if (nextCharacter === undefined) {
      unescaped += '\\';
      break;
    }

    if (/[0-7]/.test(nextCharacter)) {
      let octalDigits = nextCharacter;
      while (octalDigits.length < 3) {
        const trailingDigit = rawPath[index + octalDigits.length + 1];
        if (!trailingDigit || !/[0-7]/.test(trailingDigit)) {
          break;
        }
        octalDigits += trailingDigit;
      }
      unescaped += String.fromCharCode(Number.parseInt(octalDigits, 8));
      index += octalDigits.length;
      continue;
    }

    const escapedCharacter =
      nextCharacter === 'n'
        ? '\n'
        : nextCharacter === 'r'
          ? '\r'
          : nextCharacter === 't'
            ? '\t'
            : nextCharacter;
    unescaped += escapedCharacter;
    index += 1;
  }

  return unescaped;
}

function parseDiffPath(line: string, prefix: string): string | undefined {
  const rawHeader = line.slice(4).replace(/\r$/, '');
  let rawPath: string;

  if (rawHeader.startsWith('"')) {
    let closingQuoteIndex = -1;
    let escaped = false;

    for (let index = 1; index < rawHeader.length; index += 1) {
      const character = rawHeader[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        continue;
      }
      if (character === '"') {
        closingQuoteIndex = index;
        break;
      }
    }

    rawPath =
      closingQuoteIndex === -1
        ? rawHeader
        : unescapeQuotedDiffPath(rawHeader.slice(1, closingQuoteIndex));
  } else {
    rawPath = rawHeader.split('\t', 1)[0]?.trimEnd() ?? rawHeader;
  }

  if (rawPath === '/dev/null') {
    return undefined;
  }

  return rawPath.startsWith(prefix) ? rawPath.slice(prefix.length) : rawPath;
}

function ensureDiffFileHunks(
  diffHunks: Map<string, DiffFileHunks>,
  filePath: string
): DiffFileHunks {
  let fileHunks = diffHunks.get(filePath);
  if (!fileHunks) {
    fileHunks = { left: [], right: [] };
    diffHunks.set(filePath, fileHunks);
  }

  return fileHunks;
}

function parseHunkCount(rawCount: string | undefined): number {
  return rawCount === undefined ? 1 : Number(rawCount);
}

export function includesLine(ranges: DiffLineRange[], line: number): boolean {
  return ranges.some(([start, end]) => line >= start && line <= end);
}

function formatRanges(ranges: DiffLineRange[]): string {
  return ranges.map(([start, end]) => `${start}-${end}`).join(', ');
}

export function formatValidRanges(fileHunks?: DiffFileHunks): string {
  if (!fileHunks || (fileHunks.left.length === 0 && fileHunks.right.length === 0)) {
    return 'Valid ranges — (none)';
  }

  const parts: string[] = [];
  if (fileHunks.left.length > 0) {
    parts.push(`LEFT: ${formatRanges(fileHunks.left)}`);
  }
  if (fileHunks.right.length > 0) {
    parts.push(`RIGHT: ${formatRanges(fileHunks.right)}`);
  }

  return `Valid ranges — ${parts.join('; ')}`;
}

export function parseDiffHunks(diff: string): Map<string, DiffFileHunks> {
  const diffHunks = new Map<string, DiffFileHunks>();
  let oldFilePath: string | undefined;
  let currentFilePath: string | undefined;
  let parsingFileHeaders = true;

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      oldFilePath = undefined;
      currentFilePath = undefined;
      parsingFileHeaders = true;
      continue;
    }

    if (parsingFileHeaders && line.startsWith('--- ')) {
      oldFilePath = parseDiffPath(line, 'a/');
      continue;
    }

    if (parsingFileHeaders && line.startsWith('+++ ')) {
      const newFilePath = parseDiffPath(line, 'b/');
      currentFilePath = newFilePath ?? oldFilePath;
      if (currentFilePath) {
        ensureDiffFileHunks(diffHunks, currentFilePath);
      }
      continue;
    }

    if (!line.startsWith('@@ ') || !currentFilePath) {
      continue;
    }

    const match = DIFF_HUNK_HEADER_PATTERN.exec(line);
    if (!match) {
      continue;
    }

    const [, rawOldStart, rawOldCount, rawNewStart, rawNewCount] = match;
    const oldStart = Number(rawOldStart);
    const oldCount = parseHunkCount(rawOldCount);
    const newStart = Number(rawNewStart);
    const newCount = parseHunkCount(rawNewCount);
    const fileHunks = ensureDiffFileHunks(diffHunks, currentFilePath);
    parsingFileHeaders = false;

    if (oldCount > 0) {
      fileHunks.left.push([oldStart, oldStart + oldCount - 1]);
    }
    if (newCount > 0) {
      fileHunks.right.push([newStart, newStart + newCount - 1]);
    }
  }

  return diffHunks;
}
