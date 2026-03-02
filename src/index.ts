import { Command } from 'commander';

const program = new Command();

program
  .name('shipper')
  .description('CLI tool for automating development workflow with coding agents')
  .version('0.1.0');

program
  .command('hello')
  .description('Say hello')
  .argument('[name]', 'name to greet', 'World')
  .action((name: string) => {
    console.log(`Hello, ${name}!`);
  });

program.parse();
