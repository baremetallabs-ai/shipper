import { access, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type DocsCorpusSource = 'workspace' | 'bundled' | 'env';
export type ResolvedDocsCorpusRoot = { root: string; source: DocsCorpusSource };
export type DocsPage = { path: string; title: string; body: string; description?: string };
export type DocsSearchMatch = { path: string; title: string; score: number; snippet: string };
export type DocsCorpus = {
  source?: ResolvedDocsCorpusRoot;
  search(query: string, limit: number): DocsSearchMatch[];
  get(path: string): DocsPage;
};

type FrontmatterValue = string | boolean;
type Frontmatter = Record<string, FrontmatterValue | undefined>;
type DocsChunk = {
  page: DocsPage;
  heading: string;
  text: string;
  searchText: string;
  tokenCounts: Map<string, number>;
};

const CORPUS_UNAVAILABLE_MESSAGE =
  'Shipper documentation corpus is unavailable. Rebuild @dnsquared/shipper-mcp with the docs snapshot or set SHIPPER_DOCS_PATH to an absolute docs corpus path.';

const EXTENSION_RE = /\.(?:md|mdx)$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.+)$/;

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

function defaultModuleDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}

function normalizeDocsPath(value: string): string {
  return value
    .trim()
    .replace(/^\/+/, '')
    .replace(/\.(?:md|mdx)$/i, '');
}

export function normalizeDocsFetchPath(value: string): string {
  const normalized = value
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.(?:md|mdx)$/i, '');
  if (!normalized) {
    throw new Error('Documentation page path must not be empty.');
  }
  return normalized;
}

export async function resolveDocsCorpusRoot(
  startDir = defaultModuleDir(),
  env: Record<string, string | undefined> = process.env
): Promise<ResolvedDocsCorpusRoot | undefined> {
  let current = path.resolve(startDir);
  let shouldSearch = true;
  while (shouldSearch) {
    const workspaceRoot = path.join(current, 'packages/docs/src/content/docs');
    if (await isDirectory(workspaceRoot)) {
      return { root: workspaceRoot, source: 'workspace' };
    }

    const parent = path.dirname(current);
    shouldSearch = parent !== current;
    current = parent;
  }

  const bundledRoot = path.join(path.resolve(startDir), 'docs');
  if (await isDirectory(bundledRoot)) {
    return { root: bundledRoot, source: 'bundled' };
  }

  const envRoot = env.SHIPPER_DOCS_PATH?.trim();
  if (envRoot && path.isAbsolute(envRoot) && (await isDirectory(envRoot))) {
    return { root: envRoot, source: 'env' };
  }

  return undefined;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseFrontmatterValue(value: string): FrontmatterValue {
  const trimmed = value.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return stripQuotes(trimmed);
}

function parseFrontmatter(content: string): { frontmatter: Frontmatter; body: string } {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
    return { frontmatter: {}, body: content };
  }

  const newline = content.startsWith('---\r\n') ? '\r\n' : '\n';
  const closeMarker = `${newline}---${newline}`;
  const endIndex = content.indexOf(closeMarker, 3);
  if (endIndex < 0) {
    return { frontmatter: {}, body: content };
  }

  const raw = content.slice(3 + newline.length, endIndex);
  const frontmatter: Frontmatter = {};
  for (const line of raw.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (key !== 'title' && key !== 'description' && key !== 'template') continue;
    frontmatter[key] = parseFrontmatterValue(line.slice(separator + 1));
  }

  return { frontmatter, body: content.slice(endIndex + closeMarker.length) };
}

function titleFromPath(docsPath: string): string {
  return (
    docsPath
      .split('/')
      .at(-1)
      ?.replaceAll('-', ' ')
      .replace(/\b\w/g, (char) => char.toUpperCase()) ?? docsPath
  );
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && EXTENSION_RE.test(entry.name)) {
        files.push(fullPath);
      }
    }
  }

  await walk(root);
  return files.sort((a, b) => a.localeCompare(b));
}

