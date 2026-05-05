import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const {
  mockExecuteReset,
  mockExtractFinalMessage,
  mockFetchIssue,
  mockFindLatestSessionMeta,
  mockGh,
  mockGetWorktreeRepoName,
  mockIsLockStale,
  mockListIssues,
  mockReadFile,
  mockReadResultFile,
  mockReleaseLock,
  mockResolveSessionRepo,
  mockScanArtifacts,
  mockSpawnShipper,
  mockStartShipper,
  mockTryResolvePr,
  mockBuildDocsCorpus,
  mockDocsGet,
  mockDocsSearch,
} = vi.hoisted(() => ({
  mockExecuteReset: vi.fn(),
  mockExtractFinalMessage: vi.fn(),
  mockFetchIssue: vi.fn(),
  mockFindLatestSessionMeta: vi.fn(),
  mockGh: vi.fn<(args: string[]) => Promise<{ stdout: string; stderr: string }>>(),
  mockGetWorktreeRepoName: vi.fn(),
  mockIsLockStale: vi.fn(),
  mockListIssues: vi.fn(),
  mockReadFile: vi.fn(),
  mockReadResultFile: vi.fn(),
  mockReleaseLock: vi.fn(),
  mockResolveSessionRepo: vi.fn(),
  mockScanArtifacts: vi.fn(),
  mockSpawnShipper: vi.fn(),
  mockStartShipper: vi.fn(),
  mockTryResolvePr: vi.fn(),
  mockBuildDocsCorpus: vi.fn(),
  mockDocsGet: vi.fn(),
  mockDocsSearch: vi.fn(),
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    readFile: mockReadFile,
  };
});

vi.mock('@baremetallabs-ai/shipper-core', async () => {
  const actual = await vi.importActual<typeof import('@baremetallabs-ai/shipper-core')>(
    '@baremetallabs-ai/shipper-core'
  );
  return {
    ...actual,
    executeReset: mockExecuteReset,
    extractFinalMessage: mockExtractFinalMessage,
    fetchIssue: mockFetchIssue,
    findLatestSessionMeta: mockFindLatestSessionMeta,
    getSettings: () => ({ agentTimeoutMinutes: 60 }),
    getWorktreeRepoName: mockGetWorktreeRepoName,
    gh: (args: string[]) => mockGh(args),
    isLockStale: mockIsLockStale,
    listIssues: mockListIssues,
    readResultFile: mockReadResultFile,
    releaseIssueLock: mockReleaseLock,
    resolveSessionRepo: mockResolveSessionRepo,
    scanArtifacts: mockScanArtifacts,
    tryResolvePrForIssue: mockTryResolvePr,
  };
});

vi.mock('../src/helpers.js', async () => {
  const actual = await vi.importActual<typeof import('../src/helpers.js')>('../src/helpers.js');
  return {
    ...actual,
    spawnShipper: mockSpawnShipper,
    startShipper: mockStartShipper,
  };
});

vi.mock('../src/docs/corpus.js', () => ({
  buildDocsCorpus: mockBuildDocsCorpus,
}));

import { registerInitErrorTools, registerTools, toolNames } from '../src/tools.js';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
}>;

type ToolSchema = Record<string, z.ZodType> | undefined;
type ToolGetter = ((name: string) => Handler) & {
  getSchema: (name: string) => ToolSchema;
  getAnnotations: (name: string) => ToolAnnotations | undefined;
  invokeValidated: (
    name: string,
    args: Record<string, unknown>
  ) => Promise<Awaited<ReturnType<Handler>>>;
  names: () => string[];
};

async function collectTools(): Promise<ToolGetter> {
  const registrations = new Map<
    string,
    { handler: Handler; inputSchema: ToolSchema; annotations?: ToolAnnotations }
  >();
  const mockServer = {
    registerTool: (
      name: string,
      config: { inputSchema?: ToolSchema; annotations?: ToolAnnotations } | undefined,
      handler: Handler
    ) => {
      registrations.set(name, {
        handler,
        inputSchema: config?.inputSchema,
        annotations: config?.annotations,
      });
    },
  };
  await registerTools(mockServer as unknown as Parameters<typeof registerTools>[0], 'owner/repo');
  const getRegistration = (name: string) => {
    const registration = registrations.get(name);
    if (!registration) {
      throw new Error(`Tool ${name} was not registered`);
    }
    return registration;
  };

  const getTool = ((name: string) => getRegistration(name).handler) as ToolGetter;
  getTool.getSchema = (name: string) => getRegistration(name).inputSchema;
  getTool.getAnnotations = (name: string) => getRegistration(name).annotations;
  getTool.invokeValidated = async (name: string, args: Record<string, unknown>) => {
    const registration = getRegistration(name);
    if (!registration.inputSchema) {
      return registration.handler(args);
    }

    const parsed = z.object(registration.inputSchema).safeParse(args);
    if (!parsed.success) {
      throw parsed.error;
    }

    return registration.handler(parsed.data);
  };
  getTool.names = () => [...registrations.keys()];
  return getTool;
}

function issueLabelsResponse(...labels: string[]): { stdout: string; stderr: string } {
  return issueLabelsStateResponse('OPEN', ...labels);
}

function issueLabelsStateResponse(
  state: 'OPEN' | 'CLOSED',
  ...labels: string[]
): { stdout: string; stderr: string } {
  return {
    stdout: JSON.stringify({
      number: 42,
      state,
      labels: labels.map((name) => ({ name })),
    }),
    stderr: '',
  };
}

function notPullRequestError(): Error & { stderr: string } {
  const error = new Error('GraphQL: Could not resolve to a PullRequest with the number of 42.');
  return Object.assign(error, {
    stderr: 'GraphQL: Could not resolve to a PullRequest with the number of 42.',
  });
}

function prProbeFailureError(): Error & { stderr: string } {
  const error = new Error('gh pr view failed');
  return Object.assign(error, {
    stderr: 'HTTP 500: upstream GitHub failure',
  });
}

function makeResetScan(
  overrides: Partial<{
    labelsToRemove: string[];
    addTarget: boolean;
    targetStage: 'new' | 'groomed' | 'designed' | 'planned' | 'implemented';
    targetLabel: string;
    commentIds: number[];
    prs: Array<{ number: number; headRefName: string }>;
    branchesToDelete: string[];
    localBranches: string[];
    localWorktrees: string[];
  }> = {}
): {
  labelsToRemove: string[];
  addTarget: boolean;
  targetStage: 'new' | 'groomed' | 'designed' | 'planned' | 'implemented';
  targetLabel: string;
  commentIds: number[];
  prs: Array<{ number: number; headRefName: string }>;
  branchesToDelete: string[];
  localBranches: string[];
  localWorktrees: string[];
} {
  return {
    labelsToRemove: [],
    addTarget: false,
    targetStage: 'new',
    targetLabel: 'shipper:new',
    commentIds: [],
    prs: [],
    branchesToDelete: [],
    localBranches: [],
    localWorktrees: [],
    ...overrides,
  };
}

