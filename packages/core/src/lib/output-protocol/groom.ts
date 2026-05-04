import { readFile } from 'node:fs/promises';

import {
  BLOCKED_LABEL,
  GROOMED_LABEL,
  NEW_LABEL,
  PRIORITY_HIGH_LABEL,
  PRIORITY_LOW_LABEL,
} from '../labels.js';
import { type ResultJson } from '../result-schema.js';
import { toErrorMessage } from '../errors.js';
import { gh } from '../gh.js';
import { resolveOutputPath } from './protocol-io.js';

export type GroomPriority = 'high' | 'normal' | 'low';
export type GroomDecompositionKind = 'none' | 'partial' | 'full';

export interface GroomBlocked {
  comment_file: string;
  depends_on_child_index?: number;
}

export interface GroomParent {
  title?: string;
  body_file?: string;
  priority: GroomPriority;
  blocked?: GroomBlocked;
}

export interface GroomChildIssue {
  title: string;
  body_file: string;
  grooming_comment_file: string;
  priority?: GroomPriority;
  blocked?: GroomBlocked;
}

export interface GroomManifest {
  parent: GroomParent;
  decomposition: {
    kind: GroomDecompositionKind;
    children: GroomChildIssue[];
  };
}

export interface LoadedOutputFile {
  path: string;
  text: string;
}

export interface LoadedGroomFiles {
  parentBody?: LoadedOutputFile;
  parentBlockedComment?: LoadedOutputFile;
  children: Array<{
    body: LoadedOutputFile;
    groomingComment: LoadedOutputFile;
    blockedComment?: LoadedOutputFile;
  }>;
}

export interface LoadedGroomManifest {
  abs: string;
  manifest: GroomManifest;
  files: LoadedGroomFiles;
}

interface StepRecord {
  name: string;
  status: 'succeeded' | 'failed' | 'skipped';
  detail?: string;
}

interface ChildCreation {
  number: number;
  url: string;
}

export class GroomPostFlightError extends Error {
  readonly steps: StepRecord[];

  constructor(message: string, steps: StepRecord[]) {
    super(message);
    this.name = 'GroomPostFlightError';
    this.steps = steps;
  }
}

const GROOM_PRIORITIES = new Set<GroomPriority>(['high', 'normal', 'low']);
const DECOMPOSITION_KINDS = new Set<GroomDecompositionKind>(['none', 'partial', 'full']);
const REQUIRED_GROOMED_HEADINGS = [
  '# Summary',
  '# Requirements',
  '# Acceptance Criteria',
  '# Related Issues',
  '# Out of Scope',
  '# Open Questions',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function validateStringField(
  data: Record<string, unknown>,
  field: string,
  label: string,
  errors: string[],
  required = true
): string | undefined {
  const value = data[field];
  if (value === undefined && !required) {
    return undefined;
  }
  const parsed = nonEmptyString(value);
  if (!parsed) {
    errors.push(`'${label}.${field}' must be a non-empty string`);
  }
  return parsed;
}

function validatePriority(
  value: unknown,
  label: string,
  errors: string[]
): GroomPriority | undefined {
  if (typeof value !== 'string' || !GROOM_PRIORITIES.has(value as GroomPriority)) {
    errors.push(`'${label}' must be one of: high, normal, low`);
    return undefined;
  }
  return value as GroomPriority;
}

function validateBlocked(
  value: unknown,
  label: string,
  errors: string[]
): GroomBlocked | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    errors.push(`'${label}' must be an object`);
    return undefined;
  }

  const commentFile = validateStringField(value, 'comment_file', label, errors);
  const dependsOn = value.depends_on_child_index;
  if (
    dependsOn !== undefined &&
    (typeof dependsOn !== 'number' || !Number.isInteger(dependsOn) || dependsOn < 0)
  ) {
    errors.push(`'${label}.depends_on_child_index' must be a non-negative integer`);
  }

  if (!commentFile) {
    return undefined;
  }

  return {
    comment_file: commentFile,
    ...(typeof dependsOn === 'number' && Number.isInteger(dependsOn) && dependsOn >= 0
      ? { depends_on_child_index: dependsOn }
      : {}),
  };
}

