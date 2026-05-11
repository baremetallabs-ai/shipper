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

  it('fails validation when a top-level command is missing from the landing categories', () => {
    const program = createProgram();
    program.command('doctor').description('Diagnose the local Shipper environment');
    const model = discoverReferenceModel(program);
    const extras: Record<string, CommandExtras> = {
      ...commandExtras,
      doctor: commandExtras.init,
    };

    expect(() => {
      validateReferenceModel(model, extras, groups);
    }).toThrow('Top-level command "doctor" is missing from the landing page category map.');
  });

  it('fails validation when a top-level command appears in multiple landing categories', () => {
    const model = discoverReferenceModel(createProgram());

    expect(() => {
      validateReferenceModel(model, commandExtras, groups, [
        { title: 'First', commands: ['init', 'setup'] },
        { title: 'Second', commands: ['init'] },
      ]);
    }).toThrow('Top-level command "init" appears in multiple landing page categories');
  });

  it('fails validation when group descriptions are stale or empty', () => {
    const model = discoverReferenceModel(createProgram());

    expect(() => {
      validateReferenceModel(model, commandExtras, {
        ...groups,
        stale: { description: 'Stale group' },
      });
    }).toThrow('Docs group descriptions reference unknown command group "stale".');

    expect(() => {
      validateReferenceModel(model, commandExtras, {
        ...groups,
        pr: { description: '' },
      });
    }).toThrow('Docs group description for "pr" is empty.');

    expect(() => {
      validateReferenceModel(model, commandExtras, {
        ...groups,
        pr: { ...groups.pr, pageDescription: '' },
      });
    }).toThrow('Docs group page description for "pr" is empty.');

    expect(() => {
      validateReferenceModel(model, commandExtras, {
        ...groups,
        pr: { ...groups.pr, intro: '' },
      });
    }).toThrow('Docs group intro for "pr" is empty.');
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

  it('renders subgroup landing metadata without changing parent rows or child rows', async () => {
    const tempRoot = await makeTempRoot();
    await generateCliReference(tempRoot);

    const cliDir = path.join(tempRoot, 'packages/docs/src/content/docs/reference/cli');
    const [index, prIndex, issueIndex] = await Promise.all([
      readFile(path.join(cliDir, 'index.md'), 'utf8'),
      readFile(path.join(cliDir, 'pr/index.md'), 'utf8'),
      readFile(path.join(cliDir, 'issue/index.md'), 'utf8'),
    ]);

    const prIntro =
      '`shipper pr` covers the pull request side of the label-driven workflow: ' +
      '`shipper pr open` runs when an issue reaches `shipper:implemented`, `shipper pr review` ' +
      'runs when an issue reaches `shipper:pr-open`, and `shipper pr remediate` runs when an ' +
      'issue reaches `shipper:pr-reviewed`. Most users invoke these through `shipper next` or ' +
      '`shipper ship`, which dispatch the correct subcommand from the current workflow label; ' +
      'see the [state machine](/concepts/state-machine/) for the full transition table.';
    const issueIntro =
      '`shipper issue` is the read-only inspection cluster for shipper-managed issues: it ' +
      'surfaces workflow state (including `--status` short names such as `planned` and ' +
      '`implemented`) without advancing labels, leaving future read/inspect subcommands in the ' +
      'same group.';

    expect(index).toContain('- [shipper issue](./issue/) - Issue commands');
    expect(index).toContain('- [shipper pr](./pr/) - Pull request commands');

    expect(prIndex).toContain(
      "description: 'Follow pull request workflow stages from implemented issue through review and remediation.'"
    );
    expect(prIndex).toContain(`# shipper pr\n\n${prIntro}\n\n`);
    expect(prIndex).toContain('/concepts/state-machine/');
    expect(prIndex).toContain('- [shipper pr review](./review) - Review a pull request');
    expect(prIndex).toContain(
      '- [shipper pr open](./open) - Open a pull request for an implemented issue'
    );
    expect(prIndex).toContain(
      '- [shipper pr remediate](./remediate) - Remediate a pull request after review feedback'
    );

    expect(issueIndex).toContain(
      "description: 'Inspect shipper-managed issues by workflow state without advancing the pipeline.'"
    );
    expect(issueIndex).toContain(`# shipper issue\n\n${issueIntro}\n\n`);
    expect(issueIndex).not.toContain('/concepts/state-machine/');
    expect(issueIndex).toContain(
      '- [shipper issue list](./list) - List shipper-managed issues by pipeline status'
    );
  });

  it('does not double-punctuate fallback group intros', async () => {
    const tempRoot = await makeTempRoot();
    const originalPrGroup = groups.pr;
    groups.pr = { description: 'Pull request commands.' };

    try {
      await generateCliReference(tempRoot);

      const prIndex = await readFile(
        path.join(tempRoot, 'packages/docs/src/content/docs/reference/cli/pr/index.md'),
        'utf8'
      );

      expect(prIndex).toContain('# shipper pr\n\nPull request commands.\n\n');
      expect(prIndex).not.toContain('Pull request commands..');
    } finally {
      groups.pr = originalPrGroup;
    }
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
