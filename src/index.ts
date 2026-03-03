import { Command } from 'commander';
import { runPreflight } from './lib/prerequisites.js';
import { initCommand } from './commands/init.js';
import { newCommand } from './commands/new.js';
import { groomCommand } from './commands/groom.js';
import { designCommand } from './commands/design.js';
import { planCommand } from './commands/plan.js';
import { nextCommand } from './commands/next.js';
import { implementCommand } from './commands/implement.js';
import { prReviewCommand } from './commands/pr-review.js';
import { prOpenCommand } from './commands/pr-open.js';
import { prRemediateCommand } from './commands/pr-remediate.js';
import { mergeCommand } from './commands/merge.js';

const program = new Command();

program
  .name('shipper')
  .description('CLI tool for automating development workflow with coding agents')
  .version('0.1.0');

program.hook('preAction', (_thisCommand, actionCommand) => {
  if (actionCommand.name() === 'init' || actionCommand.name() === 'merge') return;
  runPreflight();
});

program
  .command('init')
  .description('Initialize shipper in the current repository')
  .action(() => {
    initCommand();
  });

program
  .command('new')
  .description('Create a new issue from a pitch')
  .argument('<pitch...>', 'your idea for the new issue')
  .action((pitch: string[]) => {
    newCommand(pitch);
  });

program
  .command('next')
  .description('Advance an issue to the next workflow step')
  .argument('<ref>', 'issue or PR number/URL')
  .action((ref: string) => {
    nextCommand(ref);
  });

program
  .command('groom')
  .description('Groom an existing issue')
  .argument('<issue>', 'issue number or URL')
  .action((issue: string) => {
    groomCommand(issue);
  });

program
  .command('design')
  .description('Run technical design review on an issue')
  .argument('<issue>', 'issue number or URL')
  .action((issue: string) => {
    designCommand(issue);
  });

program
  .command('plan')
  .description('Create an implementation plan for an issue')
  .argument('<issue>', 'issue number or URL')
  .action((issue: string) => {
    planCommand(issue);
  });

program
  .command('implement')
  .description('Implement an issue in a worktree')
  .argument('<issue>', 'issue number or URL')
  .action((issue: string) => {
    implementCommand(issue);
  });

const pr = program.command('pr').description('Pull request commands');

pr.command('review')
  .description('Review a pull request')
  .argument('<pr>', 'PR number or URL')
  .action((prArg: string) => {
    prReviewCommand(prArg);
  });

pr.command('open')
  .description('Open a pull request for an implemented issue')
  .argument('<issue>', 'issue number or URL')
  .action((issue: string) => {
    prOpenCommand(issue);
  });

pr.command('remediate')
  .description('Remediate a pull request after review feedback')
  .argument('<pr>', 'PR number or URL')
  .action((prArg: string) => {
    prRemediateCommand(prArg);
  });

program
  .command('merge')
  .description('Run the merge queue for PRs labeled shipper:ready')
  .option('--interval <seconds>', 'polling interval in seconds', '60')
  .option('--once', 'process the queue once and exit', false)
  .option('--dry-run', 'print actions without executing', false)
  .option('--repo <owner/repo>', 'repository (default: inferred from cwd)')
  .action((options: { interval: string; once: boolean; dryRun: boolean; repo?: string }) => {
    mergeCommand(options);
  });

program.parse();