function parseManifest(data: unknown, errors: string[]): GroomManifest | undefined {
  if (!isRecord(data)) {
    errors.push('groom manifest must be a JSON object');
    return undefined;
  }

  if (!isRecord(data.parent)) {
    errors.push("'parent' must be an object");
    return undefined;
  }
  if (!isRecord(data.decomposition)) {
    errors.push("'decomposition' must be an object");
    return undefined;
  }

  const title = validateStringField(data.parent, 'title', 'parent', errors, false);
  const bodyFile = validateStringField(data.parent, 'body_file', 'parent', errors, false);
  const parentPriority = validatePriority(data.parent.priority, 'parent.priority', errors);
  const parentBlocked = validateBlocked(data.parent.blocked, 'parent.blocked', errors);

  const kindValue = data.decomposition.kind;
  if (
    typeof kindValue !== 'string' ||
    !DECOMPOSITION_KINDS.has(kindValue as GroomDecompositionKind)
  ) {
    errors.push("'decomposition.kind' must be one of: none, partial, full");
  }
  const kind = kindValue as GroomDecompositionKind;

  if (!Array.isArray(data.decomposition.children)) {
    errors.push("'decomposition.children' must be an array");
  }
  const childInputs = Array.isArray(data.decomposition.children) ? data.decomposition.children : [];
  const children: GroomChildIssue[] = [];
  childInputs.forEach((child, index) => {
    const label = `decomposition.children[${index}]`;
    if (!isRecord(child)) {
      errors.push(`'${label}' must be an object`);
      return;
    }

    const childTitle = validateStringField(child, 'title', label, errors);
    const childBody = validateStringField(child, 'body_file', label, errors);
    const childComment = validateStringField(child, 'grooming_comment_file', label, errors);
    const childPriority =
      child.priority === undefined
        ? undefined
        : validatePriority(child.priority, `${label}.priority`, errors);
    const childBlocked = validateBlocked(child.blocked, `${label}.blocked`, errors);

    if (!childTitle || !childBody || !childComment) {
      return;
    }
    children.push({
      title: childTitle,
      body_file: childBody,
      grooming_comment_file: childComment,
      ...(childPriority ? { priority: childPriority } : {}),
      ...(childBlocked ? { blocked: childBlocked } : {}),
    });
  });

  if (!parentPriority || !DECOMPOSITION_KINDS.has(kind)) {
    return undefined;
  }

  return {
    parent: {
      ...(title ? { title } : {}),
      ...(bodyFile ? { body_file: bodyFile } : {}),
      priority: parentPriority,
      ...(parentBlocked ? { blocked: parentBlocked } : {}),
    },
    decomposition: { kind, children },
  };
}

async function readOutputText(
  cwd: string,
  relativePath: string,
  label: string,
  errors: string[]
): Promise<LoadedOutputFile | undefined> {
  let abs: string;
  try {
    abs = resolveOutputPath(cwd, relativePath, label);
  } catch (error) {
    errors.push(toErrorMessage(error));
    return undefined;
  }

  try {
    return { path: abs, text: await readFile(abs, 'utf-8') };
  } catch (error) {
    errors.push(`${label} does not exist or cannot be read: ${abs}: ${toErrorMessage(error)}`);
    return undefined;
  }
}

export function priorityLabelsForGroomPriority(priority: GroomPriority): {
  add: string[];
  remove: string[];
} {
  if (priority === 'high') {
    return { add: [PRIORITY_HIGH_LABEL], remove: [PRIORITY_LOW_LABEL] };
  }
  if (priority === 'low') {
    return { add: [PRIORITY_LOW_LABEL], remove: [PRIORITY_HIGH_LABEL] };
  }
  return { add: [], remove: [PRIORITY_HIGH_LABEL, PRIORITY_LOW_LABEL] };
}

export function assertGroomedBody(body: string, label: string, errors: string[]): void {
  for (const heading of REQUIRED_GROOMED_HEADINGS) {
    if (!body.includes(heading)) {
      errors.push(`${label} must contain standard groomed issue heading '${heading}'`);
    }
  }
}

export function replaceBlockingIssuePlaceholder(comment: string, issueNumber: number): string {
  return comment.replaceAll('{{blocking_issue}}', `#${issueNumber}`);
}

