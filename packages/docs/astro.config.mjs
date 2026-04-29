import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://shipper.baremetallabs.ai',
  integrations: [
    starlight({
      title: 'Shipper',
      pagefind: false,
    }),
  ],
});
