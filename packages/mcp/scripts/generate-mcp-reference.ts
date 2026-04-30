import { checkMcpReference, generateMcpReference } from '../src/docs/mcp-reference-generator.js';

const check = process.argv.includes('--check');

try {
  if (check) {
    await checkMcpReference();
  } else {
    await generateMcpReference();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
