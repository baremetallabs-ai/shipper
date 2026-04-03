import { Argument, Command, CommanderError, Option } from 'commander';
import { writeSync } from 'node:fs';
import { runPreflight } from '@dnsquared/shipper-core';
import { getRepoNwo } from '@dnsquared/shipper-core';
import { loadSettings, logger, type AgentName, type CommandMode } from '@dnsquared/shipper-core';
import { CLI_VERSION, checkVersionFreshness } from '@dnsquared/shipper-core';
import { toErrorMessage } from '@dnsquared/shipper-core';
import { warnTrackedOutputFiles } from '@dnsquared/shipper-core';
import { initCommand } from './commands/init.js';
import { newCommand } from './commands/new.js';
import { adoptCommand, adoptAllCommand } from './commands/adopt.js';
import { priorityCommand } from './commands/priority.js';
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
let resolvedRepo: string | undefined;
const STAGE_COMMAND_NAMES = new Set([
  'groom',
  'design',
  'plan',
  'implement',
  'open',
  'review',
  'remediate',
  'unblock',
  'next',
  'ship',
]);

function addModeOption(command: Command): Command {
  return command.addOption(
    new Option('--mode <mode>', 'execution mode: headless, interactive, or default')
      .choices(['headless', 'interactive', 'default'])
      .default('default')
  );
}

function addAgentOption(command: Command): Command {
  return command.addOption(
    new Option('--agent <name>', 'agent to use: claude, codex, or copilot').choices([
      'claude',
      'codex',
      'copilot',
    ])
  );
}

function addModelOption(command: Command): Command {
  return command.addOption(new Option('--model <model>', 'model to use for the agent CLI'));
}

program.configureOutput({
  outputError: (str, write) => {
    if (str.includes("option '--parallel <n>' argument missing")) {
      return;
    }
    write(str);
  },
});

function exitWithError(err: unknown): never {
  logger.error(toErrorMessage(err));
  // Intentional: canonical CLI error exit after wrapAction() has normalized the failure.
  process.exit(1);
}

function wrapAction<T extends unknown[]>(
  fn: (...args: T) => Promise<void>
): (...args: T) => Promise<void> {
  return async (...args: T) => {
    try {
      await fn(...args);
    } catch (err) {
      exitWithError(err);
    }
  };
}

function requireResolvedRepo(): string {
  if (!resolvedRepo) {
    throw new Error('Repository not resolved.');
  }
  return resolvedRepo;
}

program
  .name('shipper')
  .description('CLI tool for automating development workflow with coding agents')
  .version(CLI_VERSION);

program.hook(
  'preAction',
  wrapAction(async (_thisCommand, actionCommand) => {
    resolvedRepo = undefined;
    if (actionCommand.name() === 'init' || actionCommand.name() === 'setup') return;
    await loadSettings();
    checkVersionFreshness();
    resolvedRepo = await getRepoNwo();
    await runPreflight(resolvedRepo);
    if (STAGE_COMMAND_NAMES.has(actionCommand.name())) {
      await warnTrackedOutputFiles();
    }
  })
);

program
  .command('init')
  .description('Initialize shipper in the current repository')
  .option('--agent <name>', 'coding agent to use (claude, codex, or copilot)')
  .option('--autocommit', 'stage and commit .shipper/ after writing files')
  .option('--push', 'push the commit to the remote (requires --autocommit)')
  .action(
    wrapAction(async (options: { agent?: string; autocommit?: boolean; push?: boolean }) => {
      await initCommand(options);
    })
  );

addModelOption(
  addAgentOption(
    addModeOption(
      program
        .command('setup [words...]')
        .alias('agent')
        .description('Configure repository settings with an agent')
        .action(
          wrapAction(
            async (words: string[], options: { mode: string; agent?: string; model?: string }) => {
              await loadSettings();
              await setupCommand(words, {
                mode: options.mode as CommandMode,
                agent: options.agent as AgentName | undefined,
                model: options.model,
              });
            }
          )
        )
    )
  )
);

addModelOption(
  addAgentOption(
    addModeOption(
      program
        .command('new')
        .description('Create a new issue interactively or from a request')
        .argument('[request...]', 'your idea for the new issue')
        .option('--log-file <path>', 'write agent output to a specific log file')
        .action(
          wrapAction(
            async (
              request: string[],
              options: { mode: string; agent?: string; model?: string; logFile?: string }
            ) => {
              await newCommand(request, {
                mode: options.mode as CommandMode,
                agent: options.agent as AgentName | undefined,
                model: options.model,
                logFile: options.logFile,
              });
            }
          )
        )
    )
  )
);