async function expectZodError(promise: Promise<unknown>): Promise<z.ZodError> {
  try {
    await promise;
    throw new Error('Expected schema validation to fail.');
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      return error;
    }

    throw error;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveSessionRepo.mockResolvedValue({ repo: 'owner/repo', repoSlug: 'owner-repo' });
  mockReadFile.mockResolvedValue('## Implementation Summary\n\nBlocked on upstream dependency.\n');
  mockGetWorktreeRepoName.mockReturnValue('shared-repo-name');
  mockIsLockStale.mockResolvedValue(false);
  mockScanArtifacts.mockResolvedValue(makeResetScan());
  mockExecuteReset.mockResolvedValue({ operations: [], hasFailures: false });
  mockDocsSearch.mockReturnValue([
    {
      path: 'agents/setup',
      title: 'Repository setup for agents',
      score: 12.5,
      snippet: 'Configure a repository so any coding agent can run Shipper reliably.',
    },
  ]);
  mockDocsGet.mockReturnValue({
    path: 'agents/setup',
    title: 'Repository setup for agents',
    body: '# Repository setup for agents\n\nConfigure agents here.',
  });
  mockBuildDocsCorpus.mockResolvedValue({
    search: mockDocsSearch,
    get: mockDocsGet,
  });
  // Default startShipper mock: delegate to spawnShipper (which tests configure with mockResolvedValue)
  // and surface a single completion event. Tests exercising defer can override.
  mockStartShipper.mockImplementation(
    (args: string[], opts: { timeoutMs: number }): Record<string, unknown> => {
      const resultPromise = mockSpawnShipper(args, opts) as Promise<unknown>;
      return {
        next: async (): Promise<unknown> => {
          const result = await resultPromise;
          return { kind: 'completed', result };
        },
        answer: async (): Promise<void> => {},
        cancel: (): void => {},
        isCompleted: (): boolean => true,
      };
    }
  );
});

function withFlag<T>(value: string | undefined, fn: () => T | Promise<T>): Promise<T> {
  const original = process.env.SHIPPER_EXPERIMENTAL_MCP_GROOMING;
  if (value === undefined) {
    Reflect.deleteProperty(process.env, 'SHIPPER_EXPERIMENTAL_MCP_GROOMING');
  } else {
    process.env.SHIPPER_EXPERIMENTAL_MCP_GROOMING = value;
  }
  return Promise.resolve(fn()).finally(() => {
    if (original === undefined) {
      Reflect.deleteProperty(process.env, 'SHIPPER_EXPERIMENTAL_MCP_GROOMING');
    } else {
      process.env.SHIPPER_EXPERIMENTAL_MCP_GROOMING = original;
    }
  });
}

describe('registerTools', () => {
  it('registers every tool when experimental grooming is enabled and only gated tools otherwise', async () => {
    await withFlag('1', async () => {
      const getTool = await collectTools();
      expect(getTool.names()).toEqual([...toolNames]);
    });

    await withFlag(undefined, async () => {
      const getTool = await collectTools();
      expect(getTool.names()).toEqual(
        toolNames.filter((name) => name !== 'shipper_groom' && name !== 'shipper_answer_question')
      );
    });
  });

  it('registers the expected MCP behavior annotations without false-valued defaults', async () => {
    await withFlag('1', async () => {
      const getTool = await collectTools();
      const expected = {
        shipper_list_issues: { readOnlyHint: true, openWorldHint: true },
        shipper_get_issue: { readOnlyHint: true, openWorldHint: true },
        shipper_get_pr_checks: { readOnlyHint: true, openWorldHint: true },
        shipper_docs_search: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
        shipper_docs_get: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
        shipper_advance: { openWorldHint: true },
        shipper_groom: { openWorldHint: true },
        shipper_create_issue: { openWorldHint: true },
        shipper_unblock: { openWorldHint: true, idempotentHint: true },
        shipper_merge: { openWorldHint: true },
        shipper_unlock: { openWorldHint: true, idempotentHint: true },
        shipper_reset: { openWorldHint: true, destructiveHint: true },
        shipper_adopt: { openWorldHint: true },
        shipper_answer_question: { openWorldHint: true },
      } satisfies Record<(typeof toolNames)[number], ToolAnnotations>;

      const allowedFalseAnnotations = new Set([
        'shipper_docs_search:openWorldHint',
        'shipper_docs_get:openWorldHint',
      ]);

      for (const name of toolNames) {
        const annotations = getTool.getAnnotations(name);
        expect(annotations).toEqual(expected[name]);
        for (const [hint, value] of Object.entries(annotations ?? {})) {
          if (value === false) {
            expect(allowedFalseAnnotations.has(`${name}:${hint}`)).toBe(true);
          }
        }
      }
    });
  });
});

describe('shipper_list_issues', () => {
  it('groups issues by stage and renders blocked/failed separately', async () => {
    mockGh.mockResolvedValue({
      stdout: JSON.stringify([
        { number: 1, title: 'Groomed one', labels: [{ name: 'shipper:groomed' }] },
        {
          number: 2,
          title: 'Blocked one',
          labels: [{ name: 'shipper:planned' }, { name: 'shipper:blocked' }],
        },
        { number: 3, title: 'Failed one', labels: [{ name: 'shipper:failed' }] },
      ]),
      stderr: '',
    });

    const getTool = await collectTools();
    const result = await getTool('shipper_list_issues')({});
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Groomed one');
    expect(text).toContain('Blocked');
    expect(text).toContain('#2 Blocked one [planned]');
    expect(text).toContain('Failed');
    expect(text).toContain('#3 Failed one');
  });
});

describe('shipper_get_issue', () => {
  it('appends linked PR info when present', async () => {
    mockFetchIssue.mockResolvedValue('<issue number="7">...</issue>');
    mockTryResolvePr.mockResolvedValue('99');

    const getTool = await collectTools();
    const result = await getTool('shipper_get_issue')({ issue: 7 });

    expect(result.content[0]?.text).toContain('<issue number="7">');
    expect(result.content[0]?.text).toContain('<linked-pr number="99"/>');
  });
});

describe('shipper_docs_search', () => {
  it('uses the default limit and renders stable grouped text', async () => {
    const getTool = await collectTools();
    const result = await getTool('shipper_docs_search')({ query: 'setup agents' });
    const text = result.content[0]?.text ?? '';

    expect(mockBuildDocsCorpus).toHaveBeenCalledOnce();
    expect(mockDocsSearch).toHaveBeenCalledWith('setup agents', 5);
    expect(text).toBe(`Match 1
path: agents/setup
title: Repository setup for agents
score: 12.50
snippet: Configure a repository so any coding agent can run Shipper reliably.`);
  });

  it('accepts the max explicit limit and returns a no-match message', async () => {
    mockDocsSearch.mockReturnValueOnce([]);

    const getTool = await collectTools();
    const result = await getTool.invokeValidated('shipper_docs_search', {
      query: 'missing',
      limit: 25,
    });

    expect(mockDocsSearch).toHaveBeenCalledWith('missing', 25);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe('No documentation matches found for query: "missing"');
  });

  it('validates limit above 25 at the registered schema boundary', async () => {
    const getTool = await collectTools();

    const error = await expectZodError(
      getTool.invokeValidated('shipper_docs_search', { query: 'setup', limit: 26 })
    );

    expect(error.issues[0]?.path).toEqual(['limit']);
    expect(mockDocsSearch).not.toHaveBeenCalled();
  });
});

