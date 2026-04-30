import { checkCliReference, generateCliReference } from '../src/docs/cli-reference-generator.js';

const check = process.argv.includes('--check');

try {
  if (check) {
    await checkCliReference();
  } else {
    await generateCliReference();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
