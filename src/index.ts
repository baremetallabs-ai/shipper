import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { newCommand } from './commands/new.js';
import { groomCommand } from './commands/groom.js';
import { designCommand } from './commands/design.js';
import { planCommand } from './commands/plan.js';
import { prReviewCommand } from './commands/pr-review.js';

const program = new Command();

program
  .name('shipper')
  .description('CLI tool for automating development workflow with coding agents')
  .version('0.1.0');

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

const pr = program.command('pr').description('Pull request commands');

pr.command('review')
  .description('Review a pull request')
  .argument('<pr>', 'PR number or URL')
  .action((prArg: string) => {
    prReviewCommand(prArg);
  });

program.parse();