describe('shipper_docs_get', () => {
  it('returns the full markdown body for a known docs path', async () => {
    const getTool = await collectTools();
    const result = await getTool('shipper_docs_get')({ path: 'agents/setup' });

    expect(mockDocsGet).toHaveBeenCalledWith('agents/setup');
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe('# Repository setup for agents\n\nConfigure agents here.');
  });

  it('returns a suggested-search error for unknown docs paths', async () => {
    mockDocsGet.mockImplementationOnce(() => {
      throw new Error(
        'Documentation page not found for path "missing". Call shipper_docs_search to find a valid docs path.'
      );
    });

    const getTool = await collectTools();
    const result = await getTool('shipper_docs_get')({ path: 'missing' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('missing');
    expect(result.content[0]?.text).toContain('shipper_docs_search');
  });
});

describe('shipper_unlock', () => {
  it('releases a specific issue lock', async () => {
    mockReleaseLock.mockResolvedValue(undefined);

    const getTool = await collectTools();
    const result = await getTool('shipper_unlock')({ issue: 10 });

    expect(mockReleaseLock).toHaveBeenCalledWith('owner/repo', '10');
    expect(result.content[0]?.text).toContain('Released lock on #10');
  });
});

describe('shipper_reset', () => {
  it('validates missing issue at the registered schema boundary', async () => {
    const getTool = await collectTools();

    const error = await expectZodError(getTool.invokeValidated('shipper_reset', { target: 'new' }));

    expect(error.issues[0]?.path).toEqual(['issue']);
    expect(mockScanArtifacts).not.toHaveBeenCalled();
  });

  it('validates wrong-typed issue at the registered schema boundary', async () => {
    const getTool = await collectTools();

    const error = await expectZodError(
      getTool.invokeValidated('shipper_reset', { issue: '42', target: 'new' })
    );

    expect(error.issues[0]?.path).toEqual(['issue']);
    expect(mockScanArtifacts).not.toHaveBeenCalled();
  });

  it('validates missing target at the registered schema boundary', async () => {
    const getTool = await collectTools();

    const error = await expectZodError(getTool.invokeValidated('shipper_reset', { issue: 42 }));

    expect(error.issues[0]?.path).toEqual(['target']);
    expect(mockScanArtifacts).not.toHaveBeenCalled();
  });

  it('validates invalid target values and lists the allowed stages', async () => {
    const getTool = await collectTools();

    const error = await expectZodError(
      getTool.invokeValidated('shipper_reset', { issue: 42, target: 'ready' })
    );

    expect(JSON.stringify(error.issues)).toContain('new');
    expect(JSON.stringify(error.issues)).toContain('groomed');
    expect(JSON.stringify(error.issues)).toContain('designed');
    expect(JSON.stringify(error.issues)).toContain('planned');
    expect(JSON.stringify(error.issues)).toContain('implemented');
    expect(mockScanArtifacts).not.toHaveBeenCalled();
  });

  it('rejects pull request numbers before scanning or executing reset', async () => {
    mockGh.mockResolvedValueOnce({
      stdout: JSON.stringify({ number: 42, url: 'https://github.com/owner/repo/pull/42' }),
      stderr: '',
    });

    const getTool = await collectTools();
    const result = await getTool('shipper_reset')({ issue: 42, target: 'new' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('#42 is a pull request, not an issue.');
    expect(mockScanArtifacts).not.toHaveBeenCalled();
    expect(mockExecuteReset).not.toHaveBeenCalled();
  });

  it('rejects closed issues before scanning or executing reset', async () => {
    mockGh
      .mockRejectedValueOnce(notPullRequestError())
      .mockResolvedValueOnce(issueLabelsStateResponse('CLOSED', 'shipper:groomed'));

    const getTool = await collectTools();
    const result = await getTool('shipper_reset')({ issue: 42, target: 'new' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      'Issue #42 is closed. Reset only works on open issues.'
    );
    expect(mockScanArtifacts).not.toHaveBeenCalled();
    expect(mockExecuteReset).not.toHaveBeenCalled();
  });

  it('rejects same-stage resets while preserving backward-only wording', async () => {
    mockGh
      .mockRejectedValueOnce(notPullRequestError())
      .mockResolvedValueOnce(issueLabelsResponse('shipper:groomed'));

    const getTool = await collectTools();
    const result = await getTool('shipper_reset')({ issue: 42, target: 'groomed' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      'Error: Issue #42 is already at shipper:groomed. Reset only works backward.'
    );
    expect(mockScanArtifacts).not.toHaveBeenCalled();
  });

  it('rejects later-stage targets while preserving backward-only wording', async () => {
    mockGh
      .mockRejectedValueOnce(notPullRequestError())
      .mockResolvedValueOnce(issueLabelsResponse('shipper:groomed'));

    const getTool = await collectTools();
    const result = await getTool('shipper_reset')({ issue: 42, target: 'planned' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      'Error: shipper:planned is ahead of the current stage shipper:groomed. Reset only works backward.'
    );
    expect(mockScanArtifacts).not.toHaveBeenCalled();
  });

  it('allows any reset target for failed-only issues without workflow-stage labels', async () => {
    mockGh
      .mockRejectedValueOnce(notPullRequestError())
      .mockResolvedValueOnce(issueLabelsResponse('shipper:failed'));
    mockScanArtifacts.mockResolvedValueOnce(
      makeResetScan({
        addTarget: true,
        targetStage: 'implemented',
        targetLabel: 'shipper:implemented',
      })
    );

    const getTool = await collectTools();
    const result = await getTool('shipper_reset')({
      issue: 42,
      target: 'implemented',
      dry_run: true,
    });

    expect(result.isError).toBeUndefined();
    expect(mockScanArtifacts).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'implemented',
      ['shipper:failed'],
      {
        repoRoot: process.cwd(),
        repoName: 'shared-repo-name',
        refreshRemoteRefs: false,
      }
    );
    expect(result.content[0]?.text).toContain('Dry run only; no changes made.');
  });

  it('rejects fresh locks with a shipper_unlock instruction', async () => {
    mockGh
      .mockRejectedValueOnce(notPullRequestError())
      .mockResolvedValueOnce(issueLabelsResponse('shipper:groomed', 'shipper:locked'));
    mockIsLockStale.mockResolvedValueOnce(false);

    const getTool = await collectTools();
    const result = await getTool('shipper_reset')({ issue: 42, target: 'new' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('shipper_unlock');
    expect(mockScanArtifacts).not.toHaveBeenCalled();
  });

  it('allows stale locks to proceed through reset scanning', async () => {
    mockGh
      .mockRejectedValueOnce(notPullRequestError())
      .mockResolvedValueOnce(issueLabelsResponse('shipper:groomed', 'shipper:locked'));
    mockIsLockStale.mockResolvedValueOnce(true);
    mockScanArtifacts.mockResolvedValueOnce(
      makeResetScan({
        addTarget: true,
        targetStage: 'new',
        targetLabel: 'shipper:new',
      })
    );

    const getTool = await collectTools();
    const result = await getTool('shipper_reset')({ issue: 42, target: 'new', dry_run: true });

    expect(result.isError).toBeUndefined();
    expect(mockScanArtifacts).toHaveBeenCalledOnce();
    expect(mockExecuteReset).not.toHaveBeenCalled();
    expect(result.content[0]?.text).toContain('Dry run only; no changes made.');
  });

  it('returns a full dry-run preview and never calls executeReset', async () => {
    mockGh
      .mockRejectedValueOnce(notPullRequestError())
      .mockResolvedValueOnce(
        issueLabelsResponse('shipper:new', 'shipper:groomed', 'shipper:planned')
      );
    mockScanArtifacts.mockResolvedValueOnce(
      makeResetScan({
        labelsToRemove: ['shipper:planned'],
        addTarget: false,
        targetStage: 'groomed',
        targetLabel: 'shipper:groomed',
        commentIds: [101, 102],
        prs: [{ number: 17, headRefName: 'shipper/42-reset' }],
        branchesToDelete: ['shipper/42-reset'],
        localBranches: ['shipper/42-reset'],
        localWorktrees: ['/tmp/worktrees/repo--wt--shipper-42-reset'],
      })
    );

    const getTool = await collectTools();
    const result = await getTool('shipper_reset')({ issue: 42, target: 'groomed', dry_run: true });
    const text = result.content[0]?.text ?? '';

    expect(result.isError).toBeUndefined();
    expect(text).toContain('Labels to remove: shipper:planned');
    expect(text).toContain('Comments to delete: 101, 102');
    expect(text).toContain('PRs to close: #17 (shipper/42-reset)');
    expect(text).toContain('Remote branches to delete: shipper/42-reset');
    expect(text).toContain('Local branches to delete: shipper/42-reset');
    expect(text).toContain('Local worktrees to remove: /tmp/worktrees/repo--wt--shipper-42-reset');
    expect(text).toContain('Dry run only; no changes made.');
    expect(mockExecuteReset).not.toHaveBeenCalled();
    expect(mockScanArtifacts).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'groomed',
      ['shipper:new', 'shipper:groomed', 'shipper:planned'],
      {
        repoRoot: process.cwd(),
        repoName: 'shared-repo-name',
        refreshRemoteRefs: false,
      }
    );
  });

  it('short-circuits when the issue is already clean for the target', async () => {
    mockGh
      .mockRejectedValueOnce(notPullRequestError())
      .mockResolvedValueOnce(issueLabelsResponse('shipper:implemented', 'shipper:pr-open'));
    mockScanArtifacts.mockResolvedValueOnce(
      makeResetScan({
        targetStage: 'implemented',
        targetLabel: 'shipper:implemented',
      })
    );

    const getTool = await collectTools();
    const result = await getTool('shipper_reset')({ issue: 42, target: 'implemented' });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain(
      'Issue #42 is already clean for target shipper:implemented. Nothing to reset.'
    );
    expect(result.content[0]?.text).not.toContain('Reset results for issue #42:');
    expect(mockExecuteReset).not.toHaveBeenCalled();
  });

  it('returns the live operation ledger without isError when reset succeeds', async () => {
    mockGh
      .mockRejectedValueOnce(notPullRequestError())
      .mockResolvedValueOnce(issueLabelsResponse('shipper:planned'));
    mockScanArtifacts.mockResolvedValueOnce(
      makeResetScan({
        addTarget: true,
        targetStage: 'groomed',
        targetLabel: 'shipper:groomed',
      })
    );
    mockExecuteReset.mockResolvedValueOnce({
      operations: [
        { description: 'Remove labels: shipper:planned', status: 'succeeded' },
        {
          description: 'Delete remote branch shipper/42-reset',
          status: 'skipped',
          reason: 'already deleted',
        },
      ],
      hasFailures: false,
    });

    const getTool = await collectTools();
    const result = await getTool('shipper_reset')({ issue: 42, target: 'groomed' });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('Reset results for issue #42:');
    expect(result.content[0]?.text).toContain('succeeded: Remove labels: shipper:planned');
    expect(result.content[0]?.text).toContain(
      'skipped: Delete remote branch shipper/42-reset (already deleted)'
    );
    expect(mockExecuteReset).toHaveBeenCalledWith(42, expect.any(Object), 'owner/repo', {
      repoRoot: process.cwd(),
    });
    expect(mockGetWorktreeRepoName).toHaveBeenCalledWith(process.cwd());
  });

  it('marks partial-failure live resets as MCP errors while keeping the full ledger', async () => {
    mockGh
      .mockRejectedValueOnce(notPullRequestError())
      .mockResolvedValueOnce(issueLabelsResponse('shipper:planned'));
    mockScanArtifacts.mockResolvedValueOnce(
      makeResetScan({
        addTarget: true,
        targetStage: 'new',
        targetLabel: 'shipper:new',
      })
    );
    mockExecuteReset.mockResolvedValueOnce({
      operations: [
        { description: 'Remove labels: shipper:planned', status: 'succeeded' },
        {
          description: 'Post reset notice comment',
          status: 'failed',
          reason: 'GitHub API error',
        },
      ],
      hasFailures: true,
    });

    const getTool = await collectTools();
    const result = await getTool('shipper_reset')({ issue: 42, target: 'new' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('succeeded: Remove labels: shipper:planned');
    expect(result.content[0]?.text).toContain(
      'failed: Post reset notice comment (GitHub API error)'
    );
  });

  it('surfaces operational PR probe failures instead of treating them as not-a-PR misses', async () => {
    mockGh.mockRejectedValueOnce(prProbeFailureError());

    const getTool = await collectTools();
    const result = await getTool('shipper_reset')({ issue: 42, target: 'new' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('gh pr view failed');
    expect(result.content[0]?.text).not.toContain('pull request, not an issue');
    expect(mockScanArtifacts).not.toHaveBeenCalled();
    expect(mockExecuteReset).not.toHaveBeenCalled();
  });
});

describe('shipper_advance', () => {
  it('returns structured accept output with PR URL, final message, and session log', async () => {
    mockGh
      .mockResolvedValueOnce(issueLabelsResponse('shipper:planned'))
      .mockResolvedValueOnce(issueLabelsResponse('shipper:implemented'));
    mockSpawnShipper.mockResolvedValue({
      exitCode: 0,
      stdout: '{"type":"assistant"}',
      stderr: '',
      timedOut: false,
    });
    mockFindLatestSessionMeta.mockResolvedValue({
      issue: '42',
      stage: 'implement',
      timestamp: '2026-04-21T00:00:00.000Z',
      agent: 'claude',
      model: 'sonnet',
      repo: 'owner/repo',
      exitCode: 0,
      logFile: '/tmp/advance.jsonl',
    });
    mockExtractFinalMessage.mockResolvedValue('Implemented the requested change.');
    mockTryResolvePr.mockResolvedValue('17');

    const getTool = await collectTools();
    const result = await getTool('shipper_advance')({ issue: 42 });
    const text = result.content[0]?.text ?? '';

    expect(mockSpawnShipper).toHaveBeenCalledWith(['next', '42', '--mode', 'headless'], {
      timeoutMs: 60 * 60 * 1000,
    });
    expect(result.isError).toBeUndefined();
    expect(text).toContain('Stage: shipper:planned -> shipper:implemented (accept)');
    expect(text).toContain('PR: https://github.com/owner/repo/pull/17');
    expect(text).toContain('Implemented the requested change.');
    expect(text).toContain('Session log: /tmp/advance.jsonl');
    expect(text).not.toContain('--- stdout ---');
    expect(text).not.toContain('"type":"assistant"');
  });

  it('keeps structured reject output while preserving isError on non-zero exits', async () => {
    mockGh
      .mockResolvedValueOnce(issueLabelsResponse('shipper:planned'))
      .mockResolvedValueOnce(issueLabelsResponse('shipper:designed'));
    mockSpawnShipper.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'rejected',
      timedOut: false,
    });
    mockFindLatestSessionMeta.mockResolvedValue({
      issue: '42',
      stage: 'implement',
      timestamp: '2026-04-21T00:00:00.000Z',
      agent: 'claude',
      model: 'sonnet',
      repo: 'owner/repo',
      exitCode: 1,
      logFile: '/tmp/reject.jsonl',
    });
    mockExtractFinalMessage.mockResolvedValue('Rejected the current implementation approach.');

    const getTool = await collectTools();
    const result = await getTool('shipper_advance')({ issue: 42 });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      'Stage: shipper:planned -> shipper:designed (reject)'
    );
    expect(result.content[0]?.text).toContain('Rejected the current implementation approach.');
  });

  it('returns structured fail output when the stage records shipper:failed', async () => {
    mockGh
      .mockResolvedValueOnce(issueLabelsResponse('shipper:planned'))
      .mockResolvedValueOnce(issueLabelsResponse('shipper:failed'));
    mockSpawnShipper.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'stage failed',
      timedOut: false,
    });
    mockFindLatestSessionMeta.mockResolvedValue({
      issue: '42',
      stage: 'implement',
      timestamp: '2026-04-21T00:00:00.000Z',
      agent: 'claude',
      model: 'sonnet',
      repo: 'owner/repo',
      exitCode: 1,
      logFile: '/tmp/fail.jsonl',
    });
    mockExtractFinalMessage.mockResolvedValue('Marked the issue as failed.');

    const getTool = await collectTools();
    const result = await getTool('shipper_advance')({ issue: 42 });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Stage: shipper:planned -> shipper:failed (fail)');
    expect(result.content[0]?.text).toContain('Session log: /tmp/fail.jsonl');
  });

  it('falls back to a focused failure summary when no verdict can be recovered', async () => {
    mockGh
      .mockResolvedValueOnce(issueLabelsResponse('shipper:planned'))
      .mockResolvedValueOnce(issueLabelsResponse('shipper:planned'));
    mockSpawnShipper.mockResolvedValue({
      exitCode: 1,
      stdout: '{"type":"assistant"}',
      stderr: 'agent crashed',
      timedOut: false,
    });
    mockFindLatestSessionMeta.mockResolvedValue({
      issue: '42',
      stage: 'implement',
      timestamp: '2026-04-21T00:00:00.000Z',
      agent: 'claude',
      model: 'sonnet',
      repo: 'owner/repo',
      exitCode: 1,
      logFile: '/tmp/crash.jsonl',
    });

    const getTool = await collectTools();
    const result = await getTool('shipper_advance')({ issue: 42 });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('[exit 1] shipper next 42 --mode headless');
    expect(result.content[0]?.text).toContain('agent crashed');
    expect(result.content[0]?.text).not.toContain('"type":"assistant"');
  });

  it('returns a no-op advance result when the issue is already ready', async () => {
    mockGh
      .mockResolvedValueOnce(issueLabelsResponse('shipper:ready'))
      .mockResolvedValueOnce(issueLabelsResponse('shipper:ready'));
    mockSpawnShipper.mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
    });

    const getTool = await collectTools();
    const result = await getTool('shipper_advance')({ issue: 42 });

    expect(mockFindLatestSessionMeta).not.toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('Stage: shipper:ready -> shipper:ready (noop)');
    expect(result.content[0]?.text).toContain(
      'No final message was captured in this run. See session log for details.'
    );
  });

  it('refuses to advance a shipper:new issue', async () => {
    mockGh.mockResolvedValue(issueLabelsResponse('shipper:new'));

    const getTool = await collectTools();
    const result = await getTool('shipper_advance')({ issue: 42 });

    expect(mockSpawnShipper).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('interactively');
  });
});

describe('shipper_advance + shipper_answer_question (defer/answer cycle)', () => {
  function makeRunner(events: unknown[], onAnswer?: (answers: Record<string, string>) => void) {
    return {
      next: (): Promise<unknown> => {
        if (events.length === 0) {
          return Promise.reject(new Error('runner exhausted in test'));
        }
        return Promise.resolve(events.shift());
      },
      answer: (answers: Record<string, string>): Promise<void> => {
        onAnswer?.(answers);
        return Promise.resolve();
      },
      cancel: (): void => {},
      isCompleted: (): boolean => events.length === 0,
    };
  }

  it('returns awaiting_answer on initial defer and resumes on answer with completion', async () => {
    await withFlag('1', async () => {
      mockGh
        .mockResolvedValueOnce(issueLabelsResponse('shipper:planned'))
        .mockResolvedValueOnce(issueLabelsResponse('shipper:implemented'));

      let capturedAnswers: Record<string, string> | undefined;
      const runner = makeRunner(
        [
          {
            kind: 'deferred',
            sessionId: 'sess-defer-1',
            payload: {
              sessionId: 'sess-defer-1',
              questions: [
                {
                  question: 'Use TypeScript?',
                  header: 'Lang',
                  options: [
                    { label: 'Yes', description: 'TS' },
                    { label: 'No', description: 'JS' },
                  ],
                  multiSelect: false,
                },
              ],
            },
          },
          {
            kind: 'completed',
            result: {
              exitCode: 0,
              stdout: '{"type":"assistant"}',
              stderr: '',
              timedOut: false,
            },
          },
        ],
        (answers) => {
          capturedAnswers = answers;
        }
      );
      mockStartShipper.mockReturnValueOnce(runner);

      mockFindLatestSessionMeta.mockResolvedValue({
        issue: '42',
        stage: 'implement',
        timestamp: '2026-04-29T00:00:00.000Z',
        agent: 'claude',
        model: 'sonnet',
        repo: 'owner/repo',
        exitCode: 0,
        logFile: '/tmp/defer-cycle.jsonl',
      });
      mockExtractFinalMessage.mockResolvedValue('Done.');
      mockTryResolvePr.mockResolvedValue('99');

      const getTool = await collectTools();

      // Initial advance returns awaiting_answer.
      const advanceResult = await getTool('shipper_advance')({ issue: 42 });
      expect(advanceResult.isError).toBeUndefined();
      expect(advanceResult.content[0]?.text).toContain('Status: awaiting_answer');
      expect(advanceResult.content[0]?.text).toContain('Session: sess-defer-1');
      expect(advanceResult.content[0]?.text).toContain('Use TypeScript?');
      // Worker's option labels and descriptions must be stripped before the
      // orchestrator sees the questions — we don't want to bias its answer.
      expect(advanceResult.content[0]?.text).not.toContain('"Yes"');
      expect(advanceResult.content[0]?.text).not.toContain('"No"');
      expect(advanceResult.content[0]?.text).not.toContain('"options"');
      expect(advanceResult.content[0]?.text).not.toContain('"multiSelect"');

      // Answer the question; expect completion + advance summary.
      const answerResult = await getTool('shipper_answer_question')({
        session_id: 'sess-defer-1',
        answers: { 'Use TypeScript?': 'Yes' },
      });
      expect(answerResult.isError).toBeUndefined();
      expect(capturedAnswers).toEqual({ 'Use TypeScript?': 'Yes' });
      expect(answerResult.content[0]?.text).toContain(
        'Stage: shipper:planned -> shipper:implemented (accept)'
      );
    });
  });

  it('returns another awaiting_answer when the worker defers again on resume', async () => {
    await withFlag('1', async () => {
      const runner = makeRunner([
        {
          kind: 'deferred',
          sessionId: 'sess-defer-2',
          payload: {
            sessionId: 'sess-defer-2',
            questions: [
              {
                question: 'First?',
                header: 'Q1',
                options: [
                  { label: 'A', description: 'a' },
                  { label: 'B', description: 'b' },
                ],
                multiSelect: false,
              },
            ],
          },
        },
        {
          kind: 'deferred',
          sessionId: 'sess-defer-2',
          payload: {
            sessionId: 'sess-defer-2',
            questions: [
              {
                question: 'Second?',
                header: 'Q2',
                options: [
                  { label: 'X', description: 'x' },
                  { label: 'Y', description: 'y' },
                ],
                multiSelect: false,
              },
            ],
          },
        },
      ]);
      mockStartShipper.mockReturnValueOnce(runner);
      mockGh.mockResolvedValueOnce(issueLabelsResponse('shipper:planned'));

      const getTool = await collectTools();
      await getTool('shipper_advance')({ issue: 42 });

      const second = await getTool('shipper_answer_question')({
        session_id: 'sess-defer-2',
        answers: { 'First?': 'A' },
      });
      expect(second.isError).toBeUndefined();
      expect(second.content[0]?.text).toContain('Status: awaiting_answer');
      expect(second.content[0]?.text).toContain('Second?');
    });
  });

  it('errors clearly when shipper_answer_question is called with an unknown session id', async () => {
    await withFlag('1', async () => {
      const getTool = await collectTools();
      const result = await getTool('shipper_answer_question')({
        session_id: 'nonexistent',
        answers: { 'Q?': 'A' },
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('No pending shipper session');
    });
  });
});

describe('shipper_groom', () => {
  it('is not registered when the experimental flag is unset', async () => {
    await withFlag(undefined, async () => {
      const getTool = await collectTools();
      expect(getTool.names()).not.toContain('shipper_groom');
      expect(getTool.names()).not.toContain('shipper_answer_question');
    });
  });

  it('refuses on an issue that is not at shipper:new', async () => {
    await withFlag('1', async () => {
      mockGh.mockResolvedValueOnce(issueLabelsResponse('shipper:groomed'));
      const getTool = await collectTools();
      const result = await getTool('shipper_groom')({ issue: 42 });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('only operates on issues at shipper:new');
    });
  });

  it('runs end-to-end on a shipper:new issue and surfaces the accept transition', async () => {
    await withFlag('1', async () => {
      mockGh
        .mockResolvedValueOnce(issueLabelsResponse('shipper:new'))
        .mockResolvedValueOnce(issueLabelsResponse('shipper:groomed'));
      mockSpawnShipper.mockResolvedValue({
        exitCode: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
      });
      mockFindLatestSessionMeta.mockResolvedValue({
        issue: '42',
        stage: 'groom',
        timestamp: '2026-04-29T00:00:00.000Z',
        agent: 'claude',
        model: 'sonnet',
        repo: 'owner/repo',
        exitCode: 0,
        logFile: '/tmp/groom.jsonl',
      });
      mockExtractFinalMessage.mockResolvedValue('Issue groomed.');

      const getTool = await collectTools();
      const result = await getTool('shipper_groom')({ issue: 42 });

      expect(result.isError).toBeUndefined();
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('Stage: shipper:new -> shipper:groomed (accept)');
      expect(text).toContain('Issue groomed.');
      expect(text).toContain('Session log: /tmp/groom.jsonl');
      expect(mockSpawnShipper).toHaveBeenCalledWith(['groom', '42', '--mode', 'headless'], {
        timeoutMs: 60 * 60 * 1000,
      });
    });
  });

  it('returns awaiting_answer when the worker defers and resumes through shipper_answer_question', async () => {
    await withFlag('1', async () => {
      mockGh
        .mockResolvedValueOnce(issueLabelsResponse('shipper:new'))
        .mockResolvedValueOnce(issueLabelsResponse('shipper:groomed'));

      const events: unknown[] = [
        {
          kind: 'deferred',
          sessionId: 'sess-groom-1',
          payload: {
            sessionId: 'sess-groom-1',
            questions: [
              {
                question: 'Scope?',
                header: 'Scope',
                options: [
                  { label: 'Narrow', description: 'narrow' },
                  { label: 'Wide', description: 'wide' },
                ],
                multiSelect: false,
              },
            ],
          },
        },
        {
          kind: 'completed',
          result: { exitCode: 0, stdout: '', stderr: '', timedOut: false },
        },
      ];
      mockStartShipper.mockReturnValueOnce({
        next: (): Promise<unknown> =>
          events.length === 0
            ? Promise.reject(new Error('exhausted'))
            : Promise.resolve(events.shift()),
        answer: (): Promise<void> => Promise.resolve(),
        cancel: (): void => {},
        isCompleted: (): boolean => events.length === 0,
      });
      mockFindLatestSessionMeta.mockResolvedValue({
        issue: '42',
        stage: 'groom',
        timestamp: '2026-04-29T00:00:00.000Z',
        agent: 'claude',
        model: 'sonnet',
        repo: 'owner/repo',
        exitCode: 0,
        logFile: '/tmp/groom-defer.jsonl',
      });
      mockExtractFinalMessage.mockResolvedValue('Done.');

      const getTool = await collectTools();
      const initial = await getTool('shipper_groom')({ issue: 42 });
      expect(initial.isError).toBeUndefined();
      expect(initial.content[0]?.text).toContain('Status: awaiting_answer');
      expect(initial.content[0]?.text).toContain('Scope?');

      const completion = await getTool('shipper_answer_question')({
        session_id: 'sess-groom-1',
        answers: { 'Scope?': 'Narrow' },
      });
      expect(completion.isError).toBeUndefined();
      expect(completion.content[0]?.text).toContain(
        'Stage: shipper:new -> shipper:groomed (accept)'
      );
    });
  });
});

describe('shipper_create_issue', () => {
  it('validates empty requests at the registered schema boundary', async () => {
    const getTool = await collectTools();

    const error = await expectZodError(
      getTool.invokeValidated('shipper_create_issue', { request: '' })
    );

    expect(error.issues[0]?.path).toEqual(['request']);
    expect(mockSpawnShipper).not.toHaveBeenCalled();
  });

  it('returns the created issue payload, final message, and session log without transcript content', async () => {
    mockSpawnShipper.mockResolvedValue({
      exitCode: 0,
      stdout: '{"type":"response_item"}',
      stderr: '',
      timedOut: false,
    });
    mockFindLatestSessionMeta.mockResolvedValue({
      issue: 'unlinked',
      stage: 'new',
      timestamp: '2026-04-21T00:00:00.000Z',
      agent: 'codex',
      model: 'gpt-5',
      repo: 'owner/repo',
      exitCode: 0,
      logFile: '/tmp/create.jsonl',
    });
    mockExtractFinalMessage.mockResolvedValue(
      'Created issue: https://github.com/owner/repo/issues/55\nSummary follows.'
    );
    mockGh.mockResolvedValue({
      stdout: JSON.stringify({
        number: 55,
        title: 'Improve MCP tool output summaries',
        url: 'https://github.com/owner/repo/issues/55',
      }),
      stderr: '',
    });

    const getTool = await collectTools();
    const result = await getTool('shipper_create_issue')({ request: 'Improve MCP output' });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('Created issue: #55 Improve MCP tool output summaries');
    expect(text).toContain('URL: https://github.com/owner/repo/issues/55');
    expect(text).toContain('Created issue: https://github.com/owner/repo/issues/55');
    expect(text).toContain('Session log: /tmp/create.jsonl');
    expect(text).not.toContain('--- stdout ---');
    expect(text).not.toContain('response_item');
    expect(text.length).toBeLessThan(8192);
  });

  it('prefers the last matching issue URL from the current repo in the final message', async () => {
    mockSpawnShipper.mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
    });
    mockFindLatestSessionMeta.mockResolvedValue({
      issue: 'unlinked',
      stage: 'new',
      timestamp: '2026-04-21T00:00:00.000Z',
      agent: 'codex',
      model: 'gpt-5',
      repo: 'owner/repo',
      exitCode: 0,
      logFile: '/tmp/create-last-url.jsonl',
    });
    mockExtractFinalMessage.mockResolvedValue(
      [
        'Related: https://github.com/owner/repo/issues/11',
        'Cross-repo: https://github.com/other/repo/issues/12',
        'Created issue: https://github.com/owner/repo/issues/55',
      ].join('\n')
    );
    mockGh.mockResolvedValue({
      stdout: JSON.stringify({
        number: 55,
        title: 'Prefer the created issue URL',
        url: 'https://github.com/owner/repo/issues/55',
      }),
      stderr: '',
    });

    const getTool = await collectTools();
    const result = await getTool('shipper_create_issue')({ request: 'Prefer last URL' });

    expect(mockGh).toHaveBeenCalledTimes(1);
    expect(mockGh).toHaveBeenCalledWith([
      'issue',
      'view',
      '55',
      '-R',
      'owner/repo',
      '--json',
      'number,title,url',
    ]);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('Created issue: #55 Prefer the created issue URL');
  });

  it('uses the exact missing-final-message fallback while still returning structured payload', async () => {
    mockSpawnShipper.mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
    });
    mockFindLatestSessionMeta.mockResolvedValue({
      issue: 'unlinked',
      stage: 'new',
      timestamp: '2026-04-21T00:00:00.000Z',
      agent: 'claude',
      model: 'sonnet',
      repo: 'owner/repo',
      exitCode: 0,
      logFile: '/tmp/no-message.jsonl',
    });
    mockExtractFinalMessage.mockResolvedValue(undefined);
    mockGh
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 56,
            title: 'Fallback issue',
            url: 'https://github.com/owner/repo/issues/56',
            createdAt: '2026-04-21T00:00:02.000Z',
          },
        ]),
        stderr: '',
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 56,
          title: 'Fallback issue',
          url: 'https://github.com/owner/repo/issues/56',
        }),
        stderr: '',
      });

    const getTool = await collectTools();
    const result = await getTool('shipper_create_issue')({ request: 'Fallback path' });

    expect(result.content[0]?.text).toContain('Created issue: #56 Fallback issue');
    expect(result.content[0]?.text).toContain(
      'No final message was captured in this run. See session log for details.'
    );
  });

  it('falls back to issue-list recovery when the final message has no issue URL', async () => {
    mockSpawnShipper.mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
    });
    mockFindLatestSessionMeta.mockResolvedValue({
      issue: 'unlinked',
      stage: 'new',
      timestamp: '2026-04-21T00:00:00.000Z',
      agent: 'claude',
      model: 'sonnet',
      repo: 'owner/repo',
      exitCode: 0,
      logFile: '/tmp/fallback.jsonl',
    });
    mockExtractFinalMessage.mockResolvedValue('Created the issue and wrote a summary.');
    mockGh
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 57,
            title: 'Recovered via fallback',
            url: 'https://github.com/owner/repo/issues/57',
            createdAt: '2026-04-21T00:00:03.000Z',
          },
        ]),
        stderr: '',
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 57,
          title: 'Recovered via fallback',
          url: 'https://github.com/owner/repo/issues/57',
        }),
        stderr: '',
      });

    const getTool = await collectTools();
    const result = await getTool('shipper_create_issue')({ request: 'Fallback' });

    expect(result.content[0]?.text).toContain('Created issue: #57 Recovered via fallback');
    expect(result.content[0]?.text).toContain('Created the issue and wrote a summary.');
  });

  it('requires an unambiguous fallback issue candidate before recovering the payload', async () => {
    mockSpawnShipper.mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
    });
    mockFindLatestSessionMeta.mockResolvedValue({
      issue: 'unlinked',
      stage: 'new',
      timestamp: '2026-04-21T00:00:00.000Z',
      agent: 'claude',
      model: 'sonnet',
      repo: 'owner/repo',
      exitCode: 0,
      logFile: '/tmp/ambiguous.jsonl',
    });
    mockExtractFinalMessage.mockResolvedValue('Created the issue and wrote a summary.');
    mockGh.mockResolvedValue({
      stdout: JSON.stringify([
        {
          number: 57,
          title: 'First candidate',
          url: 'https://github.com/owner/repo/issues/57',
          createdAt: '2026-04-21T00:00:03.000Z',
        },
        {
          number: 58,
          title: 'Second candidate',
          url: 'https://github.com/owner/repo/issues/58',
          createdAt: '2026-04-21T00:00:04.000Z',
        },
      ]),
      stderr: '',
    });

    const getTool = await collectTools();
    const result = await getTool('shipper_create_issue')({ request: 'Fallback ambiguity' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      'Unable to recover created issue details from post-run metadata.'
    );
    expect(result.content[0]?.text).toContain('Created the issue and wrote a summary.');
    expect(result.content[0]?.text).toContain('Session log: /tmp/ambiguous.jsonl');
  });

  it('keeps the final message and session log when issue recovery gh calls fail', async () => {
    mockSpawnShipper.mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
    });
    mockFindLatestSessionMeta.mockResolvedValue({
      issue: 'unlinked',
      stage: 'new',
      timestamp: '2026-04-21T00:00:00.000Z',
      agent: 'codex',
      model: 'gpt-5',
      repo: 'owner/repo',
      exitCode: 0,
      logFile: '/tmp/create-gh-failure.jsonl',
    });
    mockExtractFinalMessage.mockResolvedValue(
      'Created issue: https://github.com/owner/repo/issues/55\nSummary follows.'
    );
    mockGh.mockRejectedValue(new Error('gh issue view failed'));

    const getTool = await collectTools();
    const result = await getTool('shipper_create_issue')({ request: 'GH recovery failure' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      'Unable to recover created issue details from post-run metadata.'
    );
    expect(result.content[0]?.text).toContain(
      'Created issue: https://github.com/owner/repo/issues/55'
    );
    expect(result.content[0]?.text).toContain('Session log: /tmp/create-gh-failure.jsonl');
  });
});

