import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildDocsCorpus, resolveDocsCorpusRoot } from '../../src/docs/corpus.js';

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'shipper-docs-corpus-test-'));
  tempRoots.push(tempRoot);
  return tempRoot;
}

async function writeFixture(root: string, relativePath: string, content: string): Promise<void> {
  const fullPath = path.join(root, relativePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content);
}

describe('docs corpus', () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((tempRoot) => rm(tempRoot, { recursive: true })));
  });

  it('loads pages, strips frontmatter for get, preserves MDX body, and normalizes fetch paths', async () => {
    const root = await makeTempRoot();
    await writeFixture(
      root,
      'agents/setup.md',
      `---
title: "Repository setup for agents"
description: Configure agent sessions
---

import { Card } from '@astrojs/starlight/components';

# Repository setup for agents

Keep this raw MDX component:

<Card title="Agent setup">Nested child content</Card>
`
    );

    const corpus = await buildDocsCorpus({ root, source: 'workspace' });
    const page = corpus.get('/agents/setup.md');

    expect(page.path).toBe('agents/setup');
    expect(page.title).toBe('Repository setup for agents');
    expect(page.description).toBe('Configure agent sessions');
    expect(page.body).not.toContain('title:');
    expect(page.body).toContain('import { Card }');
    expect(page.body).toContain('<Card title="Agent setup">Nested child content</Card>');
    expect(corpus.get('agents/setup.mdx')).toEqual(page);
  });

  it('returns relevance-ordered search matches with one best chunk per page and honors limits', async () => {
    const root = await makeTempRoot();
    await writeFixture(
      root,
      'agents/setup.md',
      `---
title: "Repository setup for agents"
---

General setup overview.

## Configure agents

Agent setup setup setup instructions for Shipper repositories.

## Troubleshooting

Unrelated fallback text.
`
    );
    await writeFixture(
      root,
      'concepts/state-machine.mdx',
      `---
title: State machine
---

## Workflow

The workflow references agent setup once.
`
    );

    const corpus = await buildDocsCorpus({ root, source: 'workspace' });
    const matches = corpus.search('agent setup', 1);

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      path: 'agents/setup',
      title: 'Repository setup for agents',
    });
    expect(matches[0]?.score).toBeGreaterThan(0);
    expect(matches[0]?.snippet).toContain('Configure agents');
    expect(matches[0]?.snippet).toContain('setup setup setup');

    const allMatches = corpus.search('agent setup', 5);
    expect(allMatches.map((match) => match.path)).toEqual([
      'agents/setup',
      'concepts/state-machine',
    ]);
  });

  it('uses search text that removes imports and MDX tags while preserving child text and code', async () => {
    const root = await makeTempRoot();
    await writeFixture(
      root,
      'agents/setup.mdx',
      `---
title: Setup
---

import Thing from './Thing.astro';

<Thing>Visible child text</Thing>

\`\`\`sh
export GH_TOKEN=<token>
\`\`\`
`
    );

    const corpus = await buildDocsCorpus({ root, source: 'workspace' });

    expect(corpus.search('Visible child', 5)[0]?.path).toBe('agents/setup');
    expect(corpus.search('GH_TOKEN', 5)[0]?.snippet).toContain('export GH_TOKEN=<token>');
    expect(corpus.search('Thing astro', 5)).toEqual([]);
  });

  it('excludes splash pages from get and search', async () => {
    const root = await makeTempRoot();
    await writeFixture(
      root,
      'index.mdx',
      `---
title: Splash
template: splash
---

# Splash-only homepage
`
    );
    await writeFixture(
      root,
      'agents/setup.md',
      `---
title: Setup
---

## Agents

Setup agents here.
`
    );

    const corpus = await buildDocsCorpus({ root, source: 'workspace' });

    expect(corpus.search('Splash-only', 5)).toEqual([]);
    expect(() => corpus.get('index')).toThrow(
      'Documentation page not found for path "index". Call shipper_docs_search'
    );
  });

  it('throws a clear suggested-search error for unknown paths', async () => {
    const root = await makeTempRoot();
    await writeFixture(root, 'agents/setup.md', '---\ntitle: Setup\n---\n\n# Setup\n');

    const corpus = await buildDocsCorpus({ root, source: 'workspace' });

    expect(() => corpus.get('/missing/page.md')).toThrow(
      'Documentation page not found for path "/missing/page.md". Call shipper_docs_search to find a valid docs path.'
    );
  });

  it('resolves sources in workspace, bundled, then env priority order', async () => {
    const tempRoot = await makeTempRoot();
    const startDir = path.join(tempRoot, 'packages/mcp/dist');
    const workspaceRoot = path.join(tempRoot, 'packages/docs/src/content/docs');
    const bundledRoot = path.join(startDir, 'docs');
    const envRoot = path.join(tempRoot, 'env-docs');
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(bundledRoot, { recursive: true });
    await mkdir(envRoot, { recursive: true });

    await expect(resolveDocsCorpusRoot(startDir, { SHIPPER_DOCS_PATH: envRoot })).resolves.toEqual({
      root: workspaceRoot,
      source: 'workspace',
    });

    await rm(path.join(tempRoot, 'packages/docs'), { recursive: true });
    await expect(resolveDocsCorpusRoot(startDir, { SHIPPER_DOCS_PATH: envRoot })).resolves.toEqual({
      root: bundledRoot,
      source: 'bundled',
    });

    await rm(bundledRoot, { recursive: true });
    await expect(resolveDocsCorpusRoot(startDir, { SHIPPER_DOCS_PATH: envRoot })).resolves.toEqual({
      root: envRoot,
      source: 'env',
    });

    await expect(
      resolveDocsCorpusRoot(startDir, { SHIPPER_DOCS_PATH: 'relative/docs' })
    ).resolves.toBeUndefined();
  });
});
