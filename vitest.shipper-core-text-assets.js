import { readFile } from 'node:fs/promises';

const textAssetPattern = /\.(md|sh)$/;

export function shipperCoreTextAssetsPlugin() {
  return {
    name: 'shipper-core-text-assets',
    async load(id) {
      if (!textAssetPattern.test(id)) {
        return null;
      }

      const source = await readFile(id, 'utf8');
      return `export default ${JSON.stringify(source)};`;
    },
  };
}
