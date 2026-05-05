import { CommanderError } from 'commander';
import { writeSync } from 'node:fs';
import { logger } from '@baremetallabs-ai/shipper-core';
import { createProgram } from './program.js';

const program = createProgram();

program.exitOverride();

const argv = process.argv.slice(2);
if (argv[0] === 'ship') {
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] !== '--parallel') continue;

    const next = argv[i + 1];
    if (!next || next.startsWith('-')) {
      logger.error('Error: --parallel requires a number');
      // Intentional: pre-parse validation runs before Commander action handlers and cannot use wrapAction().
      process.exit(1);
    }
  }
}

try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof CommanderError) {
    if (error.code === 'commander.optionMissingArgument' && error.message.includes('--parallel')) {
      writeSync(process.stderr.fd, 'Error: --parallel requires a number\n');
      // Intentional: Commander parse errors happen outside wrapAction() and must terminate here.
      process.exit(1);
    }

    // Intentional: preserve Commander-managed exit codes for help and usage failures.
    process.exit(error.exitCode);
  }

  throw error;
}