program
  .command('adopt')
  .description('Adopt an existing issue into the shipper workflow')
  .argument('[issue]', 'issue number')
  .option('--all', 'adopt all open issues without shipper labels', false)
  .action(
    wrapAction(async (issue: string | undefined, options: { all: boolean }) => {
      if (options.all && issue) {
        throw new Error('Error: --all and an explicit issue number are mutually exclusive.');
      }
      if (!options.all && !issue) {
        throw new Error('Error: an issue number is required unless --all is used.');
      }
      if (options.all) {
        await adoptAllCommand();
      } else {
        await adoptCommand(issue as string);
      }
    })
  );

program
  .command('priority')
  .description('Set priority on an issue')
  .argument('<issue>', 'issue number')
  .addArgument(new Argument('<level>', 'priority level').choices(['high', 'normal', 'low']))
  .action(
    wrapAction(async (issue: string, level: string) => {
      await priorityCommand(requireResolvedRepo(), issue, level as 'high' | 'normal' | 'low');
    })
  );

addModelOption(
  addAgentOption(
    addModeOption(
      program
        .command('next')
        .description('Advance an issue to the next workflow step')
        .argument('<ref>', 'issue or PR number/URL')
        .action(
          wrapAction(
            async (ref: string, options: { mode: string; agent?: string; model?: string }) => {
              await nextCommand(
                requireResolvedRepo(),
                ref,
                options.mode as CommandMode,
                options.agent as AgentName | undefined,
                options.model
              );
            }
          )
        )
    )
  )
);

addModelOption(
  addAgentOption(
    addModeOption(
      program
        .command('ship')
        .description('Run the full workflow end-to-end')
        .argument('[issue]', 'issue number')
        .option('--merge', 'auto-merge the PR after reaching shipper:ready', false)
        .option('--auto', 'run autonomous continuous shipping loop', false)
        .option('--parallel <n>', 'number of parallel slots (requires --auto)')
        .action(
          wrapAction(
            async (
              issue: string | undefined,
              options: {
                merge: boolean;
                auto: boolean;
                parallel?: string;
                mode: string;
                agent?: string;
                model?: string;
              }
            ) => {
              if (options.auto && issue) {
                throw new Error(
                  'Error: --auto and an explicit issue number are mutually exclusive.'
                );
              }
              if (!options.auto && !issue) {
                throw new Error('Error: an issue number is required unless --auto is used.');
              }
              if (options.auto && options.mode !== 'default') {
                throw new Error('Error: --auto and --mode are mutually exclusive.');
              }

              if (options.parallel !== undefined && !options.auto) {
                throw new Error('Error: --parallel requires --auto');
              }

              let parallel: number | undefined;
              if (options.parallel !== undefined) {
                parallel = Number(options.parallel);
                if (!Number.isInteger(parallel) || parallel < 1) {
                  throw new Error('Error: --parallel requires a number');
                }
                if (parallel === 1) {
                  parallel = undefined;
                }
              }

              await shipCommand(requireResolvedRepo(), issue, {
                merge: options.merge,
                auto: options.auto,
                parallel,
                mode: options.mode as CommandMode,
                agent: options.agent as AgentName | undefined,
                model: options.model,
              });
            }
          )
        )
    )
  )
);

addModelOption(
  addAgentOption(
    addModeOption(
      program
        .command('groom')
        .description('Groom an existing issue')
        .argument('[issue]', 'issue number or URL')
        .option('--auto', 'groom all eligible shipper:new issues in sequence', false)
        .action(
          wrapAction(
            async (
              issue: string | undefined,
              options: { auto: boolean; mode: string; agent?: string; model?: string }
            ) => {
              if (options.auto && issue) {
                throw new Error(
                  'Error: --auto and an explicit issue number are mutually exclusive.'
                );
              }
              await groomCommand(requireResolvedRepo(), issue, {
                auto: options.auto,
                mode: options.mode as CommandMode,
                agent: options.agent as AgentName | undefined,
                model: options.model,
              });
            }
          )
        )
    )
  )
);

addModelOption(
  addAgentOption(
    addModeOption(
      program
        .command('design')
        .description('Run technical design review on an issue')
        .argument('[issue]', 'issue number or URL')
        .action(
          wrapAction(
            async (
              issue: string | undefined,
              options: { mode: string; agent?: string; model?: string }
            ) => {
              await designCommand(
                requireResolvedRepo(),
                issue,
                options.mode as CommandMode,
                options.agent as AgentName | undefined,
                options.model
              );
            }
          )
        )
    )
  )
);

addModelOption(
  addAgentOption(
    addModeOption(
      program
        .command('plan')
        .description('Create an implementation plan for an issue')
        .argument('[issue]', 'issue number or URL')
        .action(
          wrapAction(
            async (
              issue: string | undefined,
              options: { mode: string; agent?: string; model?: string }
            ) => {
              await planCommand(
                requireResolvedRepo(),
                issue,
                options.mode as CommandMode,
                options.agent as AgentName | undefined,
                options.model
              );
            }
          )
        )
    )
  )
);

