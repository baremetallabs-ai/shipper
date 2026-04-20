import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

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
      expect(prompt).toContain('--remove-label "shipper:priority-low"');
      expect(prompt).toContain('--remove-label "shipper:priority-high"');
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
      expect(prompt).toContain(
        'gh issue close <ISSUE> --reason "not planned" --comment "Closing as duplicate of #<N> — <original issue title>."'
      );
      expect(prompt).toContain('--remove-label "shipper:new"');
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

      expect(prompt).toContain(
        'After creating each child issue, post a **scoped grooming comment** on it.'
      );
      expect(prompt).toContain('do not copy the entire parent grooming summary');
      expect(prompt).toContain('Always exclude the **decomposition recommendation** section.');
      expect(prompt).toContain(
        'Groomed as part of #<number> — see parent for full grooming context.'
      );
      expect(prompt).toContain(
        'gh issue comment <child_number> --body-file ./.shipper/tmp/child_grooming_comment-<child_number>.md'
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
        "Capture the user's request as faithfully as possible without adding requirements or expanding scope beyond what they said."
      );
      expect(prompt).toContain(
        'Keep this section product-oriented: if the original request includes technical references, restate the intent without carrying those details into this section.'
      );
      expect(prompt).toContain(
        'Your product-level inferences, assumptions, and gap-filling go here — user-facing behavior, scope assumptions, expected outcomes.'
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

describe('implement/unblock escape hatch stays broad', () => {
  it.each([
    'claude/implement',
    'codex/implement',
    'copilot/implement',
    'claude/unblock',
    'codex/unblock',
    'copilot/unblock',
  ])('preserves the original broad escape-hatch wording in %s', (path) => {
    const prompt = readFileSync(new URL(`../../src/prompts/${path}.md`, import.meta.url), 'utf-8');

    expect(prompt).toContain(
      'If a failure is caused by the **environment, sandbox, or repository configuration**'
    );
    expect(prompt).toContain(
      'Sandbox permission denials (file system, network, or process restrictions)'
    );
    expect(prompt).toContain('Missing CLI tools, language runtimes, or build toolchains');
  });
});
