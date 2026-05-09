import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const docsRoot = fileURLToPath(new URL('..', import.meta.url));
const smallCorpusPath = path.join(docsRoot, 'dist/llms-small.txt');

function pageHeadingMarker(heading: string): string {
  return `# ${heading}\n\n>`;
}

describe('llms-small corpus', () => {
  it('contains the small docs slice and excludes reference, guide, splash, and cookbook pages', async () => {
    const corpus = (await readFile(smallCorpusPath, 'utf8')).replace(/\r\n/g, '\n');

    const expectedPages = [
      {
        slug: 'agents/setup',
        heading: 'Repository setup for agents',
        description: 'Configure a repository so any coding agent can run Shipper reliably.',
      },
      {
        slug: 'agents/supported-coding-agents',
        heading: 'Supported coding agents',
        description:
          'Agent-specific setup facts for Claude Code, Codex CLI, and GitHub Copilot CLI.',
      },
      {
        slug: 'start-here/getting-started',
        heading: 'Getting Started',
        description:
          'Set up prerequisites, initialize a repository, and run the first Shipper workflow commands.',
      },
      {
        slug: 'start-here/introduction',
        heading: 'Introduction',
        description:
          "Overview of Shipper's GitHub-backed workflow and the docs paths to read first.",
      },
      {
        slug: 'concepts/architecture',
        heading: 'Architecture',
        description:
          'How Shipper CLI, core, desktop, MCP, worktrees, prompts, and GitHub labels fit together.',
      },
      {
        slug: 'concepts/protocol',
        heading: 'Protocol',
        description:
          'Agent execution contract covering prompt resolution, result verdicts, label transitions, and MCP loading.',
      },
      {
        slug: 'concepts/state-machine',
        heading: 'State Machine',
        description:
          'GitHub labels, transitions, rollback paths, and auto-ship ordering for Shipper workflow state.',
      },
      {
        slug: 'concepts/versioning',
        heading: 'Versioning',
        description: 'How Shipper versions itself and these docs.',
      },
      {
        slug: 'troubleshooting/common-errors',
        heading: 'Common Errors',
        description:
          'Diagnose common Shipper failures and choose the right recovery command or setting.',
      },
    ];

    const excludedPages = [
      {
        slug: 'index',
        heading: 'Shipper',
        description:
          'A GitHub-native workflow conductor for human-led, AI-assisted software delivery.',
      },
      {
        slug: 'reference/settings',
        heading: 'Settings',
        description:
          'Configuration file shape and precedence for Shipper defaults, commands, agents, and locks.',
      },
      {
        slug: 'reference/containers',
        heading: 'Containers',
        description:
          'Container and CI environment requirements for running Shipper with GitHub authentication.',
      },
      {
        slug: 'reference/cli',
        heading: 'CLI',
        description: 'Generated reference for Shipper command-line entry points and options.',
      },
      {
        slug: 'reference/mcp',
        heading: 'MCP',
        description: 'Generated reference for Shipper MCP tools and result contracts.',
      },
      {
        slug: 'guides/recipes',
        heading: 'Recipes',
        description: 'Operational recipes for Shipper setup, customization, and recovery.',
      },
      {
        slug: 'guides/desktop',
        heading: 'Desktop',
        description:
          "Install and use Shipper's supported macOS desktop app for GitHub-backed workflows.",
      },
      {
        slug: 'agents/cookbook',
        heading: 'Agent cookbook',
        description: 'Common agent-facing operating recipes for Shipper-managed repositories.',
      },
      {
        slug: 'agents/cookbook/configure-hooks',
        heading: 'Configure hooks',
        description: 'Agent recipe for configuring project hooks around Shipper workflows.',
      },
      {
        slug: 'agents/cookbook/eject-prompt',
        heading: 'Eject a prompt',
        description: 'Agent recipe for copying and customizing bundled Shipper prompts.',
      },
      {
        slug: 'agents/cookbook/override-settings',
        heading: 'Override settings',
        description: 'Agent recipe for changing Shipper settings safely.',
      },
      {
        slug: 'agents/cookbook/switch-coding-agent',
        heading: 'Switch coding agents',
        description: 'Agent recipe for changing which coding agent Shipper invokes.',
      },
    ];

    for (const page of expectedPages) {
      expect(corpus, page.slug).toContain(pageHeadingMarker(page.heading));
      expect(corpus, page.slug).toContain(`> ${page.description}`);
    }

    const pageCount = corpus.match(/^# .+\n\n>/gm)?.length ?? 0;
    expect(pageCount).toBe(expectedPages.length);

    for (const page of excludedPages) {
      expect(corpus, page.slug).not.toContain(pageHeadingMarker(page.heading));
      expect(corpus, page.slug).not.toContain(`> ${page.description}`);
    }
  });
});