function stripMdxForSearch(body: string): string {
  const lines = body.split(/\r?\n/);
  let inFence = false;
  const searchable: string[] = [];

  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      searchable.push(line);
      continue;
    }

    if (!inFence && /^\s*(?:import|export)\s/.test(line)) {
      continue;
    }

    searchable.push(
      inFence
        ? line
        : line
            .replace(/<\/?[A-Za-z][A-Za-z0-9_.:-]*(?:\s*[^>]*)?>/g, ' ')
            .replace(/\{\/\*.*?\*\/\}/g, ' ')
    );
  }

  return searchable.join('\n');
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function tokenize(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function tokenCounts(value: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokenize(value)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

function createSnippet(chunkText: string, queryTerms: string[]): string {
  const compact = compactWhitespace(chunkText);
  if (!compact) return '';

  const lower = compact.toLowerCase();
  const hitIndex =
    queryTerms
      .map((term) => lower.indexOf(term))
      .filter((index) => index >= 0)
      .sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, hitIndex - 80);
  const end = Math.min(compact.length, hitIndex + 220);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < compact.length ? '...' : '';
  return `${prefix}${compact.slice(start, end).trim()}${suffix}`;
}

function createChunks(page: DocsPage): DocsChunk[] {
  const searchBody = stripMdxForSearch(page.body);
  const chunks: Array<{ heading: string; lines: string[] }> = [];
  let current: { heading: string; lines: string[] } = { heading: 'Overview', lines: [] };

  for (const line of searchBody.split(/\r?\n/)) {
    const heading = HEADING_RE.exec(line);
    if (heading) {
      if (current.lines.some((entry) => entry.trim().length > 0)) {
        chunks.push(current);
      }
      current = { heading: heading[2]?.trim() ?? 'Section', lines: [line] };
    } else {
      current.lines.push(line);
    }
  }

  if (current.lines.some((entry) => entry.trim().length > 0)) {
    chunks.push(current);
  }

  return chunks.map((chunk) => {
    const text = compactWhitespace(chunk.lines.join('\n'));
    const searchText = `${page.title}\n${page.description ?? ''}\n${chunk.heading}\n${text}`;
    return {
      page,
      heading: chunk.heading,
      text,
      searchText,
      tokenCounts: tokenCounts(searchText),
    };
  });
}

function scoreChunk(chunk: DocsChunk, query: string, queryTerms: string[]): number {
  const title = chunk.page.title.toLowerCase();
  const heading = chunk.heading.toLowerCase();
  const body = chunk.searchText.toLowerCase();
  const phrase = query.trim().toLowerCase();
  let score = 0;

  for (const term of queryTerms) {
    if (title.includes(term)) score += 12;
    if (heading.includes(term)) score += 7;
    score += (chunk.tokenCounts.get(term) ?? 0) * 2;
  }

  if (phrase && title.includes(phrase)) score += 20;
  if (phrase && heading.includes(phrase)) score += 12;
  if (phrase && body.includes(phrase)) score += 8;

  return Number(score.toFixed(2));
}

async function loadPages(source: ResolvedDocsCorpusRoot): Promise<DocsPage[]> {
  const files = await listMarkdownFiles(source.root);
  const pages: DocsPage[] = [];

  for (const file of files) {
    const content = await readFile(file, 'utf8');
    const { frontmatter, body } = parseFrontmatter(content);
    if (frontmatter.template === 'splash') {
      continue;
    }

    const relative = toPosixPath(path.relative(source.root, file));
    const docsPath = normalizeDocsPath(relative);
    const title =
      typeof frontmatter.title === 'string' && frontmatter.title.trim()
        ? frontmatter.title.trim()
        : titleFromPath(docsPath);
    const description =
      typeof frontmatter.description === 'string' && frontmatter.description.trim()
        ? frontmatter.description.trim()
        : undefined;
    pages.push({ path: docsPath, title, body, ...(description ? { description } : {}) });
  }

  return pages.sort((a, b) => a.path.localeCompare(b.path));
}

function unavailableCorpus(): DocsCorpus {
  return {
    search: () => {
      throw new Error(CORPUS_UNAVAILABLE_MESSAGE);
    },
    get: () => {
      throw new Error(CORPUS_UNAVAILABLE_MESSAGE);
    },
  };
}

export async function buildDocsCorpus(source?: ResolvedDocsCorpusRoot): Promise<DocsCorpus> {
  const resolved = source ?? (await resolveDocsCorpusRoot());
  if (!resolved) {
    return unavailableCorpus();
  }
  if (!(await pathExists(resolved.root))) {
    return unavailableCorpus();
  }

  let pages: DocsPage[];
  try {
    pages = await loadPages(resolved);
  } catch {
    return unavailableCorpus();
  }

  const pagesByPath = new Map<string, DocsPage>();
  for (const page of pages) {
    if (!pagesByPath.has(page.path)) {
      pagesByPath.set(page.path, page);
    }
    if (page.path.endsWith('/index')) {
      const sectionPath = page.path.slice(0, -'/index'.length);
      if (sectionPath && !pagesByPath.has(sectionPath)) {
        pagesByPath.set(sectionPath, page);
      }
    }
  }
  const chunks = pages.flatMap(createChunks);

  return {
    source: resolved,
    search(query, limit) {
      const queryTerms = [...new Set(tokenize(query))];
      if (queryTerms.length === 0) {
        return [];
      }

      const bestByPage = new Map<string, DocsSearchMatch>();
      for (const chunk of chunks) {
        const score = scoreChunk(chunk, query, queryTerms);
        if (score <= 0) continue;
        const match = {
          path: chunk.page.path,
          title: chunk.page.title,
          score,
          snippet: createSnippet(chunk.text, queryTerms),
        };
        const current = bestByPage.get(chunk.page.path);
        if (!current || match.score > current.score) {
          bestByPage.set(chunk.page.path, match);
        }
      }

      return [...bestByPage.values()]
        .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
        .slice(0, limit);
    },
    get(value) {
      const requestedPath = normalizeDocsFetchPath(value);
      const page = pagesByPath.get(requestedPath);
      if (!page) {
        throw new Error(
          `Documentation page not found for path "${value}". Call shipper_docs_search to find a valid docs path.`
        );
      }
      return page;
    },
  };
}
