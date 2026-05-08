export const commandPaths = [
  'init',
  'setup',
  'new',
  'adopt',
  'priority',
  'next',
  'ship',
  'groom',
  'design',
  'plan',
  'implement',
  'eject',
  'reset',
  'unblock',
  'unlock',
  'merge',
  'issue list',
  'pr review',
  'pr open',
  'pr remediate',
] as const;

export type CommandPath = (typeof commandPaths)[number];

export type CommandExample = { command: string; caption: string };
export type CommandExitCode = { code: number; when: string };
export type CommandExtras = {
  examples: CommandExample[];
  exitCodes: CommandExitCode[];
  constraints?: string[];
};

const promptMcpConstraint = '--disable-mcp and --enable-mcp are mutually exclusive';

const stageExitCodes: CommandExitCode[] = [
  { code: 0, when: 'The stage completes successfully or returns a reject verdict.' },
  { code: 1, when: 'Preflight, validation, GitHub, agent, or fail verdict handling fails.' },
];

const promptConstraints = [promptMcpConstraint];

export const commandExtras: Record<CommandPath, CommandExtras> = {
  init: {
    examples: [
      { command: 'shipper init', caption: 'Initialize Shipper in the current repository.' },
    ],
    exitCodes: [
      { code: 0, when: 'Repository configuration files are written successfully.' },
      { code: 1, when: 'Validation, setup, git commit, or git push fails.' },
    ],
    constraints: [
      '--push requires --autocommit',
      'shipper init owns committed .shipper/ artifacts in this repository; rerun it and ' +
        'commit the resulting .shipper/ changes when the init drift guard reports drift',
    ],
  },
  setup: {
    examples: [
      {
        command: 'shipper setup "change the default agent to codex"',
        caption: 'Run setup with additional instructions for the agent.',
      },
    ],
    exitCodes: [
      { code: 0, when: 'Setup completes successfully or writes a setup PR.' },
      { code: 1, when: 'Setup validation, agent execution, or setup finalization fails.' },
    ],
    constraints: [
      promptMcpConstraint,
      'Headless mode is not supported for shipper setup; run setup interactively or remove ' +
        '"commands.setup.mode": "headless" / "commands.default.mode": "headless" from .shipper/settings.json.',
    ],
  },
  new: {
    examples: [
      {
        command: 'shipper new Add a CLI flag for stale lock cleanup',
        caption: 'Ask Shipper to draft a new issue from a request.',
      },
    ],
    exitCodes: [
      { code: 0, when: 'The issue creation agent completes successfully.' },
      { code: 1, when: 'Preflight, validation, worktree setup, hooks, or agent execution fails.' },
    ],
    constraints: promptConstraints,
  },
  adopt: {
    examples: [
      { command: 'shipper adopt 42', caption: 'Adopt one existing issue into the workflow.' },
      {
        command: 'shipper adopt --all',
        caption: 'Adopt every open issue that does not already have a Shipper workflow label.',
      },
    ],
    exitCodes: [
      { code: 0, when: 'The selected issue or issues are labeled successfully.' },
      { code: 1, when: 'Validation, issue lookup, or label mutation fails.' },
    ],
    constraints: [
      '--all and an explicit issue argument are mutually exclusive',
      'An issue argument is required unless --all is used',
    ],
  },
  priority: {
    examples: [
      { command: 'shipper priority 42 high', caption: 'Mark issue 42 as high priority.' },
      { command: 'shipper priority 42 normal', caption: 'Clear explicit priority labels.' },
    ],
    exitCodes: [
      { code: 0, when: 'Priority labels are updated or already match the requested priority.' },
      { code: 1, when: 'Validation, issue lookup, or label mutation fails.' },
    ],
  },
  next: {
    examples: [
      { command: 'shipper next 42', caption: 'Advance issue 42 to its next workflow stage.' },
    ],
    exitCodes: [
      { code: 0, when: 'The next stage succeeds or returns a reject verdict.' },
      {
        code: 1,
        when: 'Preflight, label validation, stage dispatch, or fail verdict handling fails.',
      },
    ],
    constraints: promptConstraints,
  },
  ship: {
    examples: [
      {
        command: 'shipper ship 42 --merge',
        caption: 'Run issue 42 through the workflow and merge it.',
      },
      {
        command: 'shipper ship --auto --parallel 3',
        caption: 'Run the autonomous shipping loop with three parallel slots.',
      },
    ],
    exitCodes: [
      { code: 0, when: 'The issue or auto run completes without a terminal failure.' },
      {
        code: 1,
        when: 'Preflight, validation, stage execution, merge, or auto-ship execution fails.',
      },
      { code: 75, when: 'A single-issue ship run pauses because the pause sentinel is present.' },
      { code: 76, when: 'A single-issue ship run encounters a retriable failure.' },
    ],
    constraints: [
      promptMcpConstraint,
      '--auto and an explicit issue argument are mutually exclusive',
      'An issue argument is required unless --auto is used',
      '--auto and --mode are mutually exclusive',
      '--parallel <n> requires --auto',
      '--parallel <n> must be a positive integer',
    ],
  },
  groom: {
    examples: [
      { command: 'shipper groom 42', caption: 'Groom one issue by number.' },
      { command: 'shipper groom --auto', caption: 'Groom all eligible new issues in sequence.' },
    ],
    exitCodes: stageExitCodes,
    constraints: [
      promptMcpConstraint,
      '--auto and an explicit issue argument are mutually exclusive',
    ],
  },
  design: {
    examples: [{ command: 'shipper design 42', caption: 'Run technical design for issue 42.' }],
    exitCodes: stageExitCodes,
    constraints: promptConstraints,
  },
  plan: {
    examples: [
      { command: 'shipper plan 42', caption: 'Create an implementation plan for issue 42.' },
    ],
    exitCodes: stageExitCodes,
    constraints: promptConstraints,
  },
  implement: {
    examples: [{ command: 'shipper implement 42', caption: 'Implement issue 42 in a worktree.' }],
    exitCodes: stageExitCodes,
    constraints: promptConstraints,
  },
  eject: {
    examples: [
      { command: 'shipper eject', caption: 'Write the default workflow prompt overrides.' },
      { command: 'shipper eject pr-open', caption: 'Write one prompt override by name.' },
    ],
    exitCodes: [
      { code: 0, when: 'Prompt override files are written or skipped because they already exist.' },
      { code: 1, when: 'Settings cannot be loaded or the requested prompt is not bundled.' },
    ],
  },
  reset: {
    examples: [
      {
        command: 'shipper reset 42 --to groomed --force',
        caption: 'Reset issue 42 without prompting.',
      },
    ],
    exitCodes: [
      { code: 0, when: 'The issue is reset to the selected earlier stage.' },
      { code: 1, when: 'Validation, issue lookup, confirmation, or cleanup fails.' },
    ],
  },
  unblock: {
    examples: [
      { command: 'shipper unblock 42', caption: 'Check whether issue 42 can be unblocked.' },
    ],
    exitCodes: [
      { code: 0, when: 'The unblock check completes and writes its result.' },
      { code: 1, when: 'Validation, preflight, agent execution, or result processing fails.' },
    ],
    constraints: promptConstraints,
  },
  unlock: {
    examples: [
      { command: 'shipper unlock 42', caption: 'Release the lock on one issue.' },
      { command: 'shipper unlock --stale', caption: 'Release all stale issue locks.' },
    ],
    exitCodes: [
      { code: 0, when: 'The selected lock or stale locks are released.' },
      { code: 1, when: 'Validation, issue lookup, or label mutation fails.' },
    ],
    constraints: [
      '--stale cannot be used with an issue argument',
      'An issue argument is required unless --stale is used',
    ],
  },
  merge: {
    examples: [
      { command: 'shipper merge --once', caption: 'Process the merge queue once.' },
      { command: 'shipper merge 42 --dry-run', caption: 'Preview merging a specific PR or issue.' },
    ],
    exitCodes: [
      { code: 0, when: 'The merge queue completes, is empty, or the dry run completes.' },
      {
        code: 1,
        when: 'Validation, lock acquisition, GitHub lookup, CI, or merge execution fails.',
      },
    ],
    constraints: ['--interval <seconds> must be a positive integer'],
  },
  'issue list': {
    examples: [
      {
        command: 'shipper issue list --status planned',
        caption: 'List planned Shipper-managed issues.',
      },
    ],
    exitCodes: [
      { code: 0, when: 'Issues are listed successfully, including when no issues match.' },
      { code: 1, when: 'Status validation or GitHub issue lookup fails.' },
    ],
  },
  'pr review': {
    examples: [{ command: 'shipper pr review 42', caption: 'Review pull request 42.' }],
    exitCodes: stageExitCodes,
    constraints: promptConstraints,
  },
  'pr open': {
    examples: [{ command: 'shipper pr open 42', caption: 'Open a pull request for issue 42.' }],
    exitCodes: stageExitCodes,
    constraints: promptConstraints,
  },
  'pr remediate': {
    examples: [
      {
        command: 'shipper pr remediate 42',
        caption: 'Remediate review feedback on pull request 42.',
      },
    ],
    exitCodes: [
      { code: 0, when: 'Remediation completes successfully.' },
      {
        code: 1,
        when: 'Preflight, validation, agent execution, push retry, or result handling fails.',
      },
      { code: 130, when: 'Check polling is interrupted.' },
    ],
    constraints: promptConstraints,
  },
};

export const groups: Record<'pr' | 'issue', { description: string }> = {
  pr: { description: 'Pull request commands' },
  issue: { description: 'Issue commands' },
};
