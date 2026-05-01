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
    const corpus = await readFile(smallCorpusPath, 'utf8');

    const presentHeadings = [
      'Repository setup for agents',
      'Getting Started',
      'Introduction',
      'Architecture',
      'Protocol',
      'State Machine',
      'Versioning',
    ];

    const absentHeadings = [
      'Shipper',
      'Settings',
      'Containers',
      'CLI',
      'shipper adopt',
      'shipper design',
      'shipper eject',
      'shipper groom',
      'shipper implement',
      'shipper init',
      'shipper issue',
      'shipper issue list',
      'shipper merge',
      'shipper new',
      'shipper next',
      'shipper plan',
      'shipper pr',
      'shipper pr open',
      'shipper pr remediate',
      'shipper pr review',
      'shipper priority',
      'shipper reset',
      'shipper setup',
      'shipper ship',
      'shipper unblock',
      'shipper unlock',
      'MCP',
      'shipper_adopt',
      'shipper_advance',
      'shipper_answer_question',
      'shipper_create_issue',
      'shipper_docs_get',
      'shipper_docs_search',
      'shipper_get_issue',
      'shipper_get_pr_checks',
      'shipper_groom',
      'shipper_list_issues',
      'shipper_merge',
      'shipper_reset',
      'shipper_unblock',
      'shipper_unlock',
      'Recipes',
      'Desktop',
      'Agent cookbook',
      'Configure hooks',
      'Eject a prompt',
      'Override settings',
      'Switch coding agents',
    ];

    for (const heading of presentHeadings) {
      expect(corpus).toContain(pageHeadingMarker(heading));
    }

    for (const heading of absentHeadings) {
      expect(corpus).not.toContain(pageHeadingMarker(heading));
    }
  });
});