describe('shipper_unblock', () => {
  it('returns the unblock verdict, reason, final message, and session log from result.json', async () => {
    mockGh
      .mockResolvedValueOnce(issueLabelsResponse('shipper:planned', 'shipper:blocked'))
      .mockResolvedValueOnce(issueLabelsResponse('shipper:planned'));
    mockSpawnShipper.mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
    });
    mockFindLatestSessionMeta.mockResolvedValue({
      issue: '42',
      stage: 'unblock',
      timestamp: '2026-04-21T00:00:00.000Z',
      agent: 'claude',
      model: 'sonnet',
      repo: 'owner/repo',
      exitCode: 0,
      logFile: '/tmp/unblock.jsonl',
    });
    mockExtractFinalMessage.mockResolvedValue('The issue is now unblocked.');
    mockReadResultFile.mockResolvedValue({
      verdict: 'accept',
      comment: '.shipper/output/comment-42.md',
    });
    mockReadFile.mockResolvedValue(
      '## Implementation Summary\n\nDependency landed upstream.\n\n## Agent Feedback\nIgnored.'
    );

    const getTool = await collectTools();
    const result = await getTool('shipper_unblock')({ issue: 42 });

    expect(result.content[0]?.text).toContain('Verdict: unblocked');
    expect(result.content[0]?.text).toContain('Reason: Dependency landed upstream.');
    expect(result.content[0]?.text).toContain('The issue is now unblocked.');
    expect(result.content[0]?.text).toContain('Session log: /tmp/unblock.jsonl');
  });

  it('falls back to label-diff recovery when result.json is unavailable', async () => {
    mockGh
      .mockResolvedValueOnce(issueLabelsResponse('shipper:planned', 'shipper:blocked'))
      .mockResolvedValueOnce(issueLabelsResponse('shipper:planned', 'shipper:blocked'));
    mockSpawnShipper.mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
    });
    mockFindLatestSessionMeta.mockResolvedValue({
      issue: '42',
      stage: 'unblock',
      timestamp: '2026-04-21T00:00:00.000Z',
      agent: 'claude',
      model: 'sonnet',
      repo: 'owner/repo',
      exitCode: 0,
      logFile: '/tmp/still-blocked.jsonl',
    });
    mockExtractFinalMessage.mockResolvedValue(undefined);
    mockReadResultFile.mockRejectedValue(new Error('Missing result.json'));

    const getTool = await collectTools();
    const result = await getTool('shipper_unblock')({ issue: 42 });

    expect(result.content[0]?.text).toContain('Verdict: still-blocked');
    expect(result.content[0]?.text).toContain('Reason: <not recorded>');
    expect(result.content[0]?.text).toContain(
      'No final message was captured in this run. See session log for details.'
    );
  });

  it('reports a failed unblock when the stage records fail', async () => {
    mockGh
      .mockResolvedValueOnce(issueLabelsResponse('shipper:planned', 'shipper:blocked'))
      .mockResolvedValueOnce(
        issueLabelsResponse('shipper:planned', 'shipper:blocked', 'shipper:failed')
      );
    mockSpawnShipper.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'failed',
      timedOut: false,
    });
    mockFindLatestSessionMeta.mockResolvedValue({
      issue: '42',
      stage: 'unblock',
      timestamp: '2026-04-21T00:00:00.000Z',
      agent: 'claude',
      model: 'sonnet',
      repo: 'owner/repo',
      exitCode: 1,
      logFile: '/tmp/unblock-failed.jsonl',
    });
    mockExtractFinalMessage.mockResolvedValue('The blocker could not be cleared.');
    mockReadResultFile.mockResolvedValue({
      verdict: 'fail',
      comment: '.shipper/output/comment-42.md',
    });
    mockReadFile.mockResolvedValue(
      '## Implementation Summary\n\nStill blocked by upstream failure.\n'
    );

    const getTool = await collectTools();
    const result = await getTool('shipper_unblock')({ issue: 42 });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Verdict: failed');
    expect(result.content[0]?.text).toContain('Reason: Still blocked by upstream failure.');
  });

  it('returns a focused failure summary when no verdict can be recovered', async () => {
    mockGh
      .mockResolvedValueOnce(issueLabelsResponse('shipper:planned', 'shipper:blocked'))
      .mockResolvedValueOnce(issueLabelsResponse('shipper:planned'));
    mockSpawnShipper.mockResolvedValue({
      exitCode: -1,
      stdout: '{"type":"assistant"}',
      stderr: 'timed out after waiting',
      timedOut: true,
    });
    mockFindLatestSessionMeta.mockResolvedValue({
      issue: '42',
      stage: 'unblock',
      timestamp: '2026-04-21T00:00:00.000Z',
      agent: 'claude',
      model: 'sonnet',
      repo: 'owner/repo',
      exitCode: -1,
      logFile: '/tmp/unblock-timeout.jsonl',
    });
    mockReadResultFile.mockRejectedValue(new Error('Missing result.json'));

    const getTool = await collectTools();
    const result = await getTool('shipper_unblock')({ issue: 42 });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('[timed out] shipper unblock 42 --mode headless');
    expect(result.content[0]?.text).toContain('timed out after waiting');
    expect(result.content[0]?.text).not.toContain('"type":"assistant"');
  });
});

