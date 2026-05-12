import type { ToolName } from '../tools.js';

export type ToolExtras = {
  whenToUse?: string;
  parameterDescriptions?: Record<string, string>;
  example: {
    call: Record<string, unknown>;
    result: string;
    resultLanguage?: 'json' | 'text';
  };
  errorModes: { name: string; message: string }[];
  relatedTools?: ToolName[];
};

const githubError = 'Command failed: gh <args>';
const sessionLookupError = 'Command failed: gh <args>';
const spawnFailure = 'spawn shipper ENOENT';

export const toolExtras = {
  shipper_list_issues: {
    whenToUse:
      'Use this before changing workflow state when you need a quick inventory of shipper-managed issues, or when an agent needs to choose the next issue by stage or control status.',
    example: {
      call: {},
      result: `Planned (1)
  #42 Generate MCP tool reference pages

Blocked (1)
  #44 Fix release workflow [implemented]`,
    },
    errorModes: [{ name: 'GitHub command failure', message: githubError }],
    relatedTools: ['shipper_get_issue', 'shipper_advance'],
  },
  shipper_get_issue: {
    whenToUse:
      'Use this when an agent needs the issue body, labels, state, and linked PR before deciding whether to advance, reset, inspect checks, or answer a paused worker.',
    example: {
      call: { issue: 42 },
      result: `<issue number="42" state="OPEN">
<title>Generate MCP tool reference pages</title>
<labels>
  <label>shipper:planned</label>
</labels>
<body>Generate reference pages from MCP tool metadata.</body>
</issue>

<linked-pr number="17"/>`,
    },
    errorModes: [{ name: 'GitHub command failure', message: githubError }],
    relatedTools: ['shipper_get_pr_checks', 'shipper_advance', 'shipper_reset'],
  },
  shipper_get_pr_checks: {
    whenToUse:
      'Use this after a PR exists and before merge or remediation decisions, especially when an agent needs the failing or pending check names.',
    example: {
      call: { pr: 17 },
      result: `Checks for owner/repo#17: 2 passed, 1 pending, 0 failed (total: 3)

Pending:
  - check`,
    },
    errorModes: [{ name: 'GitHub command failure', message: githubError }],
    relatedTools: ['shipper_merge'],
  },
  shipper_docs_search: {
    whenToUse:
      'Use this when an agent needs to discover relevant Shipper docs pages or snippets before fetching a full page.',
    example: {
      call: { query: 'setup agents', limit: 2 },
      result: `Match 1
path: agents/setup
title: Repository setup for agents
score: 18.00
snippet: Configure a repository so any coding agent can run Shipper reliably...`,
    },
    errorModes: [
      {
        name: 'Corpus unavailable or read failure',
        message:
          'Shipper documentation corpus is unavailable. Rebuild @baremetallabs-ai/shipper-mcp with the docs snapshot or set SHIPPER_DOCS_PATH to an absolute docs corpus path.',
      },
    ],
    relatedTools: ['shipper_docs_get'],
  },
  shipper_docs_get: {
    whenToUse:
      'Use this after search identifies a docs-site path, or when the agent already knows the path of the page it needs.',
    example: {
      call: { path: 'agents/setup' },
      result: `# Repository setup for agents

Configure a repository so coding agents can run Shipper reliably.`,
    },
    errorModes: [
      {
        name: 'Unknown path',
        message:
          'Documentation page not found for path "<path>". Call shipper_docs_search to find a valid docs path.',
      },
      {
        name: 'Corpus unavailable or read failure',
        message:
          'Shipper documentation corpus is unavailable. Rebuild @baremetallabs-ai/shipper-mcp with the docs snapshot or set SHIPPER_DOCS_PATH to an absolute docs corpus path.',
      },
    ],
    relatedTools: ['shipper_docs_search'],
  },
  shipper_advance: {
    whenToUse:
      'Use this for the normal one-step workflow progression once an issue has moved past intake. Use `shipper_groom` instead for `shipper:new` issues when experimental MCP grooming is enabled.',
    example: {
      call: { issue: 42 },
      result: `Stage: shipper:planned -> shipper:implemented (accept)
PR: https://github.com/owner/repo/pull/17

---
Implementation complete.

Session log: /tmp/shipper/session.log`,
    },
    errorModes: [
      {
        name: 'Interactive grooming required',
        message:
          'Issue #<issue> is at shipper:new. Grooming must be done interactively by a human (it asks clarifying questions and edits the issue body). Ask the user to run `shipper groom <issue>` in their terminal; once the issue moves past `shipper:new`, you can retry this tool.',
      },
      {
        name: 'Missing stage transition metadata',
        message: 'Unable to recover the stage transition from post-run metadata.',
      },
      {
        name: 'Timed out worker',
        message: '[timed out] shipper next <issue> --mode headless',
      },
      {
        name: 'Failed worker',
        message: '[exit <code>] shipper next <issue> --mode headless',
      },
      { name: 'GitHub or session lookup failure', message: sessionLookupError },
    ],
    relatedTools: ['shipper_get_issue', 'shipper_get_pr_checks', 'shipper_answer_question'],
  },
  shipper_groom: {
    whenToUse:
      'Use this only for `shipper:new` issues when MCP-driven grooming is enabled and the orchestrator is prepared to answer worker questions with `shipper_answer_question`. Each awaiting_answer result contains exactly one question batch; if the worker has more pending batches, the next one is returned by `shipper_answer_question` after the current batch is answered.',
    example: {
      call: { issue: 42 },
      result: `Status: awaiting_answer
Session: sess-abc123

The headless worker called AskUserQuestion and is paused awaiting answers from the orchestrator.
Reply with \`shipper_answer_question\` providing { session_id, answers } where answers is a map
of question text -> your answer (free text).

Questions (JSON):
[
  {
    "question": "Which behavior should the implementation preserve?"
  }
]`,
    },
    errorModes: [
      {
        name: 'Wrong issue stage',
        message:
          'shipper_groom only operates on issues at shipper:new. Issue #<issue> has labels: <labels>.',
      },
      {
        name: 'Missing stage transition metadata',
        message: 'Unable to recover the stage transition from post-run metadata.',
      },
      {
        name: 'Timed out worker',
        message: '[timed out] shipper groom <issue> --mode headless',
      },
      {
        name: 'Failed worker',
        message: '[exit <code>] shipper groom <issue> --mode headless',
      },
      { name: 'GitHub or session lookup failure', message: sessionLookupError },
    ],
    relatedTools: ['shipper_answer_question', 'shipper_advance'],
  },
  shipper_create_issue: {
    whenToUse:
      'Use this when the user has a plain-language request that should become a researched GitHub issue rather than immediate code changes. The headless agent writes a draft under `.shipper/output/`, Shipper validates the draft, creates the GitHub issue, applies `shipper:new`, and records the final `created_issue` identity. The transcript is used only for the final-message wrap-up.',
    example: {
      call: { request: 'Add generated MCP reference pages for the docs site' },
      result: `Created issue: #42 Add generated MCP reference pages for the docs site
URL: https://github.com/owner/repo/issues/42

---
Created a scoped implementation issue.

Session log: /tmp/shipper/session.log`,
    },
    errorModes: [
      {
        name: 'Timed out worker',
        message: '[timed out] shipper new <request> --mode headless',
      },
      {
        name: 'Failed worker',
        message: '[exit <code>] shipper new <request> --mode headless',
      },
    ],
    relatedTools: ['shipper_groom', 'shipper_advance'],
  },
  shipper_unblock: {
    whenToUse:
      'Use this when an issue is marked `shipper:blocked` and an agent needs to determine whether the blocker has cleared and the workflow can continue.',
    example: {
      call: { issue: 42 },
      result: `Verdict: unblocked
Reason: The dependency has merged and the blocked work can continue.

---
Blocker resolved.

Session log: /tmp/shipper/session.log`,
    },
    errorModes: [
      {
        name: 'Missing unblock verdict',
        message: 'Unable to recover the unblock verdict from post-run metadata.',
      },
      {
        name: 'Timed out worker',
        message: '[timed out] shipper unblock <issue> --mode headless',
      },
      {
        name: 'Failed worker',
        message: '[exit <code>] shipper unblock <issue> --mode headless',
      },
      {
        name: 'GitHub, session, or result-file failure',
        message: 'GitHub, session, or result-file failure: <underlying error message>',
      },
    ],
    relatedTools: ['shipper_get_issue', 'shipper_advance'],
  },
  shipper_merge: {
    whenToUse:
      'Use this when ready PRs should be processed by the merge queue once. Use `shipper_get_pr_checks` first when CI status is uncertain.',
    example: {
      call: {},
      result: `[exit 0] shipper merge --once
--- stdout ---
Merged PR #17 for issue #42.`,
    },
    errorModes: [
      { name: 'Timed out merge', message: '[timed out] shipper merge --once' },
      { name: 'Failed merge', message: '[exit <code>] shipper merge --once' },
      { name: 'Spawn failure', message: spawnFailure },
    ],
    relatedTools: ['shipper_get_pr_checks'],
  },
  shipper_unlock: {
    whenToUse:
      'Use this when a stale or manually held shipper lock is preventing workflow progress. Choose either one issue or a stale-lock sweep.',
    example: {
      call: { issue: 42 },
      result: 'Released lock on #42.',
    },
    errorModes: [
      {
        name: 'Conflicting arguments',
        message: 'Provide either `issue` or `stale`, not both.',
      },
      {
        name: 'Missing target',
        message: 'Provide either `issue` or `stale: true`.',
      },
      {
        name: 'Lock release or list failure',
        message: 'Lock release/list failure: <underlying error message>',
      },
    ],
    relatedTools: ['shipper_reset', 'shipper_unblock'],
  },
  shipper_reset: {
    whenToUse:
      'Use this for explicit recovery when an issue must move backward to an earlier workflow stage. Prefer dry-run first so the agent can inspect cleanup actions before mutating state.',
    example: {
      call: { issue: 42, target: 'groomed', dry_run: true },
      result: `Reset preview for issue #42:
Target: shipper:groomed
Labels to remove: shipper:planned
Label to add: shipper:groomed
Dry run only; no changes made.`,
    },
    errorModes: [
      { name: 'Pull request target', message: '#<issue> is a pull request, not an issue.' },
      {
        name: 'Closed issue',
        message: 'Issue #<issue> is closed. Reset only works on open issues.',
      },
      {
        name: 'Active lock',
        message:
          'Issue #<issue> is locked by another shipper instance. Release the lock with shipper_unlock before retrying.',
      },
      {
        name: 'Already at target',
        message: 'Error: Issue #<issue> is already at shipper:<target>. Reset only works backward.',
      },
      {
        name: 'Target ahead of current stage',
        message:
          'Error: shipper:<target> is ahead of the current stage shipper:<stage>. Reset only works backward.',
      },
      { name: 'Partial reset failure', message: 'failed: <operation> (<reason>)' },
      {
        name: 'Scan, execution, or GitHub failure',
        message: 'Scan/execute/GitHub failure: <underlying error message>',
      },
    ],
    relatedTools: ['shipper_get_issue', 'shipper_unlock'],
  },
  shipper_adopt: {
    whenToUse:
      'Use this when an existing open GitHub issue should enter the shipper workflow at `shipper:new` instead of creating a new issue.',
    example: {
      call: { issue: 42 },
      result: 'Issue #42 adopted into shipper workflow.',
    },
    errorModes: [
      { name: 'Pull request target', message: '#<issue> is a pull request, not an issue.' },
      {
        name: 'Issue lookup or label mutation failure',
        message: 'Issue lookup/label mutation failure: <underlying error message>',
      },
    ],
    relatedTools: ['shipper_get_issue', 'shipper_groom'],
  },
  shipper_answer_question: {
    whenToUse:
      'Use this only after `shipper_groom` or `shipper_advance` returns an awaiting-answer session id. The answers map must include every exact question text from the currently displayed batch. If more batches are already pending from the same worker turn, the result is another single-batch awaiting_answer payload to answer before the worker can resume fully.',
    example: {
      call: {
        session_id: 'sess-abc123',
        answers: {
          'Which behavior should the implementation preserve?':
            'Keep the current MCP response shape.',
        },
      },
      result: `Status: awaiting_answer
Session: sess-abc123
Tool use id: toolu_next

The headless worker called AskUserQuestion and is paused awaiting answers from the orchestrator.
Reply with \`shipper_answer_question\` providing { session_id, answers } where answers is a map
of question text -> your answer (free text).

Questions (JSON):
[
  {
    "question": "What should happen next?"
  }
]`,
    },
    errorModes: [
      {
        name: 'Missing pending session',
        message:
          'No pending shipper session with id "<session_id>". The worker may have already completed or the MCP server may have restarted.',
      },
      {
        name: 'Completed before answer',
        message: 'Cannot submit an answer: shipper child already completed.',
      },
      {
        name: 'Missing current-batch answers',
        message: 'Missing answers for current question batch: <questions>',
      },
      {
        name: 'Unavailable stdin',
        message: 'shipper child stdin is unavailable; cannot submit answer.',
      },
      {
        name: 'No more events',
        message: 'Shipper child has already completed; no more events.',
      },
      {
        name: 'Missing stage transition metadata',
        message: 'Unable to recover the stage transition from post-run metadata.',
      },
      { name: 'Worker command failure', message: spawnFailure },
    ],
    relatedTools: ['shipper_groom', 'shipper_advance'],
  },
} satisfies Record<ToolName, ToolExtras>;
