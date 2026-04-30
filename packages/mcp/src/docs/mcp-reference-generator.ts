import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { mcpToolDefinitions, type ToolName } from '../tools.js';
import { toolExtras, type ToolExtras } from './tool-extras.js';

export const REMEDIATION_LINE = 'Run `npm run docs:generate-mcp` and commit the result.';

const landingIntro =
  'Shipper exposes its workflow operations to AI agents via an MCP server. Each tool below has a dedicated reference page covering schema, examples, and error modes.';
const landingDescription = 'Reference for every shipper MCP server tool.';

type BehaviorHintName = 'readOnlyHint' | 'destructiveHint' | 'idempotentHint' | 'openWorldHint';

const hintExplanations = {
  readOnlyHint: 'The tool only reads state and does not intentionally modify the repository.',
  destructiveHint:
    'The tool can remove or rewrite workflow artifacts and should be used carefully.',
  idempotentHint: 'Retrying the same call is expected to be safe once the target state is reached.',
  openWorldHint: 'The tool reaches GitHub or other external systems outside the MCP server.',
} as const satisfies Record<BehaviorHintName, string>;

export const toolGroups = [
  {
    title: 'Documentation',
    tools: ['shipper_docs_search', 'shipper_docs_get'],
  },
  {
    title: 'Inspection (read-only)',
    tools: ['shipper_list_issues', 'shipper_get_issue', 'shipper_get_pr_checks'],
  },
  {
    title: 'Issue lifecycle',
    tools: ['shipper_create_issue', 'shipper_advance', 'shipper_adopt'],
  },
  {
    title: 'Recovery & cleanup',
    tools: ['shipper_reset', 'shipper_unblock', 'shipper_unlock'],
  },
  { title: 'Merge queue', tools: ['shipper_merge'] },
  {
    title: 'Experimental: MCP-driven grooming',
    tools: ['shipper_groom', 'shipper_answer_question'],
  },
] as const satisfies readonly { title: string; tools: readonly ToolName[] }[];

type ReferenceTool = {
  name: string;
  description: string;
  inputSchema: ZodRawShapeCompat;
  annotations?: ToolAnnotations;
  experimental?: { flag: string; enabled: () => boolean };
};

export type McpReferenceModel = {
  tools: readonly ReferenceTool[];
};

type ExtrasRegistry = Record<string, ToolExtras | undefined>;
type GroupDefinition = { title: string; tools: readonly string[] };
type JsonSchemaObject = Record<string, unknown>;

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
}

function mcpReferenceDir(root = repoRoot()): string {
  return path.join(root, 'packages/docs/src/content/docs/reference/mcp');
}

