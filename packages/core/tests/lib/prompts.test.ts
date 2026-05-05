import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../../src/lib/frontmatter.js';

const nonBindingIntakeMarker =
  '*Non-binding intake interpretation: grooming may validate, revise, or discard these assumptions. The Request section remains the source of truth.*';

const expectedRelevantDocumentationSection = `# Relevant Documentation (optional — include only if relevant docs are found)

Scan the repository for documentation files (e.g., README.md, docs/, CONTRIBUTING.md, CHANGELOG.md) relevant to the request, then list the 3-5 most relevant entries. For each, label as:

- **Relevant context** — provides useful background for the feature area
- **May need updating** — the requested change would likely make this doc stale

For example:

- \`CONTRIBUTING.md\`: **Relevant context**
- \`docs/api/v1.md\`: **May need updating**

Omit this section entirely if no relevant docs are found.`;

function extractEnvironmentFailureEscapeHatch(prompt: string): string {
  const match = prompt.match(/## Environment failure escape hatch[\s\S]*?\n---/);

  if (!match) {
    throw new Error('Environment failure escape hatch section not found');
  }

  return match[0];
}

describe('groom prompts', () => {
  it.each(['claude', 'codex', 'copilot'])(
    'documents priority choices and label reconciliation for %s',
    (agent) => {
      const prompt = readFileSync(
        new URL(`../../src/prompts/${agent}/groom.md`, import.meta.url),
        'utf-8'
      );

      expect(prompt).toContain('After all other product decisions are resolved');
      expect(prompt).toContain('**High**');
      expect(prompt).toContain('**Normal**');
      expect(prompt).toContain('**Low**');
      expect(prompt).toContain('shipper:priority-high');
      expect(prompt).toContain('shipper:priority-low');
      expect(prompt).toContain(
        'Choosing `normal` tells the orchestrator to remove both priority labels.'
      );
    }
  );

  it.each(['claude', 'codex', 'copilot'])(
    'documents duplicate detection and short-circuit handling for %s',
    (agent) => {
      const prompt = readFileSync(
        new URL(`../../src/prompts/${agent}/groom.md`, import.meta.url),
        'utf-8'
      );

      expect(prompt).toContain('Duplicate');
      expect(prompt).toContain('### Duplicate-detection gate');
      expect(prompt).toContain(
        'Present the finding to the product owner using the interactive question-asking tool'
      );
      expect(prompt).toContain('Record the duplicate decision in the grooming artifacts');
      expect(prompt).toContain('Reclassify the relationship as **Overlap**');
    }
  );

  it.each(['claude', 'codex', 'copilot'])(
    'documents scoped child grooming comments during decomposition for %s',
    (agent) => {
      const prompt = readFileSync(
        new URL(`../../src/prompts/${agent}/groom.md`, import.meta.url),
        'utf-8'
      );

      expect(prompt).toContain('.shipper/output/result.json');
      expect(prompt).toContain('.shipper/output/groom-<number>.json');
      expect(prompt).toContain('body_file');
      expect(prompt).toContain('grooming_comment_file');
      expect(prompt).toContain('priority');
      expect(prompt).toContain('decomposition');
      expect(prompt).toContain('kind');
      expect(prompt).toContain('children');
      expect(prompt).toContain('{{blocking_issue}}');
      expect(prompt).toContain("excludes the parent's decomposition recommendation section");
      expect(prompt).not.toContain('gh issue edit');
      expect(prompt).not.toContain('gh issue comment');
      expect(prompt).not.toContain('gh issue create');
      expect(prompt).not.toContain('gh issue close');
      expect(prompt).not.toContain('.shipper/tmp/');
    }
  );

  it.each(['claude', 'codex', 'copilot'])(
    'treats intake interpretation as tentative context for %s',
    (agent) => {
      const prompt = readFileSync(
        new URL(`../../src/prompts/${agent}/groom.md`, import.meta.url),
        'utf-8'
      );

      expect(prompt).toContain(
        'Treat the `# Request` section as the authoritative source of truth for user intent.'
      );
      expect(prompt).toContain(
        'Treat `# Interpretation`, `Assumptions`, and similar intake-stage sections as tentative, non-binding context.'
      );
      expect(prompt).toContain(
        'Do not promote intake assumptions into `# Requirements` or `# Acceptance Criteria` unless they are explicit in `# Request` or confirmed by the product owner during grooming.'
      );
      expect(prompt).toContain(
        'If an intake assumption is load-bearing for the eventual requirements and is a product-level decision, validate or revise it through Phase 3 questions.'
      );
      expect(prompt).toContain(
        'If a load-bearing intake assumption is not a product-level decision, surface it in `# Open Questions` for engineering/design instead of making it a requirement.'
      );
      expect(prompt).toContain(
        'Set aside non-load-bearing or obviously irrelevant intake assumptions without auditing every assumption one by one.'
      );
    }
  );
});

describe('pr_open prompts', () => {
  it.each(['claude', 'codex', 'copilot'])(
    'write PR protocol artifacts and avoid direct GitHub commands for %s',
    (agent) => {
      const prompt = readFileSync(
        new URL(`../../src/prompts/${agent}/pr_open.md`, import.meta.url),
        'utf-8'
      );

      expect(prompt).toContain('.shipper/output/pr-body-<number>.md');
      expect(prompt).toContain('.shipper/output/pr-spec-<number>.json');
      expect(prompt).toContain('.shipper/output/result.json');
      expect(prompt).toContain('{{BASE_BRANCH}}');
      expect(prompt).not.toContain('<base branch from context>');
      expect(prompt).not.toContain('gh pr create');
      expect(prompt).not.toContain('gh pr checks');
      expect(prompt).not.toContain('gh issue comment');
      expect(prompt).not.toContain('gh issue edit');
    }
  );
});

describe('pr_review prompts', () => {
  it.each(['claude', 'codex', 'copilot'])(
    'read pre-flight review context and avoid direct GitHub commands for %s',
    (agent) => {
      const prompt = readFileSync(
        new URL(`../../src/prompts/${agent}/pr_review.md`, import.meta.url),
        'utf-8'
      );

      expect(prompt).toContain('.shipper/input/pr-diff.patch');
      expect(prompt).toContain('.shipper/input/pr-files.json');
      expect(prompt).toContain('.shipper/input/pr-metadata.json');
      expect(prompt).toContain('.shipper/output/review-payload-<number>.json');
      expect(prompt).toContain('.shipper/output/result.json');
      expect(prompt).not.toContain('gh pr diff');
      expect(prompt).not.toContain('gh pr view');
      expect(prompt).not.toContain('gh repo view');
      expect(prompt).not.toContain('gh issue comment');
      expect(prompt).not.toContain('gh issue edit');
      expect(prompt).not.toContain('./.shipper/scripts/gh-api-');
    }
  );
});

describe('pr_remediate prompts', () => {
  it.each(['claude', 'codex', 'copilot'])(
    'read remediation pass context and avoid direct platform commands for %s',
    (agent) => {
      const prompt = readFileSync(
        new URL(`../../src/prompts/${agent}/pr_remediate.md`, import.meta.url),
        'utf-8'
      );

      expect(prompt).toContain('.shipper/input/review-threads.json');
      expect(prompt).toContain('.shipper/input/ci-status.json');
      expect(prompt).toContain('.shipper/input/pr-diff.patch');
      expect(prompt).toContain('.shipper/input/pass-info.json');
      expect(prompt).toContain('.shipper/output/replies/<comment-id>.md');
      expect(prompt).toContain('.shipper/output/result.json');
      expect(prompt).not.toContain('gh ');
      expect(prompt).not.toContain('gh\n');
      expect(prompt).not.toContain('`gh`');
      expect(prompt).not.toContain('gh-api-');
    }
  );
});

describe('setup_remediate prompts', () => {
  it.each(['claude', 'codex', 'copilot'])(
    'append PR text and keep transport in shipper for %s',
    (agent) => {
      const prompt = readFileSync(
        new URL(`../../src/prompts/${agent}/setup_remediate.md`, import.meta.url),
        'utf-8'
      );

      expect(prompt).toContain('Shipper already created the branch and PR');
      expect(prompt).toContain('append-pr: true');
      expect(prompt).not.toContain('append-issue: true');
      expect(prompt).not.toContain('gh pr create');
      expect(prompt).not.toContain('gh pr checks');
      expect(prompt).not.toContain('git push');
      expect(prompt).not.toContain('git checkout -b');
    }
  );
});

describe('bundled prompt frontmatter', () => {
  it('does not contain the retired append-user-input key', () => {
    for (const agent of ['claude', 'codex', 'copilot']) {
      const promptDir = new URL(`../../src/prompts/${agent}/`, import.meta.url);
      const promptFiles = readdirSync(promptDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
        .map((entry) => entry.name);

      for (const promptFile of promptFiles) {
        const prompt = readFileSync(new URL(promptFile, promptDir), 'utf-8');
        const { frontmatter } = parseFrontmatter(prompt);
        const frontmatterRecord = frontmatter as Record<string, unknown>;
        expect(
          frontmatterRecord['append-user-input'],
          `${agent}/${promptFile} still exposes append-user-input in parsed frontmatter`
        ).toBeUndefined();
        expect(
          prompt,
          `${agent}/${promptFile} still contains append-user-input as a frontmatter key`
        ).not.toMatch(/(^|\n)append-user-input\s*:/m);
      }
    }
  });
});

describe('setup prompts', () => {
  it.each(['claude', 'codex', 'copilot'])(
    'document PR-check scaffolding and ruleset protection for %s',
    (agent) => {
      const prompt = readFileSync(
        new URL(`../../src/prompts/${agent}/setup.md`, import.meta.url),
        'utf-8'
      );

      expect(prompt).toContain('### 2. Generate agent configuration file');
      expect(prompt).toContain('### 3. Scaffold PR checks (if missing)');
      expect(prompt).toContain('### 4. Settings health check');
      expect(prompt.indexOf('### 3. Scaffold PR checks (if missing)')).toBeGreaterThan(
        prompt.indexOf('### 2. Generate agent configuration file')
      );
      expect(prompt.indexOf('### 4. Settings health check')).toBeGreaterThan(
        prompt.indexOf('### 3. Scaffold PR checks (if missing)')
      );
      expect(prompt).toContain('.github/workflows/pr-checks.yml');
      expect(prompt).toContain('Present the inferred command list to the user');
      expect(prompt).toContain('Describe the planned workflow in natural language only.');
      expect(prompt).toContain('do not overwrite it; explain why and skip the write');
      expect(prompt).toContain('gh api repos/{owner}/{repo} --jq .default_branch');
      expect(prompt).toContain('gh api repos/{owner}/{repo}/rulesets -X POST');
      expect(prompt).toContain('Include the required `name` field in the ruleset payload');
      expect(prompt).toContain('required_status_checks');
      expect(prompt).toContain('use the `workflows` rule type, not `required_workflows`');
      expect(prompt).toContain('gh api repos/{owner}/{repo} --jq .id');
      expect(prompt).toContain('repository_id');
      expect(prompt).toContain(
        'The `commands.default.agent` field matches the installed coding agent (`"claude"`, `"codex"`, or `"copilot"`).'
      );
      expect(prompt).toContain('commands.groom.disableMcp = true');
      expect(prompt).toContain('commands.default.disableMcp');
      expect(prompt).toContain('`disableMcp` must be a boolean');
      expect(prompt).toContain('Per-command agent, mode, model, and MCP-loading settings.');
      expect(prompt).toContain('Do not add a YAML parser dependency.');
      expect(prompt).toContain('pull_request_target');
      expect(prompt).toContain(
        'Shipper recommends adding lint, format-check, type-check, test, and build scripts'
      );
      expect(prompt).toContain('branch protections');
      expect(prompt).toContain('do not send an empty `required_status_checks` rule');
    }
  );
});

describe('implement prompts', () => {
  it.each(['claude', 'codex', 'copilot'])(
    'warn against force-adding .shipper files for %s',
    (agent) => {
      const prompt = readFileSync(
        new URL(`../../src/prompts/${agent}/implement.md`, import.meta.url),
        'utf-8'
      );

      expect(prompt).toContain('.shipper/');
      expect(prompt).toContain('git add -f');
      expect(prompt).toContain('git add --force');
      expect(prompt).toContain('stale artifacts');
      expect(prompt).toContain('downstream stage failures');
      expect(prompt).toContain('restores output files');
    }
  );
});

describe('new prompts', () => {
  it.each(['claude', 'codex', 'copilot'])(
    'require grounded research and product-only interpretation for %s',
    (agent) => {
      const prompt = readFileSync(
        new URL(`../../src/prompts/${agent}/new.md`, import.meta.url),
        'utf-8'
      );

      expect(prompt).toContain(expectedRelevantDocumentationSection);
      expect(prompt).toContain(
        'You **must read the codebase** (`Read`, `Glob`, `Grep`) to ground the issue before writing the Interpretation section.'
      );
      expect(prompt).toContain(
        "Capture the user's request as faithfully as possible without adding requirements, inferred scope, gap-filling, or expected outcomes beyond what they said."
      );
      expect(prompt).toContain(
        "This section is authoritative and must remain a faithful capture of the user's original words and intent."
      );
      expect(prompt).toContain(
        'Keep this section product-oriented: if the original request includes technical references, restate the intent without carrying those details into this section.'
      );
      expect(prompt).toContain(
        'Your product-level inferences, assumptions, gap-filling, inferred scope, and expected outcomes go here as tentative intake-stage context'
      );
      expect(prompt).toContain(
        '**No technical content in this section:** no file paths, module or component names, class/function names, API shapes, data schemas, library or technology choices, or implementation approaches.'
      );
      expect(prompt).toContain(
        'Technical pointers belong in Starting Point or Relevant Documentation.'
      );
      expect(prompt).toContain(
        'Technical references — file paths, module or component names, class/function names, API shapes, data schemas, and library or technology choices — are permitted **only** in the Starting Point and Relevant Documentation sections. The Request and Interpretation sections must stay product-oriented.'
      );
    }
  );

  it.each(['claude', 'codex', 'copilot'])(
    'renders non-binding Interpretation marker and keeps Request authoritative for %s',
    (agent) => {
      const prompt = readFileSync(
        new URL(`../../src/prompts/${agent}/new.md`, import.meta.url),
        'utf-8'
      );

      expect(prompt).toContain('# Interpretation');
      expect(prompt).toContain(nonBindingIntakeMarker);
      expect(prompt).toContain(
        'The rendered GitHub issue body must begin this section with this exact line'
      );
      expect(prompt).toContain('before any assumptions or before the self-contained fallback');
      expect(prompt).toContain('The Request section remains the source of truth.');
      expect(prompt).toContain(
        'This section is authoritative and must remain a faithful capture of the user'
      );
      expect(prompt).toContain(
        'assumptions, gap-filling, inferred scope, and expected outcomes go here as tentative intake-stage context'
      );
    }
  );
});

describe('plan/design escape-hatch softening', () => {
  it.each([
    'claude/plan',
    'codex/plan',
    'copilot/plan',
    'claude/design',
    'codex/design',
    'copilot/design',
  ])('narrows verdict: fail triggers to stage-blocking failures in %s', (path) => {
    const prompt = readFileSync(new URL(`../../src/prompts/${path}.md`, import.meta.url), 'utf-8');

    expect(prompt).toContain(
      "`verdict: fail` is reserved for failures that block this stage's own work."
    );
    expect(prompt).toContain(
      'The agent cannot read the repository or the issue body it needs as input.'
    );
    expect(prompt).toContain('The agent cannot write output files under `.shipper/output/`');
    expect(prompt).toContain('exercise the feature under study');
    expect(prompt).toContain('**does not trigger the escape hatch**');
    expect(prompt).toContain('**In the plan stage:**');
    expect(prompt).toContain('**In the design stage:**');
    expect(prompt).not.toContain('Missing CLI tools, language runtimes, or build toolchains');
  });

  it('keeps the escape-hatch block byte-identical across all six plan/design prompts', () => {
    const paths = [
      'claude/plan',
      'codex/plan',
      'copilot/plan',
      'claude/design',
      'codex/design',
      'copilot/design',
    ];
    const referenceBlock = extractEnvironmentFailureEscapeHatch(
      readFileSync(new URL(`../../src/prompts/${paths[0]}.md`, import.meta.url), 'utf-8')
    );

    for (const path of paths.slice(1)) {
      const prompt = readFileSync(
        new URL(`../../src/prompts/${path}.md`, import.meta.url),
        'utf-8'
      );

      expect(extractEnvironmentFailureEscapeHatch(prompt)).toBe(referenceBlock);
    }
  });
});

describe('implement/unblock/pr_review escape-hatch softening', () => {
  const implementPaths = ['claude/implement', 'codex/implement', 'copilot/implement'];
  const unblockPaths = ['claude/unblock', 'codex/unblock', 'copilot/unblock'];
  const prReviewPaths = ['claude/pr_review', 'codex/pr_review', 'copilot/pr_review'];
  const updatedPaths = [...implementPaths, ...unblockPaths, ...prReviewPaths];

  it.each(updatedPaths)(
    'narrows verdict: fail triggers to stage-blocking failures in %s',
    (path) => {
      const prompt = readFileSync(
        new URL(`../../src/prompts/${path}.md`, import.meta.url),
        'utf-8'
      );

      expect(prompt).toContain(
        "`verdict: fail` is reserved for failures that block this stage's own work."
      );
      expect(prompt).toContain('The agent cannot write output files under `.shipper/output/`');
      expect(prompt).not.toContain('Missing CLI tools, language runtimes, or build toolchains');
    }
  );

  it.each([...implementPaths, ...unblockPaths])(
    'uses repository-or-issue input wording in %s',
    (path) => {
      const prompt = readFileSync(
        new URL(`../../src/prompts/${path}.md`, import.meta.url),
        'utf-8'
      );

      expect(prompt).toContain(
        'The agent cannot read the repository or the issue body it needs as input.'
      );
    }
  );

  it.each(prReviewPaths)('uses review-input wording in %s', (path) => {
    const prompt = readFileSync(new URL(`../../src/prompts/${path}.md`, import.meta.url), 'utf-8');

    expect(prompt).toContain('The agent cannot read the review inputs under `.shipper/input/`');
  });

  it('keeps the escape-hatch block byte-identical across implement prompts', () => {
    const referenceBlock = extractEnvironmentFailureEscapeHatch(
      readFileSync(new URL(`../../src/prompts/${implementPaths[0]}.md`, import.meta.url), 'utf-8')
    );

    for (const path of implementPaths.slice(1)) {
      const prompt = readFileSync(
        new URL(`../../src/prompts/${path}.md`, import.meta.url),
        'utf-8'
      );

      expect(extractEnvironmentFailureEscapeHatch(prompt)).toBe(referenceBlock);
    }
  });

  it('keeps the escape-hatch block byte-identical across unblock prompts', () => {
    const referenceBlock = extractEnvironmentFailureEscapeHatch(
      readFileSync(new URL(`../../src/prompts/${unblockPaths[0]}.md`, import.meta.url), 'utf-8')
    );

    for (const path of unblockPaths.slice(1)) {
      const prompt = readFileSync(
        new URL(`../../src/prompts/${path}.md`, import.meta.url),
        'utf-8'
      );

      expect(extractEnvironmentFailureEscapeHatch(prompt)).toBe(referenceBlock);
    }
  });

  it('keeps the escape-hatch block byte-identical across pr_review prompts', () => {
    const referenceBlock = extractEnvironmentFailureEscapeHatch(
      readFileSync(new URL(`../../src/prompts/${prReviewPaths[0]}.md`, import.meta.url), 'utf-8')
    );

    for (const path of prReviewPaths.slice(1)) {
      const prompt = readFileSync(
        new URL(`../../src/prompts/${path}.md`, import.meta.url),
        'utf-8'
      );

      expect(extractEnvironmentFailureEscapeHatch(prompt)).toBe(referenceBlock);
    }
  });
});

describe('implement deferred-verification clause', () => {
  const implementPaths = ['claude/implement', 'codex/implement', 'copilot/implement'];
  const nonImplementPaths = [
    'claude/unblock',
    'codex/unblock',
    'copilot/unblock',
    'claude/pr_review',
    'codex/pr_review',
    'copilot/pr_review',
  ];

  it.each(implementPaths)('locks in the implement-only wording in %s', (path) => {
    const prompt = readFileSync(new URL(`../../src/prompts/${path}.md`, import.meta.url), 'utf-8');

    expect(prompt).toContain('prescribed by the implementation plan');
    expect(prompt).toContain('refused by the sandbox');
    expect(prompt).toContain('deferred to review');
  });

  it.each(nonImplementPaths)(
    'keeps implement-only deferred-verification wording out of %s',
    (path) => {
      const prompt = readFileSync(
        new URL(`../../src/prompts/${path}.md`, import.meta.url),
        'utf-8'
      );

      expect(prompt).not.toContain('prescribed by the implementation plan');
      expect(prompt).not.toContain('refused by the sandbox');
      expect(prompt).not.toContain('deferred to review');
    }
  );
});