describe('shipper_merge', () => {
  it('keeps the raw formatter behavior unchanged', async () => {
    mockSpawnShipper.mockResolvedValue({
      exitCode: 0,
      stdout: 'merged one PR',
      stderr: '',
      timedOut: false,
    });

    const getTool = await collectTools();
    const result = await getTool('shipper_merge')({});

    expect(result.content[0]?.text).toContain('[exit 0] shipper merge --once');
    expect(result.content[0]?.text).toContain('--- stdout ---');
    expect(result.content[0]?.text).toContain('merged one PR');
  });
});

describe('registerInitErrorTools', () => {
  it('includes unconditional docs and reset tools and returns the standard init-error payload', async () => {
    const handlers = new Map<string, Handler>();
    const mockServer = {
      registerTool: (name: string, _config: unknown, handler: Handler) => {
        handlers.set(name, handler);
      },
    };

    registerInitErrorTools(
      mockServer as unknown as Parameters<typeof registerInitErrorTools>[0],
      new Error('server init failed')
    );

    expect([...handlers.keys()]).toContain('shipper_reset');
    expect([...handlers.keys()]).toContain('shipper_docs_search');
    expect([...handlers.keys()]).toContain('shipper_docs_get');

    const result = await handlers.get('shipper_reset')?.({});
    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain('server init failed');
  });
});
