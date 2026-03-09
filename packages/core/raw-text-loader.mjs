import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';

export async function load(url, context, nextLoad) {
  if (url.endsWith('.md') || url.endsWith('.sh')) {
    const source = await readFile(new URL(url), 'utf8');

    return {
      format: 'module',
      shortCircuit: true,
      source: `export default ${JSON.stringify(source)};`,
    };
  }

  return nextLoad(url, context);
}