function oldMcpReferenceFile(root = repoRoot()): string {
  return path.join(root, 'packages/docs/src/content/docs/reference/mcp.mdx');
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function frontmatter(fields: Record<string, string | boolean>): string {
  const lines = Object.entries(fields).map(([key, value]) =>
    typeof value === 'string' ? `${key}: ${yamlString(value)}` : `${key}: ${value}`
  );
  return `---\n${lines.join('\n')}\n---\n\n`;
}

function escapeTableCell(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

function table(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.map(escapeTableCell).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(escapeTableCell).join(' | ')} |`),
  ].join('\n');
}

function asObject(value: unknown): JsonSchemaObject {
  return typeof value === 'object' && value !== null ? (value as JsonSchemaObject) : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function singleSentence(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, ' ');
  const abbreviations = new Set(['e.g.', 'i.e.', 'mr.', 'mrs.', 'ms.', 'dr.', 'vs.', 'etc.']);

  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (char !== '.' && char !== '!' && char !== '?') {
      continue;
    }
    const next = trimmed[index + 1];
    if (next !== undefined && !/\s/.test(next)) {
      continue;
    }

    const sentence = trimmed.slice(0, index + 1).trim();
    const lastToken = sentence.split(/\s+/).at(-1)?.toLowerCase();
    if (lastToken && abbreviations.has(lastToken)) {
      continue;
    }
    return sentence;
  }

  return trimmed;
}

function formatDefault(value: unknown): string {
  return value === undefined ? '-' : JSON.stringify(value);
}

function formatSchemaType(schema: JsonSchemaObject): string {
  const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined;
  if (enumValues && enumValues.length > 0) {
    return `enum: ${enumValues.map(String).join(', ')}`;
  }
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.map((entry) => formatSchemaType(asObject(entry))).join(' | ');
  }
  if (Array.isArray(schema.type)) {
    return schema.type.join(' | ');
  }
  if (typeof schema.type === 'string') {
    return schema.type;
  }
  if (schema.additionalProperties) {
    return 'object';
  }
  return '-';
}

function renderSchemaTable(tool: ReferenceTool, extras: ToolExtras): string {
  const jsonSchema = asObject(z.toJSONSchema(z.object(tool.inputSchema)));
  const properties = asObject(jsonSchema.properties);
  const required = new Set(asStringArray(jsonSchema.required));
  const rows = Object.entries(properties).map(([name, schemaValue]) => {
    const schema = asObject(schemaValue);
    const description =
      typeof schema.description === 'string'
        ? schema.description
        : (extras.parameterDescriptions?.[name] ?? '-');
    return [
      name,
      formatSchemaType(schema),
      required.has(name) ? 'yes' : 'no',
      formatDefault(schema.default),
      description,
    ];
  });

  return table(['Name', 'Type', 'Required', 'Default', 'Description'], rows);
}

function renderBehaviorHints(annotations: ToolAnnotations | undefined): string {
  if (!annotations) {
    return '';
  }
  const rows = (
    ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const
  ).flatMap((hint) =>
    annotations[hint] === undefined
      ? []
      : [`- ${hint}: ${String(annotations[hint])} — ${hintExplanations[hint]}`]
  );
  return rows.length === 0 ? '' : `## Behavior hints\n\n${rows.join('\n')}\n\n`;
}

function renderRelatedTools(relatedTools: ToolName[] | undefined): string {
  if (!relatedTools || relatedTools.length === 0) {
    return '';
  }
  return ['## Related tools', '', ...relatedTools.map((name) => `- [${name}](./${name})`), ''].join(
    '\n'
  );
}

export function discoverMcpReferenceModel(
  tools: readonly ReferenceTool[] = mcpToolDefinitions
): McpReferenceModel {
  return { tools };
}

export function validateMcpReferenceModel(
  model: McpReferenceModel,
  extras: ExtrasRegistry = toolExtras,
  groups: readonly GroupDefinition[] = toolGroups
): void {
  const errors: string[] = [];
  const toolNameSet = new Set(model.tools.map((tool) => tool.name));
  const groupCounts = new Map<string, string[]>();

  for (const tool of model.tools) {
    if (!tool.description.trim()) {
      errors.push(`MCP tool "${tool.name}" is missing a description.`);
    }
    if (!extras[tool.name]) {
      errors.push(`MCP tool "${tool.name}" is missing docs extras.`);
    }
    for (const relatedTool of extras[tool.name]?.relatedTools ?? []) {
      if (!toolNameSet.has(relatedTool)) {
        errors.push(
          `MCP tool "${tool.name}" relatedTools references unknown tool "${relatedTool}".`
        );
      }
    }
  }

  for (const name of Object.keys(extras)) {
    if (!toolNameSet.has(name)) {
      errors.push(`MCP docs extras reference unknown tool "${name}".`);
    }
  }

  for (const group of groups) {
    for (const name of group.tools) {
      if (!toolNameSet.has(name)) {
        errors.push(`MCP landing group "${group.title}" references unknown tool "${name}".`);
        continue;
      }
      const titles = groupCounts.get(name) ?? [];
      titles.push(group.title);
      groupCounts.set(name, titles);
    }
  }

  for (const name of toolNameSet) {
    const titles = groupCounts.get(name) ?? [];
    if (titles.length === 0) {
      errors.push(`MCP tool "${name}" is missing from the landing page group map.`);
    }
    if (titles.length > 1) {
      errors.push(
        `MCP tool "${name}" appears in multiple landing page groups: ${titles.join(', ')}.`
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(`MCP reference validation failed:\n- ${errors.join('\n- ')}`);
  }
}

function renderLandingPage(model: McpReferenceModel): string {
  const toolsByName = new Map(model.tools.map((tool) => [tool.name, tool]));
  const sections = toolGroups
    .map((group) => {
      const entries = group.tools.map((name) => {
        const tool = toolsByName.get(name);
        if (!tool) {
          throw new Error(`MCP landing group "${group.title}" references unknown tool "${name}".`);
        }
        const suffix = tool.experimental ? ' (experimental)' : '';
        return `- [${name}${suffix}](./${name}) — ${tool.description}`;
      });
      return [`## ${group.title}`, '', ...entries, ''].join('\n');
    })
    .join('\n');

  return (
    frontmatter({ title: 'MCP', description: landingDescription }) +
    `# MCP\n\n${landingIntro}\n\n${sections}`
  );
}

export function renderToolPage(tool: ReferenceTool, extras: ToolExtras): string {
  const description = singleSentence(tool.description);
  const frontmatterFields: Record<string, string | boolean> = {
    title: tool.name,
    description,
  };
  if (tool.experimental) {
    frontmatterFields.experimental = true;
    frontmatterFields.flag = tool.experimental.flag;
  }

  const experimentalNote = tool.experimental
    ? ` Experimental — only registered when \`isMcpGroomingEnabled()\` returns true. Set \`${tool.experimental.flag}\` to enable.`
    : '';
  const whenToUse = extras.whenToUse ? `## When to use\n\n${extras.whenToUse}\n\n` : '';
  const resultLanguage = extras.example.resultLanguage ?? 'text';
  const errorModes = extras.errorModes.map((mode) => `- ${mode.name}: ${mode.message}`).join('\n');

  return (
    frontmatter(frontmatterFields) +
    `# ${tool.name}\n\n` +
    `${tool.description}${experimentalNote}\n\n` +
    whenToUse +
    renderBehaviorHints(tool.annotations) +
    `## Input schema\n\n${renderSchemaTable(tool, extras)}\n\n` +
    `## Example call\n\n\`\`\`json\n${JSON.stringify(extras.example.call, null, 2)}\n\`\`\`\n\n` +
    `## Example result\n\n\`\`\`${resultLanguage}\n${extras.example.result}\n\`\`\`\n\n` +
    `## Error modes\n\n${errorModes}\n\n` +
    renderRelatedTools(extras.relatedTools)
  );
}

async function writeGeneratedTree(baseDir: string, model: McpReferenceModel): Promise<void> {
  await writeFile(path.join(baseDir, 'index.md'), renderLandingPage(model));

  for (const tool of model.tools) {
    const extras = (toolExtras as ExtrasRegistry)[tool.name];
    if (!extras) {
      throw new Error(`MCP tool "${tool.name}" is missing docs extras.`);
    }
    await writeFile(path.join(baseDir, `${tool.name}.md`), renderToolPage(tool, extras));
  }
}

function resolveModulePath(root: string, specifier: string): string | undefined {
  try {
    return createRequire(path.join(root, 'package.json')).resolve(specifier);
  } catch {
    return undefined;
  }
}

function formatGeneratedTree(baseDir: string, root: string): void {
  const roots = [...new Set([root, repoRoot()])];
  const prettierBin = roots
    .flatMap((candidate) => [
      resolveModulePath(candidate, 'prettier/bin/prettier.cjs'),
      path.join(candidate, 'node_modules/prettier/bin/prettier.cjs'),
    ])
    .filter((candidate): candidate is string => candidate !== undefined)
    .find((candidate) => existsSync(candidate));
  if (!prettierBin) {
    throw new Error('Prettier binary not found. Run npm install first.');
  }
  const prettierConfig = roots
    .map((candidate) => path.join(candidate, '.prettierrc'))
    .find((candidate) => existsSync(candidate));
  if (!prettierConfig) {
    throw new Error('Prettier config not found.');
  }

  const result = spawnSync(
    process.execPath,
    [prettierBin, '--config', prettierConfig, '--write', baseDir],
    { encoding: 'utf8' }
  );

  if (result.status !== 0) {
    throw new Error(`Failed to format generated MCP reference.\n${result.stdout}${result.stderr}`);
  }
}

export async function generateMcpReference(root = repoRoot()): Promise<void> {
  const model = discoverMcpReferenceModel();
  validateMcpReferenceModel(model);

  const outputDir = mcpReferenceDir(root);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeGeneratedTree(outputDir, model);
  formatGeneratedTree(outputDir, root);
  await rm(oldMcpReferenceFile(root), { force: true });
}

async function listFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) {
    return [];
  }

  const entries = await readdir(dir);
  const files = await Promise.all(
    entries.map(async (entry) => {
      const absolute = path.join(dir, entry);
      const info = await stat(absolute);
      if (info.isDirectory()) {
        return (await listFiles(absolute)).map((file) => path.join(entry, file));
      }
      return [entry];
    })
  );
  return files.flat().sort();
}

async function readComparableFile(baseDir: string, relativePath: string): Promise<string> {
  return readFile(path.join(baseDir, relativePath), 'utf8');
}

async function treesMatch(actualDir: string, expectedDir: string): Promise<boolean> {
  const [actualFiles, expectedFiles] = await Promise.all([
    listFiles(actualDir),
    listFiles(expectedDir),
  ]);
  if (actualFiles.join('\n') !== expectedFiles.join('\n')) {
    return false;
  }

  for (const relativePath of actualFiles) {
    const [actual, expected] = await Promise.all([
      readComparableFile(actualDir, relativePath),
      readComparableFile(expectedDir, relativePath),
    ]);
    if (actual !== expected) {
      return false;
    }
  }

  return true;
}

function unifiedDiff(actualDir: string, expectedDir: string): string {
  const result = spawnSync(
    'git',
    ['diff', '--no-index', '--no-color', '--', actualDir, expectedDir],
    { encoding: 'utf8' }
  );

  if (result.error) {
    return `Failed to run git diff: ${result.error.message}`;
  }

  return [result.stdout, result.stderr].filter(Boolean).join('');
}

export async function checkMcpReference(root = repoRoot()): Promise<void> {
  const model = discoverMcpReferenceModel();
  validateMcpReferenceModel(model);

  const tempRoot = await mkdtemp(path.join(tmpdir(), 'shipper-mcp-reference-'));
  try {
    const tempDir = path.join(tempRoot, 'mcp');
    await mkdir(tempDir, { recursive: true });
    await writeGeneratedTree(tempDir, model);
    formatGeneratedTree(tempDir, root);

    const outputDir = mcpReferenceDir(root);
    const oldFile = oldMcpReferenceFile(root);
    const oldFileExists = existsSync(oldFile);
    const matches = !oldFileExists && (await treesMatch(outputDir, tempDir));

    if (!matches) {
      const messages = oldFileExists
        ? [`Unexpected hand-written MCP reference remains at ${oldFile}.\n`]
        : [];
      const diff = unifiedDiff(outputDir, tempDir);
      throw new Error([...messages, diff, REMEDIATION_LINE].filter(Boolean).join('\n'));
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
