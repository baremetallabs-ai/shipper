import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toolExtras, type ToolExtras } from '../../src/docs/tool-extras.js';
import {
  REMEDIATION_LINE,
  checkMcpReference,
  discoverMcpReferenceModel,
  generateMcpReference,
  renderToolPage,
  toolGroups,
  validateMcpReferenceModel,
} from '../../src/docs/mcp-reference-generator.js';
import { mcpToolDefinitions, type ToolName } from '../../src/tools.js';

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'shipper-mcp-docs-test-'));
  tempRoots.push(tempRoot);
  return tempRoot;
}

function findTool(name: ToolName) {
  const tool = mcpToolDefinitions.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Missing tool ${name}`);
  }
  return tool;
}

describe('mcp reference generator', () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((tempRoot) => rm(tempRoot, { recursive: true })));
  });

  it('fails validation when a tool is missing extras', () => {
    const model = discoverMcpReferenceModel();
    const extras: Record<string, ToolExtras> = { ...toolExtras };
    delete extras.shipper_reset;

    expect(() => {
      validateMcpReferenceModel(model, extras);
    }).toThrow('MCP tool "shipper_reset" is missing docs extras.');
  });

  it('fails validation when extras contain a stale tool name', () => {
    const model = discoverMcpReferenceModel();
    const extras: Record<string, ToolExtras> = {
      ...toolExtras,
      shipper_stale: toolExtras.shipper_reset,
    };

    expect(() => {
      validateMcpReferenceModel(model, extras);
    }).toThrow('MCP docs extras reference unknown tool "shipper_stale".');
  });

  it('fails validation when a tool description is empty', () => {
    const model = discoverMcpReferenceModel([
      { ...findTool('shipper_reset'), description: '' },
      ...mcpToolDefinitions.filter((tool) => tool.name !== 'shipper_reset'),
    ]);

    expect(() => {
      validateMcpReferenceModel(model);
    }).toThrow('MCP tool "shipper_reset" is missing a description.');
  });

  it('fails validation when group coverage is missing, unknown, or duplicated', () => {
    const model = discoverMcpReferenceModel();

    expect(() => {
      validateMcpReferenceModel(
        model,
        toolExtras,
        toolGroups.map((group) =>
          group.title === 'Recovery & cleanup'
            ? { ...group, tools: group.tools.filter((name) => name !== 'shipper_reset') }
            : group
        )
      );
    }).toThrow('MCP tool "shipper_reset" is missing from the landing page group map.');

    expect(() => {
      validateMcpReferenceModel(model, toolExtras, [
        ...toolGroups,
        { title: 'Stale', tools: ['shipper_stale'] },
      ]);
    }).toThrow('MCP landing group "Stale" references unknown tool "shipper_stale".');

    expect(() => {
      validateMcpReferenceModel(model, toolExtras, [
        ...toolGroups,
        { title: 'Duplicate', tools: ['shipper_reset'] },
      ]);
    }).toThrow('MCP tool "shipper_reset" appears in multiple landing page groups');
  });

  it('fails validation when related tools reference a stale name', () => {
    const model = discoverMcpReferenceModel();
    const extras: Record<string, ToolExtras> = {
      ...toolExtras,
      shipper_reset: {
        ...toolExtras.shipper_reset,
        relatedTools: ['shipper_stale' as ToolName],
      },
    };

    expect(() => {
      validateMcpReferenceModel(model, extras);
    }).toThrow('MCP tool "shipper_reset" relatedTools references unknown tool "shipper_stale".');
  });

  it('renders experimental frontmatter and lead note', () => {
    const rendered = renderToolPage(findTool('shipper_groom'), toolExtras.shipper_groom);

    expect(rendered).toContain('experimental: true\nflag: "SHIPPER_EXPERIMENTAL_MCP_GROOMING"');
    expect(rendered).toContain(
      'Experimental — only registered when `isMcpGroomingEnabled()` returns true. Set `SHIPPER_EXPERIMENTAL_MCP_GROOMING` to enable.'
    );
  });

  it('keeps abbreviations inside the frontmatter summary sentence', () => {
    const rendered = renderToolPage(
      {
        ...findTool('shipper_reset'),
        description:
          'Inspect related identifiers, e.g. issue labels, before choosing a reset target. Follow-up text should not be included.',
      },
      toolExtras.shipper_reset
    );

    expect(rendered).toContain(
      'description: "Inspect related identifiers, e.g. issue labels, before choosing a reset target."'
    );
  });

  it('renders behavior hints from explicit annotations only', () => {
    const rendered = renderToolPage(findTool('shipper_reset'), toolExtras.shipper_reset);
    const docsRendered = renderToolPage(
      findTool('shipper_docs_search'),
      toolExtras.shipper_docs_search
    );

    expect(rendered).toContain('## Behavior hints');
    expect(rendered).toContain(
      '- destructiveHint: true — The tool can remove or rewrite workflow artifacts and should be used carefully.'
    );
    expect(rendered).toContain(
      '- openWorldHint: true — The tool reaches GitHub or other external systems outside the MCP server.'
    );
    expect(rendered).not.toContain('readOnlyHint: false');
    expect(rendered).not.toContain('idempotentHint: false');
    expect(docsRendered).toContain(
      '- readOnlyHint: true — The tool only reads state and does not intentionally modify the repository.'
    );
    expect(docsRendered).toContain(
      '- idempotentHint: true — Retrying the same call is expected to be safe once the target state is reached.'
    );
    expect(docsRendered).toContain(
      '- openWorldHint: false — The tool does not reach GitHub or other external systems outside the MCP server.'
    );
  });

  it('derives schema table rows from Zod descriptions, required state, enum values, and defaults', () => {
    const rendered = renderToolPage(
      {
        name: 'shipper_reset',
        description: 'Reset docs test.',
        inputSchema: {
          target: z.enum(['new', 'groomed']).describe('Target stage.'),
          stale: z.boolean().optional().describe('Sweep stale locks.'),
          dry_run: z.boolean().default(true).describe('Preview only.'),
        },
      },
      toolExtras.shipper_reset
    );

    expect(rendered).toContain('| target | enum: new, groomed | yes | - | Target stage. |');
    expect(rendered).toContain('| stale | boolean | no | - | Sweep stale locks. |');
    expect(rendered).toContain('| dry_run | boolean | yes | true | Preview only. |');
  });

  it('renders required section ordering on a representative page', () => {
    const rendered = renderToolPage(findTool('shipper_reset'), toolExtras.shipper_reset);
    const orderedSnippets = [
      '# shipper_reset',
      '## When to use',
      '## Behavior hints',
      '## Input schema',
      '## Example call',
      '## Example result',
      '## Error modes',
      '## Related tools',
    ];

    let previousIndex = -1;
    for (const snippet of orderedSnippets) {
      const nextIndex = rendered.indexOf(snippet);
      expect(nextIndex).toBeGreaterThan(previousIndex);
      previousIndex = nextIndex;
    }
  });

  it('generates the landing page with group order and experimental suffixes', async () => {
    const tempRoot = await makeTempRoot();
    await generateMcpReference(tempRoot);
    const indexPath = path.join(tempRoot, 'packages/docs/src/content/docs/reference/mcp/index.md');
    const index = await readFile(indexPath, 'utf8');

    const orderedGroups = [
      '## Documentation',
      '## Inspection (read-only)',
      '## Issue lifecycle',
      '## Recovery & cleanup',
      '## Merge queue',
      '## Experimental: MCP-driven grooming',
    ];
    let previousIndex = -1;
    for (const group of orderedGroups) {
      const nextIndex = index.indexOf(group);
      expect(nextIndex).toBeGreaterThan(previousIndex);
      previousIndex = nextIndex;
    }
    expect(index).toContain('[shipper_docs_search](./shipper_docs_search)');
    expect(index).toContain('[shipper_docs_get](./shipper_docs_get)');
    expect(index).toContain('[shipper_groom (experimental)](./shipper_groom)');
    expect(index).toContain('[shipper_answer_question (experimental)](./shipper_answer_question)');
    expect(
      existsSync(path.join(tempRoot, 'packages/docs/src/content/docs/reference/mcp.mdx'))
    ).toBe(false);
  });

  it('reports drift with a diff and remediation line', async () => {
    const tempRoot = await makeTempRoot();
    await generateMcpReference(tempRoot);
    const resetPath = path.join(
      tempRoot,
      'packages/docs/src/content/docs/reference/mcp/shipper_reset.md'
    );
    const original = await readFile(resetPath, 'utf8');
    await writeFile(resetPath, `${original}\nStale edit.\n`);

    await expect(checkMcpReference(tempRoot)).rejects.toThrow(REMEDIATION_LINE);
    await expect(checkMcpReference(tempRoot)).rejects.toThrow('diff --git');
  });
});
