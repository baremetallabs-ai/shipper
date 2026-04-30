import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import { createProgram } from '../../src/program.js';
import { commandExtras, groups, type CommandExtras } from '../../src/docs/command-extras.js';
import {
  REMEDIATION_LINE,
  checkCliReference,
  discoverReferenceModel,
  generateCliReference,
  renderLeafPage,
  validateReferenceModel,
} from '../../src/docs/cli-reference-generator.js';

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'shipper-cli-docs-test-'));
  tempRoots.push(tempRoot);
  return tempRoot;
}

function findLeaf(pathKey: string) {
  const model = discoverReferenceModel(createProgram());
  const leaf = model.leaves.find((candidate) => candidate.pathSegments.join(' ') === pathKey);
  if (!leaf) {
    throw new Error(`Missing leaf ${pathKey}`);
  }
  return leaf;
}

describe('cli reference generator', () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((tempRoot) => rm(tempRoot, { recursive: true })));
  });

  it('fails validation when a leaf command is missing extras', () => {
    const model = discoverReferenceModel(createProgram());
    const extras: Record<string, CommandExtras> = { ...commandExtras };
    delete extras.init;

    expect(() => {
      validateReferenceModel(model, extras, groups);
    }).toThrow('Command "init" is missing docs extras.');
  });

  it('fails validation when extras contain a stale command path', () => {
    const model = discoverReferenceModel(createProgram());
    const extras: Record<string, CommandExtras> = {
      ...commandExtras,
      stale: commandExtras.init,
    };

    expect(() => {
      validateReferenceModel(model, extras, groups);
    }).toThrow('Docs extras reference unknown command "stale".');
  });

  it('fails validation when a command or group has an empty description', () => {
    const program = new Command();
    const group = program.command('group').description('');
    group.command('leaf').description('Leaf description');
    const model = discoverReferenceModel(program);

    expect(() => {
      validateReferenceModel(
        model,
        { 'group leaf': commandExtras.init },
        { group: { description: 'Group description' } }
      );
    }).toThrow('Command group "group" is missing a description.');
  });

  it('renders a command page with required section order from Commander metadata', () => {
    const leaf = findLeaf('priority');
    const rendered = renderLeafPage(leaf, commandExtras.priority);
    const body = rendered.slice(rendered.indexOf('# shipper priority'));
    const orderedSnippets = [
      'Usage: shipper priority <issue> <level>',
      'Set priority on an issue',
      '## Arguments',
      '| <issue> |',
      '| <level> |',
      'high, normal, low',
      '## Flags',
      '## Examples',
      'shipper priority 42 high',
      '## Exit Codes',
    ];

    let previousIndex = -1;
    for (const snippet of orderedSnippets) {
      const nextIndex = body.indexOf(snippet);
      expect(nextIndex).toBeGreaterThan(previousIndex);
      previousIndex = nextIndex;
    }
  });

  it('renders setup aliases inline and does not generate an alias page', async () => {
    const leaf = findLeaf('setup');
    const rendered = renderLeafPage(leaf, commandExtras.setup);
    const tempRoot = await makeTempRoot();

    await generateCliReference(tempRoot);

    expect(rendered).toContain('Aliases: shipper agent');
    expect(
      existsSync(path.join(tempRoot, 'packages/docs/src/content/docs/reference/cli/agent.md'))
    ).toBe(false);
  });

  it('reports drift with a diff and remediation line', async () => {
    const tempRoot = await makeTempRoot();
    await generateCliReference(tempRoot);
    const initPath = path.join(tempRoot, 'packages/docs/src/content/docs/reference/cli/init.md');
    const original = await readFile(initPath, 'utf8');
    await writeFile(initPath, `${original}\nStale edit.\n`);

    await expect(checkCliReference(tempRoot)).rejects.toThrow(REMEDIATION_LINE);
    await expect(checkCliReference(tempRoot)).rejects.toThrow('diff --git');
  });
});