async function validateLoadedFiles(
  cwd: string,
  manifest: GroomManifest,
  errors: string[]
): Promise<LoadedGroomFiles> {
  const parentBody = manifest.parent.body_file
    ? await readOutputText(cwd, manifest.parent.body_file, 'parent body_file', errors)
    : undefined;
  const parentBlockedComment = manifest.parent.blocked
    ? await readOutputText(
        cwd,
        manifest.parent.blocked.comment_file,
        'parent blocked comment_file',
        errors
      )
    : undefined;

  const children = await Promise.all(
    manifest.decomposition.children.map(async (child, index) => {
      const body = await readOutputText(
        cwd,
        child.body_file,
        `child ${index + 1} body_file`,
        errors
      );
      const groomingComment = await readOutputText(
        cwd,
        child.grooming_comment_file,
        `child ${index + 1} grooming_comment_file`,
        errors
      );
      const blockedComment = child.blocked
        ? await readOutputText(
            cwd,
            child.blocked.comment_file,
            `child ${index + 1} blocked comment_file`,
            errors
          )
        : undefined;

      return { body, groomingComment, blockedComment };
    })
  );

  if (parentBody) {
    assertGroomedBody(parentBody.text, 'parent body_file', errors);
  }

  if (parentBlockedComment && !parentBlockedComment.text.startsWith('## Blocked')) {
    errors.push('parent blocked comment_file must start with ## Blocked');
  }

  manifest.decomposition.children.forEach((child, index) => {
    const loaded = children[index];
    if (loaded?.body) {
      assertGroomedBody(loaded.body.text, `child ${index + 1} body_file`, errors);
    }
    if (child.blocked && loaded?.blockedComment) {
      if (!loaded.blockedComment.text.startsWith('## Blocked')) {
        errors.push(`child ${index + 1} blocked comment_file must start with ## Blocked`);
      }
      if (
        child.blocked.depends_on_child_index !== undefined &&
        !loaded.blockedComment.text.includes('{{blocking_issue}}')
      ) {
        errors.push(
          `child ${index + 1} blocked comment_file must include {{blocking_issue}} when depends_on_child_index is set`
        );
      }
    }
  });

  if (
    manifest.parent.blocked?.depends_on_child_index !== undefined &&
    parentBlockedComment &&
    !parentBlockedComment.text.includes('{{blocking_issue}}')
  ) {
    errors.push(
      'parent blocked comment_file must include {{blocking_issue}} when depends_on_child_index is set'
    );
  }

  return {
    ...(parentBody ? { parentBody } : {}),
    ...(parentBlockedComment ? { parentBlockedComment } : {}),
    children: children.map((child, index) => {
      if (!child.body || !child.groomingComment) {
        throw new Error(`child ${index + 1} files failed validation`);
      }
      return {
        body: child.body,
        groomingComment: child.groomingComment,
        ...(child.blockedComment ? { blockedComment: child.blockedComment } : {}),
      };
    }),
  };
}

function validateManifestState(manifest: GroomManifest, errors: string[]): void {
  const { kind, children } = manifest.decomposition;

  if (kind === 'none' && children.length > 0) {
    errors.push("'decomposition.children' must be empty when kind is none");
  }
  if ((kind === 'partial' || kind === 'full') && children.length === 0) {
    errors.push("'decomposition.children' must not be empty when kind is partial or full");
  }
  if (kind === 'full' && manifest.parent.body_file) {
    errors.push("'parent.body_file' must be omitted when decomposition.kind is full");
  }
  if ((kind === 'none' || kind === 'partial') && !manifest.parent.body_file) {
    errors.push("'parent.body_file' is required when decomposition.kind is none or partial");
  }

  const parentDependency = manifest.parent.blocked?.depends_on_child_index;
  if (parentDependency !== undefined && parentDependency >= children.length) {
    errors.push("'parent.blocked.depends_on_child_index' must point at an existing child");
  }

  children.forEach((child, index) => {
    const dependency = child.blocked?.depends_on_child_index;
    if (dependency === undefined) {
      return;
    }
    if (dependency >= children.length) {
      errors.push(
        `'decomposition.children[${index}].blocked.depends_on_child_index' must point at an existing child`
      );
    }
    if (dependency >= index) {
      errors.push(
        `'decomposition.children[${index}].blocked.depends_on_child_index' must point at an earlier child`
      );
    }
  });
}

export async function readGroomManifest(
  cwd: string,
  manifestPath: string
): Promise<LoadedGroomManifest> {
  const abs = resolveOutputPath(cwd, manifestPath, 'groom manifest path');
  let raw: string;
  try {
    raw = await readFile(abs, 'utf-8');
  } catch (error) {
    throw new Error(`Failed to read groom manifest at ${abs}: ${toErrorMessage(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Failed to parse groom manifest at ${abs}: ${toErrorMessage(error)}`);
  }

  const errors: string[] = [];
  const manifest = parseManifest(parsed, errors);
  if (manifest) {
    validateManifestState(manifest, errors);
  }

  let files: LoadedGroomFiles | undefined;
  if (manifest) {
    try {
      files = await validateLoadedFiles(cwd, manifest, errors);
    } catch {
      // validateLoadedFiles has already pushed precise file errors.
    }
  }

  if (!manifest || !files || errors.length > 0) {
    throw new Error(`Invalid groom manifest at ${abs}:\n- ${errors.join('\n- ')}`);
  }

  return { abs, manifest, files };
}

