import { defineConfig } from 'astro/config';
import mermaid from 'astro-mermaid';
import sitemap from '@astrojs/sitemap';
import starlight from '@astrojs/starlight';
import starlightLlmsTxt from 'starlight-llms-txt';

export default defineConfig({
  site: 'https://shipper.baremetallabs.ai',
  integrations: [
    mermaid(),
    sitemap(),
    starlight({
      title: 'Shipper',
      pagefind: true,
      plugins: [
        starlightLlmsTxt({
          customSets: [
            {
              label: 'Agents',
              paths: ['agents/**'],
              description: 'Agent-facing setup and operating notes for Shipper repositories.',
            },
          ],
          promote: ['agents/**', 'start-here/**', 'concepts/**', 'index*'],
          exclude: ['index', 'guides/**', 'reference/**', 'agents/cookbook/**'],
        }),
      ],
      sidebar: [
        {
          label: 'Start Here',
          items: [
            { label: 'Introduction', slug: 'start-here/introduction' },
            { label: 'Getting Started', slug: 'start-here/getting-started' },
          ],
        },
        {
          label: 'Concepts',
          items: [
            { label: 'Architecture', slug: 'concepts/architecture' },
            { label: 'State Machine', slug: 'concepts/state-machine' },
            { label: 'Protocol', slug: 'concepts/protocol' },
            { label: 'Versioning', slug: 'concepts/versioning' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'CLI', autogenerate: { directory: 'reference/cli' } },
            { label: 'MCP', autogenerate: { directory: 'reference/mcp' } },
            { label: 'Settings', slug: 'reference/settings' },
            { label: 'Containers', slug: 'reference/containers' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Recipes', slug: 'guides/recipes' },
            { label: 'Desktop', slug: 'guides/desktop' },
          ],
        },
        {
          label: 'Troubleshooting',
          items: [{ label: 'Common Errors', slug: 'troubleshooting/common-errors' }],
        },
        {
          label: 'Agents',
          items: [
            { label: 'Setup', slug: 'agents/setup' },
            {
              label: 'Cookbook',
              items: [
                { label: 'Overview', slug: 'agents/cookbook' },
                { label: 'Switch coding agents', slug: 'agents/cookbook/switch-coding-agent' },
                { label: 'Eject a prompt', slug: 'agents/cookbook/eject-prompt' },
                { label: 'Configure hooks', slug: 'agents/cookbook/configure-hooks' },
                { label: 'Override settings', slug: 'agents/cookbook/override-settings' },
              ],
            },
          ],
        },
      ],
    }),
  ],
});
