import { Command } from 'commander';
import { runPreflight } from './lib/prerequisites.js';
import { loadSettings } from './lib/settings.js';
import { initCommand } from './commands/init.js';
import { newCommand } from './commands/new.js';
import { adoptCommand, adoptAllCommand } from './commands/adopt.js';
import { groomCommand } from './commands/groom.js';
import { designCommand } from './commands/design.js';
import { planCommand } from './commands/plan.js';
import { nextCommand } from './commands/next.js';
import { shipCommand } from './commands/ship.js';
import { implementCommand } from './commands/implement.js';
import { prReviewCommand } from './commands/pr-review.js';
import { prOpenCommand } from './commands/pr-open.js';
import { prRemediateCommand } from './commands/pr-remediate.js';
import { mergeCommand } from './commands/merge.js';
import { resetCommand } from './commands/reset.js';
import { unblockCommand } from './commands/unblock.js';
import { unlockCommand } from './commands/unlock.js';
import { issueListCommand } from './commands/issue-list.js';

const program = new Command();

program
  .name('shipper')
  .description('CLI tool for automating development workflow with coding agents')
  .version(process.env.SHIPPER_VERSION ?? '0.0.0-dev');

program.hook('preAction', (_thisCommand, actionCommand) => {
  if (actionCommand.name() === 'init') return;
  loadSettings();
  runPreflight();
});

program
  .command('init')
  .description('Initialize shipper in the current repository')
  .option('--agent <name>', 'coding agent to use (claude or codex)')
  .action(async (options: { agent?: string }) => {
    await initCommand(options);
  });

program
  .command('new')
  .description('Create a new issue from a pitch')
  .argument('<pitch...>', 'your idea for the new issue')
  .action((pitch: string[]) => {
    newCommand(pitch);
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
  .action((ref: string) => {
    nextCommand(ref);
  });

program
  .command('ship')
  .description('Run the full workflow end-to-end')
  .argument('[issue]', 'issue number')
  .option('--merge', 'auto-merge the PR after reaching shipper:ready', false)
  .option('--auto', 'run autonomous continuous shipping loop', false)
  .action((issue: string | undefined, options: { merge: boolean; auto: boolean }) => {
    if (options.auto && issue) {
      console.error('Error: --auto and an explicit issue number are mutually exclusive.');
      process.exit(1);
    }
    if (!options.auto && !issue) {
      console.error('Error: an issue number is required unless --auto is used.');
      process.exit(1);
    }
    shipCommand(issue, options);
  });

program
  .command('groom')
  .description('Groom an existing issue')
  .argument('[issue]', 'issue number or URL')
  .option('--auto', 'groom all eligible shipper:new issues in sequence', false)
  .action((issue: string | undefined, options: { auto: boolean }) => {
    if (options.auto && issue) {
      console.error('Error: --auto and an explicit issue number are mutually exclusive.');
      process.exit(1);
    }
    groomCommand(issue, options);
  });

program
  .command('design')
  .description('Run technical design review on an issue')
  .argument('[issue]', 'issue number or URL')
  .action((issue?: string) => {
    designCommand(issue);
  });

program
  .command('plan')
  .description('Create an implementation plan for an issue')
  .argument('[issue]', 'issue number or URL')
  .action((issue?: string) => {
    planCommand(issue);
  });

program
  .command('implement')
  .description('Implement an issue in a worktree')
  .argument('[issue]', 'issue number or URL')
  .action((issue?: string) => {
    implementCommand(issue);
  });

program
  .command('reset')
  .description('Reset an issue back to shipper:new status')
  .argument('<issue>', 'issue number')
  .option('-f, --force', 'skip confirmation prompt')
  .action((issue: string, opts: { force: boolean }) => {
    resetCommand(issue, opts);
  });

program
  .command('unblock')
  .description('Check if a blocked issue can proceed')
  .argument('<issue>', 'issue number')
  .action((issue: string) => {
    unblockCommand(issue);
  });

program
  .command('unlock')
  .description('Force-release the lock on an issue')
  .argument('<issue>', 'issue number')
  .action((issue: string) => {
    unlockCommand(issue);
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
  .action((prArg?: string) => {
    prReviewCommand(prArg);
  });

pr.command('open')
  .description('Open a pull request for an implemented issue')
  .argument('[issue]', 'issue number or URL')
  .action((issue?: string) => {
    prOpenCommand(issue);
  });

pr.command('remediate')
  .description('Remediate a pull request after review feedback')
  .argument('[pr]', 'PR number or URL')
  .action((prArg?: string) => {
    prRemediateCommand(prArg);
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
    (
      number: string | undefined,
      options: { interval: string; once: boolean; dryRun: boolean; repo?: string }
    ) => {
      mergeCommand({ ...options, number });
    }
  );

program.parse();