function parseIssueNumberFromUrl(url: string): number {
  const pathname = new URL(url).pathname;
  const match = /\/issues\/(\d+)\/?$/.exec(pathname);
  const issueNumber = Number(match?.[1]);
  if (!match?.[1] || !Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`Failed to parse issue number from URL: ${url}`);
  }
  return issueNumber;
}

function childLabels(child: GroomChildIssue, parentPriority: GroomPriority): string[] {
  const labels = [GROOMED_LABEL];
  if (child.blocked) {
    labels.push(BLOCKED_LABEL);
  }
  const priority = child.priority ?? parentPriority;
  if (priority === 'high') {
    labels.push(PRIORITY_HIGH_LABEL);
  } else if (priority === 'low') {
    labels.push(PRIORITY_LOW_LABEL);
  }
  return labels;
}

function parentLabelArgs(parent: GroomParent): string[] {
  const priorityLabels = priorityLabelsForGroomPriority(parent.priority);
  const add = [GROOMED_LABEL, ...priorityLabels.add];
  const remove = [NEW_LABEL, ...priorityLabels.remove];

  if (parent.blocked) {
    add.push(BLOCKED_LABEL);
  } else {
    remove.push(BLOCKED_LABEL);
  }

  const args: string[] = [];
  for (const label of add) {
    args.push('--add-label', label);
  }
  for (const label of remove) {
    args.push('--remove-label', label);
  }
  return args;
}

function formatFailureComment(steps: StepRecord[]): string {
  const formatList = (status: StepRecord['status']) => {
    const filtered = steps.filter((step) => step.status === status);
    return filtered.length > 0
      ? filtered.map((step) => `- ${step.name}${step.detail ? `: ${step.detail}` : ''}`).join('\n')
      : '- (none)';
  };

  return [
    '## Groom Post-flight Failure',
    '',
    'The groom agent produced valid artifacts, but Shipper could not apply every GitHub update. Successful writes were not rolled back, and the issue remains on `shipper:new` so grooming can be retried.',
    '',
    '### Succeeded',
    '',
    formatList('succeeded'),
    '',
    '### Failed',
    '',
    formatList('failed'),
    '',
    '### Skipped',
    '',
    formatList('skipped'),
  ].join('\n');
}

function decompositionComment(children: ChildCreation[]): string {
  return [
    '## Decomposed',
    '',
    'Grooming split this issue into child issues:',
    '',
    ...children.map((child) => `- #${child.number}: ${child.url}`),
  ].join('\n');
}

