import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Argument, Command, Option } from 'commander';
import { createProgram } from '../program.js';
import {
  commandExtras,
  groups as commandGroups,
  type CommandExtras,
  type CommandGroupExtras,
  type CommandPath,
} from './command-extras.js';

export const REMEDIATION_LINE = 'Run npm run docs:generate-cli and commit the result.';

type GroupInfo = {
  kind: 'group';
  pathSegments: string[];
  command: Command;
  description: string;
  children: ReferenceChild[];
};

export type LeafInfo = {
  kind: 'leaf';
  pathSegments: string[];
  command: Command;
  description: string;
};

type ReferenceChild = GroupInfo | LeafInfo;

export type ReferenceModel = {
  groups: GroupInfo[];
  leaves: LeafInfo[];
};

type CommandExtrasRegistry = Record<string, CommandExtras>;
type GroupRegistry = Record<string, CommandGroupExtras>;
type CategoryDefinition = { title: string; commands: readonly string[] };
const groups: GroupRegistry = commandGroups;

const categoryMap = [
  { title: 'Getting started', commands: ['init', 'setup'] },
  { title: 'Issue intake', commands: ['new', 'adopt', 'priority'] },
  { title: 'Workflow', commands: ['next', 'groom', 'design', 'plan', 'implement', 'ship'] },
  { title: 'Operations', commands: ['merge', 'reset', 'unblock', 'unlock', 'eject'] },
] as const satisfies readonly { title: string; commands: readonly CommandPath[] }[];

const landingDescription = 'Reference for every shipper CLI command.';
const landingIntro =
  'Use these pages as the generated reference for the current Shipper CLI surface.';

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
}

function cliReferenceDir(root = repoRoot()): string {
  return path.join(root, 'packages/docs/src/content/docs/reference/cli');
}

function oldCliReferenceFile(root = repoRoot()): string {
  return path.join(root, 'packages/docs/src/content/docs/reference/cli.mdx');
}

function commandPath(pathSegments: string[]): string {
  return pathSegments.join(' ');
}

function commandTitle(pathSegments: string[]): string {
  return `shipper ${commandPath(pathSegments)}`;
}

function linkForPath(pathSegments: string[]): string {
  return `./${pathSegments.join('/')}`;
}

function leafOutputPath(baseDir: string, pathSegments: string[]): string {
  const leafSegment = pathSegments.at(-1);
  if (!leafSegment) {
    throw new Error('Cannot render a leaf command without a path.');
  }

  return path.join(baseDir, ...pathSegments.slice(0, -1), `${leafSegment}.md`);
}

function groupOutputPath(baseDir: string, pathSegments: string[]): string {
  return path.join(baseDir, ...pathSegments, 'index.md');
}

function readDescription(command: Command): string {
  return command.description().trim();
}

export function discoverReferenceModel(program: Command): ReferenceModel {
  const model: ReferenceModel = { groups: [], leaves: [] };

  function visit(command: Command, pathSegments: string[]): ReferenceChild {
    const description = readDescription(command);
    if (command.commands.length === 0) {
      const leaf = { kind: 'leaf' as const, pathSegments, command, description };
      model.leaves.push(leaf);
      return leaf;
    }

    const group: GroupInfo = {
      kind: 'group',
      pathSegments,
      command,
      description,
      children: [],
    };
    model.groups.push(group);
    for (const child of command.commands) {
      group.children.push(visit(child, [...pathSegments, child.name()]));
    }
    return group;
  }

  for (const command of program.commands) {
    visit(command, [command.name()]);
  }

  return model;
}

