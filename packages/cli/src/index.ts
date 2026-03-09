import { Command, CommanderError } from 'commander';
import { writeSync } from 'node:fs';
import { runPreflight } from '@dnsquared/shipper-core';
import { loadSettings } from '@dnsquared/shipper-core';
import { CLI_VERSION, checkVersionFreshness } from '@dnsquared/shipper-core';
import { initCommand } from './commands/init.js';
import { newCommand } from './commands/new.js';
import { adoptCommand, adoptAllCommand } from './commands/adopt.js';
import { groomCommand } from './commands/groom.js';
import { designCommand } from './commands/design.js';
import { planCommand } from './commands/plan.js';
import { nextCommand } from './commands/next.js';
import { shipCommand } from './commands/ship.js';
import { implementCommand } from './commands/implement.js';
import { ejectCommand } from './commands/eject.js';
import { prReviewCommand } from './commands/pr-review.js';
import { prOpenCommand } from './commands/pr-open.js';
import { prRemediateCommand } from './commands/pr-remediate.js';
import { mergeCommand } from './commands/merge.js';
import { resetCommand } from './commands/reset.js';
import { unblockCommand } from './commands/unblock.js';
import { unlockCommand } from './commands/unlock.js';
import { issueListCommand } from './commands/issue-list.js';
import { setupCommand } from './commands/setup.js';

const program = new Command();

program.configureOutput({
  outputError: (str, write) => {
    if (str.includes("option '--parallel <n>' argument missing")) {
      return;
    }
    write(str);
  },
});

program
  .name('shipper')
  .description('CLI tool for automating development workflow with coding agents')
  .version(CLI_VERSION);

program.hook('preAction', async (_thisCommand, actionCommand) => {
  if (actionCommand.name() === 'init' || actionCommand.name() === 'setup') return;
  await loadSettings();
  checkVersionFreshness();
  await runPreflight();
});

program
  .command('init')
  .description('Initialize shipper in the current repository')
  .option('--agent <name>', 'coding agent to use (claude or codex)')
  .action(async (options: { agent?: string }) => {
    await initCommand(options);
  });

program
  .command('setup [words...]')
  .description('Configure repository settings with an agent')
  .action(async (words: string[]) => {
    await setupCommand(words);
  });

program
  .command('new')
  .description('Create a new issue from a pitch')
  .argument('<pitch...>', 'your idea for the new issue')
  .option('--headless', 'skip clarifying questions and create issue directly', false)
  .action(async (pitch: string[], options: { headless: boolean }) => {
    await newCommand(pitch, options);
  });

program
  .command('adopt')
  .description('Adopt an existing issue into the shipper workflow')
  .argument('[issue]', 'issue number')
  .option('--all', 'adopt all open issues without shipper labels', false)
  .action((issue: string | undefined, options: { all: boolean }) => {
    if (options.all && issue) {
      console.error('Error: --all and an explicit issue number are mutually exclusive.');
      process.exit(1);
    }
    if (!options.all && !issue) {
      console.error('Error: an issue number is required unless --all is used.');
      process.exit(1);
    }
    if (options.all) {
      adoptAllCommand();
    } else {
      adoptCommand(issue as string);
    }
  });

program
  .command('next')
  .description('Advance an issue to the next workflow step')
  .argument('<ref>', 'issue or PR number/URL')
  .action(async (ref: string) => {
    await nextCommand(ref);
  });

program
  .command('ship')
  .description('Run the full workflow end-to-end')
  .argument('[issue]', 'issue number')
  .option('--merge', 'auto-merge the PR after reaching shipper:ready', false)
  .option('--auto', 'run autonomous continuous shipping loop', false)
  .option('--parallel <n>', 'number of parallel slots (requires --auto)')
  .action(
    async (
      issue: string | undefined,
      options: { merge: boolean; auto: boolean; parallel?: string }
    ) => {
      if (options.auto && issue) {
        console.error('Error: --auto and an explicit issue number are mutually exclusive.');
        process.exit(1);
      }
      if (!options.auto && !issue) {
        console.error('Error: an issue number is required unless --auto is used.');
        process.exit(1);
      }

      if (options.parallel !== undefined && !options.auto) {
        console.error('Error: --parallel requires --auto');
        process.exit(1);
      }

      let parallel: number | undefined;
      if (options.parallel !== undefined) {
        parallel = Number(options.parallel);
        if (!Number.isInteger(parallel) || parallel < 1) {
          console.error('Error: --parallel requires a number');
          process.exit(1);
        }
        if (parallel === 1) {
          parallel = undefined;
        }
      }

      await shipCommand(issue, { merge: options.merge, auto: options.auto, parallel });
    }
  );