export async function processGroomResult(opts: {
  repo: string;
  issueNumber: string;
  cwd: string;
  result: ResultJson;
}): Promise<ResultJson> {
  const { repo, issueNumber, cwd, result } = opts;
  if (result.verdict !== 'accept') {
    throw new Error('groom post-flight requires an accept result');
  }
  if (!result.groom) {
    throw new Error('groom post-flight requires result.groom');
  }

  const commentPath = resolveOutputPath(cwd, result.comment, 'comment path');
  const { manifest, files } = await readGroomManifest(cwd, result.groom);
  const steps: StepRecord[] = [];
  const children: Array<ChildCreation | undefined> = [];

  const record = (step: StepRecord) => {
    steps.push(step);
  };
  const hasFailed = () => steps.some((step) => step.status === 'failed');
  const run = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      record({ name, status: 'succeeded' });
    } catch (error) {
      record({ name, status: 'failed', detail: toErrorMessage(error) });
    }
  };
  const skip = (name: string, detail: string) => {
    record({ name, status: 'skipped', detail });
  };

  if (manifest.decomposition.kind !== 'full') {
    const args = ['issue', 'edit', issueNumber, '-R', repo];
    if (manifest.parent.title) {
      args.push('--title', manifest.parent.title);
    }
    if (files.parentBody) {
      args.push('--body-file', files.parentBody.path);
    }
    await run('update parent issue', () => gh(args).then(() => undefined));
  }

  await run('post parent grooming summary', () =>
    gh(['issue', 'comment', issueNumber, '-R', repo, '--body-file', commentPath]).then(
      () => undefined
    )
  );

  for (const [index, child] of manifest.decomposition.children.entries()) {
    const labels = childLabels(child, manifest.parent.priority);
    const args = [
      'issue',
      'create',
      '-R',
      repo,
      '--title',
      child.title,
      '--body-file',
      files.children[index]?.body.path ?? child.body_file,
    ];
    for (const label of labels) {
      args.push('--label', label);
    }

    try {
      const { stdout } = await gh(args);
      const url = stdout.trim();
      const number = parseIssueNumberFromUrl(url);
      children[index] = { number, url };
      record({ name: `create child ${index + 1}`, status: 'succeeded' });
    } catch (error) {
      record({
        name: `create child ${index + 1}`,
        status: 'failed',
        detail: toErrorMessage(error),
      });
    }
  }

  for (const [index, child] of manifest.decomposition.children.entries()) {
    const created = children[index];
    if (!created) {
      skip(`post child ${index + 1} grooming comment`, 'child creation failed');
      continue;
    }
    const commentFile = files.children[index]?.groomingComment.path;
    await run(`post child ${index + 1} grooming comment`, () =>
      gh([
        'issue',
        'comment',
        String(created.number),
        '-R',
        repo,
        '--body-file',
        commentFile ?? '',
      ]).then(() => undefined)
    );

    if (!child.blocked) {
      continue;
    }
    const dependencyIndex = child.blocked.depends_on_child_index;
    const blockedFile = files.children[index]?.blockedComment;
    if (!blockedFile) {
      skip(`post child ${index + 1} blocked comment`, 'blocked comment file failed validation');
      continue;
    }
    let blockedArgs: string[];
    if (dependencyIndex === undefined) {
      blockedArgs = [
        'issue',
        'comment',
        String(created.number),
        '-R',
        repo,
        '--body-file',
        blockedFile.path,
      ];
    } else {
      const blockingChild = children[dependencyIndex];
      if (!blockingChild) {
        skip(`post child ${index + 1} blocked comment`, 'blocking child creation failed');
        continue;
      }
      blockedArgs = [
        'issue',
        'comment',
        String(created.number),
        '-R',
        repo,
        '--body',
        replaceBlockingIssuePlaceholder(blockedFile.text, blockingChild.number),
      ];
    }
    await run(`post child ${index + 1} blocked comment`, () =>
      gh(blockedArgs).then(() => undefined)
    );
  }

  if (manifest.parent.blocked) {
    const dependencyIndex = manifest.parent.blocked.depends_on_child_index;
    if (!files.parentBlockedComment) {
      skip('post parent blocked comment', 'blocked comment file failed validation');
    } else {
      let blockedArgs: string[] | undefined;
      if (dependencyIndex === undefined) {
        blockedArgs = [
          'issue',
          'comment',
          issueNumber,
          '-R',
          repo,
          '--body-file',
          files.parentBlockedComment.path,
        ];
      } else {
        const blockingChild = children[dependencyIndex];
        if (!blockingChild) {
          skip('post parent blocked comment', 'blocking child creation failed');
        } else {
          blockedArgs = [
            'issue',
            'comment',
            issueNumber,
            '-R',
            repo,
            '--body',
            replaceBlockingIssuePlaceholder(files.parentBlockedComment.text, blockingChild.number),
          ];
        }
      }
      if (blockedArgs) {
        await run('post parent blocked comment', () => gh(blockedArgs).then(() => undefined));
      }
    }
  }

  if (manifest.decomposition.kind === 'full') {
    const allChildrenCreated =
      manifest.decomposition.children.length > 0 &&
      children.filter(Boolean).length === manifest.decomposition.children.length;
    if (!allChildrenCreated) {
      skip('post parent decomposition comment', 'not all children were created');
      skip('close parent issue', 'not all children were created');
    } else {
      const childList = children.filter((child): child is ChildCreation => child !== undefined);
      const body = decompositionComment(childList);
      await run('post parent decomposition comment', () =>
        gh(['issue', 'comment', issueNumber, '-R', repo, '--body', body]).then(() => undefined)
      );
      await run('close parent issue', () =>
        gh(['issue', 'close', issueNumber, '-R', repo, '--comment', body]).then(() => undefined)
      );
    }
  } else if (hasFailed()) {
    skip('apply parent labels', 'one or more earlier post-flight operations failed');
  } else {
    await run('apply parent labels', () =>
      gh(['issue', 'edit', issueNumber, '-R', repo, ...parentLabelArgs(manifest.parent)]).then(
        () => undefined
      )
    );
  }

  if (!hasFailed()) {
    return result;
  }

  const failureBody = formatFailureComment(steps);
  try {
    await gh(['issue', 'comment', issueNumber, '-R', repo, '--body', failureBody]);
  } catch (error) {
    throw new GroomPostFlightError(
      `Groom post-flight failed, and posting the failure comment also failed: ${toErrorMessage(error)}`,
      steps
    );
  }

  throw new GroomPostFlightError('Groom post-flight failed; posted failure comment', steps);
}