addModelOption(
  addAgentOption(
    addModeOption(
      program
        .command('implement')
        .description('Implement an issue in a worktree')
        .argument('[issue]', 'issue number or URL')
        .action(
          wrapAction(
            async (
              issue: string | undefined,
              options: { mode: string; agent?: string; model?: string }
            ) => {
              await implementCommand(
                requireResolvedRepo(),
                issue,
                options.mode as CommandMode,
                options.agent as AgentName | undefined,
                options.model
              );
            }
          )
        )
    )
  )
);

program
  .command('eject')
  .description('Scaffold prompt overrides for customization')
  .argument('[name]', 'prompt name to eject (e.g. groom, pr-open)')
  .action(
    wrapAction((name?: string) => {
      ejectCommand(name);
      return Promise.resolve();
    })
  );

program
  .command('reset')
  .description('Reset an issue back to an earlier workflow stage')
  .argument('<issue>', 'issue number')
  .option('-f, --force', 'skip confirmation prompt')
  .option('--to <stage>', 'reset to a specific workflow stage')
  .action(
    wrapAction(async (issue: string, opts: { force: boolean; to?: string }) => {
      await resetCommand(issue, opts);
    })
  );

addModelOption(
  addAgentOption(
    addModeOption(
      program
        .command('unblock')
        .description('Check if a blocked issue can proceed')
        .argument('<issue>', 'issue number')
        .action(
          wrapAction(
            async (issue: string, options: { mode: string; agent?: string; model?: string }) => {
              await unblockCommand(
                requireResolvedRepo(),
                issue,
                options.mode as CommandMode,
                options.agent as AgentName | undefined,
                options.model
              );
            }
          )
        )
    )
  )
);

program
  .command('unlock')
  .description('Force-release an issue lock or sweep stale locks')
  .argument('[issue]', 'issue number')
  .option('--stale', 'release all stale locks')
  .action(
    wrapAction(async (issue: string | undefined, opts: { stale?: boolean }) => {
      await unlockCommand(requireResolvedRepo(), issue, opts);
    })
  );

const issue = program.command('issue').description('Issue commands');

issue
  .command('list')
  .description('List shipper-managed issues by pipeline status')
  .option('--status <name>', 'filter to a single status (e.g. planned)')
  .action(
    wrapAction(async (options: { status?: string }) => {
      await issueListCommand(options);
    })
  );

const pr = program.command('pr').description('Pull request commands');

addModelOption(
  addAgentOption(
    addModeOption(
      pr
        .command('review')
        .description('Review a pull request')
        .argument('[pr]', 'PR number or URL')
        .action(
          wrapAction(
            async (
              prArg: string | undefined,
              options: { mode: string; agent?: string; model?: string }
            ) => {
              await prReviewCommand(
                requireResolvedRepo(),
                prArg,
                options.mode as CommandMode,
                options.agent as AgentName | undefined,
                options.model
              );
            }
          )
        )
    )
  )
);

addModelOption(
  addAgentOption(
    addModeOption(
      pr
        .command('open')
        .description('Open a pull request for an implemented issue')
        .argument('[issue]', 'issue number or URL')
        .action(
          wrapAction(
            async (
              issue: string | undefined,
              options: { mode: string; agent?: string; model?: string }
            ) => {
              await prOpenCommand(
                requireResolvedRepo(),
                issue,
                options.mode as CommandMode,
                options.agent as AgentName | undefined,
                options.model
              );
            }
          )
        )
    )
  )
);

addModelOption(
  addAgentOption(
    addModeOption(
      pr
        .command('remediate')
        .description('Remediate a pull request after review feedback')
        .argument('[pr]', 'PR number or URL')
        .action(
          wrapAction(
            async (
              prArg: string | undefined,
              options: { mode: string; agent?: string; model?: string }
            ) => {
              await prRemediateCommand(
                requireResolvedRepo(),
                prArg,
                options.mode as CommandMode,
                options.agent as AgentName | undefined,
                options.model
              );
            }
          )
        )
    )
  )
);

program
  .command('merge')
  .description('Run the merge queue for PRs labeled shipper:ready')
  .argument('[number]', 'PR or issue number to merge')
  .option('--interval <seconds>', 'polling interval in seconds', '60')
  .option('--once', 'process the queue once and exit', false)
  .option('--dry-run', 'print actions without executing', false)
  .option('--repo <owner/repo>', 'repository (default: inferred from cwd)')
  .action(
    wrapAction(
      async (
        number: string | undefined,
        options: { interval: string; once: boolean; dryRun: boolean; repo?: string }
      ) => {
        await mergeCommand({ ...options, number });
      }
    )
  );

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
