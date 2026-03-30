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
    'describe relevant documentation scanning and labeling for %s',
    (agent) => {
      const prompt = readFileSync(
        new URL(`../../src/prompts/${agent}/new.md`, import.meta.url),
        'utf-8'
      );

      expect(prompt).toContain(expectedRelevantDocumentationSection);
      expect(prompt).toContain(
        'File paths or module names are allowed only in the optional Starting Point and Relevant Documentation sections.'
      );
    }
  );
});
