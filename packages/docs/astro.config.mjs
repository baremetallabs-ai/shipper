import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://shipper.baremetallabs.ai',
  integrations: [
    sitemap(),
    starlight({
      title: 'Shipper',
      pagefind: false,
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
      ],
    }),
  ],
});