program
  .command('groom')
  .description('Groom an existing issue')
  .argument('[issue]', 'issue number or URL')
  .option('--auto', 'groom all eligible shipper:new issues in sequence', false)
  .action(async (issue: string | undefined, options: { auto: boolean }) => {
    if (options.auto && issue) {
      console.error('Error: --auto and an explicit issue number are mutually exclusive.');
      process.exit(1);
    }
    await groomCommand(issue, options);
  });

program
  .command('design')
  .description('Run technical design review on an issue')
  .argument('[issue]', 'issue number or URL')
  .action(async (issue?: string) => {
    await designCommand(issue);
  });

program
  .command('plan')
  .description('Create an implementation plan for an issue')
  .argument('[issue]', 'issue number or URL')
  .action(async (issue?: string) => {
    await planCommand(issue);
  });

program
  .command('implement')
  .description('Implement an issue in a worktree')
  .argument('[issue]', 'issue number or URL')
  .action(async (issue?: string) => {
    await implementCommand(issue);
  });

program
  .command('eject')
  .description('Scaffold prompt overrides for customization')
  .argument('[name]', 'prompt name to eject (e.g. groom, pr-open)')
  .action((name?: string) => {
    ejectCommand(name);
  });

program
  .command('reset')
  .description('Reset an issue back to an earlier workflow stage')
  .argument('<issue>', 'issue number')
  .option('-f, --force', 'skip confirmation prompt')
  .option('--to <stage>', 'reset to a specific workflow stage')
  .action(async (issue: string, opts: { force: boolean; to?: string }) => {
    await resetCommand(issue, opts);
  });

program
  .command('unblock')
  .description('Check if a blocked issue can proceed')
  .argument('<issue>', 'issue number')
  .action(async (issue: string) => {
    await unblockCommand(issue);
  });

program
  .command('unlock')
  .description('Force-release the lock on an issue')
  .argument('<issue>', 'issue number')
  .action(async (issue: string) => {
    await unlockCommand(issue);
  });

const issue = program.command('issue').description('Issue commands');

issue
  .command('list')
  .description('List shipper-managed issues by pipeline status')
  .option('--status <name>', 'filter to a single status (e.g. planned)')
  .action((options: { status?: string }) => {
    issueListCommand(options);
  });

const pr = program.command('pr').description('Pull request commands');

pr.command('review')
  .description('Review a pull request')
  .argument('[pr]', 'PR number or URL')
  .action(async (prArg?: string) => {
    await prReviewCommand(prArg);
  });

pr.command('open')
  .description('Open a pull request for an implemented issue')
  .argument('[issue]', 'issue number or URL')
  .action(async (issue?: string) => {
    await prOpenCommand(issue);
  });

pr.command('remediate')
  .description('Remediate a pull request after review feedback')
  .argument('[pr]', 'PR number or URL')
  .action(async (prArg?: string) => {
    await prRemediateCommand(prArg);
  });

program
  .command('merge')
  .description('Run the merge queue for PRs labeled shipper:ready')
  .argument('[number]', 'PR or issue number to merge')
  .option('--interval <seconds>', 'polling interval in seconds', '60')
  .option('--once', 'process the queue once and exit', false)
  .option('--dry-run', 'print actions without executing', false)
  .option('--repo <owner/repo>', 'repository (default: inferred from cwd)')
  .action(
    async (
      number: string | undefined,
      options: { interval: string; once: boolean; dryRun: boolean; repo?: string }
    ) => {
      await mergeCommand({ ...options, number });
    }
  );

program.exitOverride();

const argv = process.argv.slice(2);
if (argv[0] === 'ship') {
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] !== '--parallel') continue;

    const next = argv[i + 1];
    if (!next || next.startsWith('-')) {
      console.error('Error: --parallel requires a number');
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
      process.exit(1);
    }

    process.exit(error.exitCode);
  }

  throw error;
}
