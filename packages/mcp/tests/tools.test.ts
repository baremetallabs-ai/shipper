import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockGh,
  mockListIssues,
  mockReleaseLock,
  mockIsLockStale,
  mockFetchIssue,
  mockTryResolvePr,
  mockSpawnShipper,
} = vi.hoisted(() => ({
  mockGh: vi.fn<(args: string[]) => Promise<{ stdout: string; stderr: string }>>(),
  mockListIssues: vi.fn(),
  mockReleaseLock: vi.fn(),
  mockIsLockStale: vi.fn(),
  mockFetchIssue: vi.fn(),
  mockTryResolvePr: vi.fn(),
  mockSpawnShipper: vi.fn(),
}));

vi.mock('@dnsquared/shipper-core', async () => {
  const actual =
    await vi.importActual<typeof import('@dnsquared/shipper-core')>('@dnsquared/shipper-core');
  return {
    ...actual,
    gh: (args: string[]) => mockGh(args),
    listIssues: mockListIssues,
    releaseIssueLock: mockReleaseLock,
    isLockStale: mockIsLockStale,
    fetchIssue: mockFetchIssue,
    tryResolvePrForIssue: mockTryResolvePr,
    getSettings: () => ({ agentTimeoutMinutes: 60 }),
  };
});

vi.mock('../src/helpers.js', async () => {
  const actual = await vi.importActual<typeof import('../src/helpers.js')>('../src/helpers.js');
  return {
    ...actual,
    spawnShipper: mockSpawnShipper,
  };
});

import { registerTools } from '../src/tools.js';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
}>;

function collectTools(): (name: string) => Handler {
  const handlers = new Map<string, Handler>();
  const mockServer = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      handlers.set(name, handler);
    },
  };
  registerTools(mockServer as unknown as Parameters<typeof registerTools>[0], 'owner/repo');
  return (name) => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`Tool ${name} was not registered`);
    return handler;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
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

    const getTool = collectTools();
    const result = await getTool('shipper_list_issues')({});
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Groomed one');
    expect(text).toContain('Blocked');
    expect(text).toContain('#2 Blocked one [planned]');
    expect(text).toContain('Failed');
    expect(text).toContain('#3 Failed one');
  });

  it('returns a friendly message when no issues match', async () => {
    mockGh.mockResolvedValue({ stdout: '[]', stderr: '' });
    const getTool = collectTools();
    const result = await getTool('shipper_list_issues')({});
    expect(result.content[0]?.text).toBe('No shipper-managed issues found.');
  });
});

describe('shipper_get_issue', () => {
  it('appends linked PR info when present', async () => {
    mockFetchIssue.mockResolvedValue('<issue number="7">...</issue>');
    mockTryResolvePr.mockResolvedValue('99');
    const getTool = collectTools();
    const result = await getTool('shipper_get_issue')({ issue: 7 });
    expect(result.content[0]?.text).toContain('<issue number="7">');
    expect(result.content[0]?.text).toContain('<linked-pr number="99"/>');
  });

  it('omits linked-pr when none exists', async () => {
    mockFetchIssue.mockResolvedValue('<issue number="8">...</issue>');
    mockTryResolvePr.mockResolvedValue(undefined);
    const getTool = collectTools();
    const result = await getTool('shipper_get_issue')({ issue: 8 });
    expect(result.content[0]?.text).not.toContain('linked-pr');
  });
});

describe('shipper_unlock', () => {
  it('releases a specific issue lock', async () => {
    mockReleaseLock.mockResolvedValue(undefined);
    const getTool = collectTools();
    const result = await getTool('shipper_unlock')({ issue: 10 });
    expect(mockReleaseLock).toHaveBeenCalledWith('owner/repo', '10');
    expect(result.content[0]?.text).toContain('Released lock on #10');
  });

  it('sweeps stale locks', async () => {
    mockListIssues.mockResolvedValue([
      {
        number: 1,
        title: 't1',
        labels: ['shipper:locked'],
        state: 'OPEN',
        author: 'x',
        createdAt: '',
      },
      {
        number: 2,
        title: 't2',
        labels: ['shipper:locked'],
        state: 'OPEN',
        author: 'x',
        createdAt: '',
      },
    ]);
    mockIsLockStale.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    mockReleaseLock.mockResolvedValue(undefined);

    const getTool = collectTools();
    const result = await getTool('shipper_unlock')({ stale: true });
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
    expect(mockReleaseLock).toHaveBeenCalledWith('owner/repo', '1');
    expect(result.content[0]?.text).toContain('#1: stale — released');
    expect(result.content[0]?.text).toContain('#2: active — skipped');
  });

  it('rejects when neither issue nor stale is provided', async () => {
    const getTool = collectTools();
    const result = await getTool('shipper_unlock')({});
    expect(result.isError).toBe(true);
  });
});

describe('shipper_advance', () => {
  it('spawns shipper next with headless mode when issue is past shipper:new', async () => {
    mockGh.mockResolvedValue({
      stdout: JSON.stringify({
        number: 42,
        state: 'OPEN',
        labels: [{ name: 'shipper:groomed' }],
      }),
      stderr: '',
    });
    mockSpawnShipper.mockResolvedValue({
      exitCode: 0,
      stdout: 'advanced',
      stderr: '',
      timedOut: false,
    });
    const getTool = collectTools();
    const result = await getTool('shipper_advance')({ issue: 42 });
    expect(mockSpawnShipper).toHaveBeenCalled();
    const firstCall = mockSpawnShipper.mock.calls[0];
    expect(firstCall?.[0]).toEqual(['next', '42', '--mode', 'headless']);
    expect(result.content[0]?.text).toContain('[exit 0]');
  });

  it('refuses to advance a shipper:new issue (grooming requires interactive input)', async () => {
    mockGh.mockResolvedValue({
      stdout: JSON.stringify({
        number: 42,
        state: 'OPEN',
        labels: [{ name: 'shipper:new' }],
      }),
      stderr: '',
    });
    const getTool = collectTools();
    const result = await getTool('shipper_advance')({ issue: 42 });
    expect(mockSpawnShipper).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('interactively');
  });
});

describe('shipper_create_issue', () => {
  it('spawns shipper new with the request', async () => {
    mockSpawnShipper.mockResolvedValue({
      exitCode: 0,
      stdout: 'created #99',
      stderr: '',
      timedOut: false,
    });
    const getTool = collectTools();
    const result = await getTool('shipper_create_issue')({ request: 'Add dark mode' });
    const firstCall = mockSpawnShipper.mock.calls[0];
    expect(firstCall?.[0]).toEqual(['new', 'Add dark mode', '--mode', 'headless']);
    expect(result.content[0]?.text).toContain('created #99');
  });
});
