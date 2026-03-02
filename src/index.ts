import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { newCommand } from './commands/new.js';
import { groomCommand } from './commands/groom.js';

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

program.parse();