export function validateReferenceModel(
  model: ReferenceModel,
  extras: CommandExtrasRegistry = commandExtras,
  groupDefinitions: GroupRegistry = groups,
  categories: readonly CategoryDefinition[] = categoryMap
): void {
  const errors: string[] = [];
  const leafPaths = new Set(model.leaves.map((leaf) => commandPath(leaf.pathSegments)));
  const groupPaths = new Set(model.groups.map((group) => commandPath(group.pathSegments)));
  const topLevelLeafPaths = new Set(
    model.leaves
      .filter((leaf) => leaf.pathSegments.length === 1)
      .map((leaf) => commandPath(leaf.pathSegments))
  );

  for (const group of model.groups) {
    const groupPath = commandPath(group.pathSegments);
    if (!group.description) {
      errors.push(`Command group "${groupPath}" is missing a description.`);
    }
    if (!groupDefinitions[groupPath]) {
      errors.push(`Command group "${groupPath}" is missing an extras group description.`);
    }
  }

  for (const [groupPath, groupDefinition] of Object.entries(groupDefinitions)) {
    if (!groupPaths.has(groupPath)) {
      errors.push(`Docs group descriptions reference unknown command group "${groupPath}".`);
    }
    if (!groupDefinition.description.trim()) {
      errors.push(`Docs group description for "${groupPath}" is empty.`);
    }
    if (groupDefinition.pageDescription !== undefined && !groupDefinition.pageDescription.trim()) {
      errors.push(`Docs group page description for "${groupPath}" is empty.`);
    }
    if (groupDefinition.intro !== undefined && !groupDefinition.intro.trim()) {
      errors.push(`Docs group intro for "${groupPath}" is empty.`);
    }
  }

  for (const leaf of model.leaves) {
    const leafPath = commandPath(leaf.pathSegments);
    if (!leaf.description) {
      errors.push(`Command "${leafPath}" is missing a description.`);
    }
    if (!extras[leafPath]) {
      errors.push(`Command "${leafPath}" is missing docs extras.`);
    }
  }

  for (const pathKey of Object.keys(extras)) {
    if (!leafPaths.has(pathKey)) {
      errors.push(`Docs extras reference unknown command "${pathKey}".`);
    }
  }

  const categoryCounts = new Map<string, string[]>();
  for (const category of categories) {
    for (const pathKey of category.commands) {
      if (!topLevelLeafPaths.has(pathKey)) {
        errors.push(
          `Landing page category "${category.title}" references unknown top-level command "${pathKey}".`
        );
        continue;
      }
      const categoryTitles = categoryCounts.get(pathKey) ?? [];
      categoryTitles.push(category.title);
      categoryCounts.set(pathKey, categoryTitles);
    }
  }

  for (const pathKey of topLevelLeafPaths) {
    const categoryTitles = categoryCounts.get(pathKey) ?? [];
    if (categoryTitles.length === 0) {
      errors.push(`Top-level command "${pathKey}" is missing from the landing page category map.`);
    }
    if (categoryTitles.length > 1) {
      errors.push(
        `Top-level command "${pathKey}" appears in multiple landing page categories: ${categoryTitles.join(
          ', '
        )}.`
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(`CLI reference validation failed:\n- ${errors.join('\n- ')}`);
  }
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function frontmatter(title: string, description: string): string {
  return `---\ntitle: ${yamlString(title)}\ndescription: ${yamlString(description)}\n---\n\n`;
}

function fallbackIntro(description: string): string {
  return /[.!?]$/.test(description) ? description : `${description}.`;
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

function choices(values: readonly string[] | undefined): string {
  return values && values.length > 0 ? values.join(', ') : '-';
}

function defaultValue(option: Option): string {
  if (option.defaultValue === undefined) {
    return '-';
  }
  return String(option.defaultValue);
}

function argumentToken(argument: Argument): string {
  const name = argument.name();
  const suffix = argument.variadic ? '...' : '';
  return argument.required ? `<${name}${suffix}>` : `[${name}${suffix}]`;
}

function renderArguments(command: Command): string {
  const rows =
    command.registeredArguments.length === 0
      ? [['None', '-', '-', '-']]
      : command.registeredArguments.map((argument) => [
          argumentToken(argument),
          argument.required ? 'yes' : 'no',
          argument.description || '-',
          choices(argument.argChoices),
        ]);

  return `## Arguments\n\n${table(['Argument', 'Required', 'Description', 'Choices'], rows)}\n`;
}

function optionValue(option: Option): string {
  const longFlag = option.flags
    .split(',')
    .map((flag) => flag.trim())
    .find((flag) => flag.startsWith('--'));
  const valueMatch = longFlag?.match(/(<[^>]+>|\[[^\]]+\])$/);
  return valueMatch?.[1] ?? '-';
}

function renderFlags(command: Command): string {
  const rows =
    command.options.length === 0
      ? [['None', '-', '-', '-', '-', '-']]
      : command.options.map((option) => [
          option.long ?? '-',
          option.short ?? '-',
          optionValue(option),
          defaultValue(option),
          option.description || '-',
          choices(option.argChoices),
        ]);

  return `## Flags\n\n${table(['Long', 'Short', 'Value', 'Default', 'Description', 'Choices'], rows)}\n`;
}

function renderExamples(extras: CommandExtras): string {
  return [
    '## Examples',
    '',
    ...extras.examples.flatMap((example) => [
      example.caption,
      '',
      '```sh',
      example.command,
      '```',
      '',
    ]),
  ].join('\n');
}

function renderExitCodes(extras: CommandExtras): string {
  return `## Exit Codes\n\n${table(
    ['Code', 'When'],
    extras.exitCodes.map((exitCode) => [String(exitCode.code), exitCode.when])
  )}\n`;
}

function renderConstraints(extras: CommandExtras): string {
  if (!extras.constraints || extras.constraints.length === 0) {
    return '';
  }

  return [
    '## Constraints',
    '',
    ...extras.constraints.map((constraint) => `- ${constraint}`),
    '',
  ].join('\n');
}

function renderSynopsis(leaf: LeafInfo): string {
  const args = leaf.command.registeredArguments.map(argumentToken);
  const tokens = ['Usage:', commandTitle(leaf.pathSegments)];
  if (leaf.command.options.length > 0) {
    tokens.push('[options]');
  }
  tokens.push(...args);
  return tokens.join(' ');
}

function renderAliases(leaf: LeafInfo): string {
  const aliases = leaf.command.aliases();
  if (aliases.length === 0) {
    return '';
  }

  const parentPath = leaf.pathSegments.slice(0, -1);
  const aliasCommands = aliases.map((alias) => commandTitle([...parentPath, alias]));
  return `Aliases: ${aliasCommands.join(', ')}\n\n`;
}

export function renderLeafPage(leaf: LeafInfo, extras: CommandExtras): string {
  const title = commandTitle(leaf.pathSegments);
  return (
    frontmatter(title, `${title} - ${leaf.description}`) +
    `# ${title}\n\n` +
    `${renderSynopsis(leaf)}\n\n` +
    renderAliases(leaf) +
    `${leaf.description}\n\n` +
    renderArguments(leaf.command) +
    '\n' +
    renderFlags(leaf.command) +
    '\n' +
    renderExamples(extras) +
    '\n' +
    renderExitCodes(extras) +
    '\n' +
    renderConstraints(extras)
  );
}

function renderLandingPage(model: ReferenceModel): string {
  const leafMap = new Map(model.leaves.map((leaf) => [commandPath(leaf.pathSegments), leaf]));
  const sections = categoryMap
    .map((category) => {
      const rows = category.commands.flatMap((pathKey) => {
        const leaf = leafMap.get(pathKey);
        return leaf
          ? [`- [shipper ${pathKey}](${linkForPath(leaf.pathSegments)}) - ${leaf.description}`]
          : [];
      });
      return [`## ${category.title}`, '', ...rows, ''].join('\n');
    })
    .join('\n');

  const groupRows = model.groups.map((group) => {
    const pathKey = commandPath(group.pathSegments);
    return `- [shipper ${pathKey}](./${pathKey}/) - ${groups[pathKey]?.description ?? group.description}`;
  });

  return (
    frontmatter('CLI', landingDescription) +
    `# CLI\n\n${landingIntro}\n\n` +
    sections +
    '\n## Groups\n\n' +
    groupRows.join('\n') +
    '\n'
  );
}

function renderGroupPage(group: GroupInfo): string {
  const pathKey = commandPath(group.pathSegments);
  const groupExtras = groups[pathKey];
  const groupDescription = groupExtras?.description ?? group.description;
  const pageDescription = groupExtras?.pageDescription ?? groupDescription;
  const intro = groupExtras?.intro ?? fallbackIntro(groupDescription);
  const rows = group.children.map((child) => {
    const childPath = commandPath(child.pathSegments);
    if (child.kind === 'group') {
      const relativePath = child.pathSegments.slice(group.pathSegments.length).join('/');
      const description = groups[childPath]?.description ?? child.description;
      return `- [shipper ${childPath}](./${relativePath}/) - ${description}`;
    }

    const childName = child.pathSegments.at(-1) ?? childPath;
    return `- [shipper ${childPath}](./${childName}) - ${child.description}`;
  });

  return (
    frontmatter(`shipper ${pathKey}`, pageDescription) +
    `# shipper ${pathKey}\n\n${intro}\n\n` +
    rows.join('\n') +
    '\n'
  );
}

async function writeGeneratedTree(baseDir: string, model: ReferenceModel): Promise<void> {
  await writeFile(path.join(baseDir, 'index.md'), renderLandingPage(model));

  for (const group of model.groups) {
    const outputPath = groupOutputPath(baseDir, group.pathSegments);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, renderGroupPage(group));
  }

  for (const leaf of model.leaves) {
    const pathKey = commandPath(leaf.pathSegments);
    const extras = commandExtras[pathKey as CommandPath];
    const outputPath = leafOutputPath(baseDir, leaf.pathSegments);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, renderLeafPage(leaf, extras));
  }
}

function formatGeneratedTree(baseDir: string, root: string): void {
  const prettierBin = [root, repoRoot()]
    .map((candidate) => path.join(candidate, 'node_modules/prettier/bin/prettier.cjs'))
    .find((candidate) => existsSync(candidate));
  if (!prettierBin) {
    throw new Error(`Prettier binary not found. Run npm install first.`);
  }
  const prettierConfig = [root, repoRoot()]
    .map((candidate) => path.join(candidate, '.prettierrc'))
    .find((candidate) => existsSync(candidate));
  if (!prettierConfig) {
    throw new Error(`Prettier config not found.`);
  }

  const result = spawnSync(
    process.execPath,
    [prettierBin, '--config', prettierConfig, '--write', baseDir],
    {
      encoding: 'utf8',
    }
  );

  if (result.status !== 0) {
    throw new Error(`Failed to format generated CLI reference.\n${result.stdout}${result.stderr}`);
  }
}

export async function generateCliReference(root = repoRoot()): Promise<void> {
  const model = discoverReferenceModel(createProgram());
  validateReferenceModel(model);

  const outputDir = cliReferenceDir(root);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeGeneratedTree(outputDir, model);
  formatGeneratedTree(outputDir, root);
  await rm(oldCliReferenceFile(root), { force: true });
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
    {
      encoding: 'utf8',
    }
  );

  if (result.error) {
    return `Failed to run git diff: ${result.error.message}`;
  }

  return [result.stdout, result.stderr].filter(Boolean).join('');
}

export async function checkCliReference(root = repoRoot()): Promise<void> {
  const model = discoverReferenceModel(createProgram());
  validateReferenceModel(model);

  const tempRoot = await mkdtemp(path.join(tmpdir(), 'shipper-cli-reference-'));
  try {
    const tempDir = path.join(tempRoot, 'cli');
    await mkdir(tempDir, { recursive: true });
    await writeGeneratedTree(tempDir, model);
    formatGeneratedTree(tempDir, root);

    const outputDir = cliReferenceDir(root);
    const oldFile = oldCliReferenceFile(root);
    const oldFileExists = existsSync(oldFile);
    const matches = !oldFileExists && (await treesMatch(outputDir, tempDir));

    if (!matches) {
      const messages = oldFileExists
        ? [`Unexpected hand-written CLI reference remains at ${oldFile}.\n`]
        : [];
      const diff = unifiedDiff(outputDir, tempDir);
      throw new Error([...messages, diff, REMEDIATION_LINE].filter(Boolean).join('\n'));
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
