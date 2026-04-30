import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetRepoNwo,
  mockLoadSettings,
  mockRegisterInitErrorTools,
  mockRegisterTools,
  mockResolveAndEnterRepoDir,
  mockRunAuthPreflight,
  mockRunPreflight,
  mockServerInstances,
} = vi.hoisted(() => ({
  mockGetRepoNwo: vi.fn<() => Promise<string>>(),
  mockLoadSettings: vi.fn<() => Promise<void>>(),
  mockRegisterInitErrorTools: vi.fn<(server: object, error: unknown) => void>(),
  mockRegisterTools: vi.fn<(server: object, repo: string) => Promise<void>>(),
  mockResolveAndEnterRepoDir: vi.fn<() => Promise<string>>(),
  mockRunAuthPreflight: vi.fn<() => Promise<void>>(),
  mockRunPreflight: vi.fn<(repo: string) => Promise<void>>(),
  mockServerInstances: [] as object[],
}));

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class MockMcpServer {
    registerTool = vi.fn();

    constructor(public readonly config: { name: string; version: string }) {
      mockServerInstances.push(this);
    }
  },
}));

vi.mock('@dnsquared/shipper-core', () => ({
  getRepoNwo: () => mockGetRepoNwo(),
  loadSettings: () => mockLoadSettings(),
  runAuthPreflight: () => mockRunAuthPreflight(),
  runPreflight: (repo: string) => mockRunPreflight(repo),
}));

vi.mock('../src/repo-dir.js', () => ({
  resolveAndEnterRepoDir: () => mockResolveAndEnterRepoDir(),
}));

vi.mock('../src/tools.js', () => ({
  registerInitErrorTools: (server: object, error: unknown) => {
    mockRegisterInitErrorTools(server, error);
  },
  registerTools: (server: object, repo: string) => mockRegisterTools(server, repo),
}));

const { createServer } = await import('../src/server.js');

describe('createServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockServerInstances.length = 0;
  });

  it('runs repo-dir resolution before the existing startup steps', async () => {
    mockResolveAndEnterRepoDir.mockResolvedValue('/tmp/repo');
    mockLoadSettings.mockResolvedValue(undefined);
    mockRunAuthPreflight.mockResolvedValue(undefined);
    mockGetRepoNwo.mockResolvedValue('owner/repo');
    mockRunPreflight.mockResolvedValue(undefined);
    let registrationCompleted = false;
    mockRegisterTools.mockImplementationOnce(async () => {
      await Promise.resolve();
      registrationCompleted = true;
    });

    const server = await createServer();

    expect(server).toBe(mockServerInstances[0]);
    expect(mockResolveAndEnterRepoDir).toHaveBeenCalledOnce();
    expect(mockLoadSettings).toHaveBeenCalledOnce();
    expect(mockRunAuthPreflight).toHaveBeenCalledOnce();
    expect(mockGetRepoNwo).toHaveBeenCalledOnce();
    expect(mockRunPreflight).toHaveBeenCalledWith('owner/repo');
    expect(mockRegisterTools).toHaveBeenCalledWith(server, 'owner/repo');
    expect(registrationCompleted).toBe(true);
    expect(mockRegisterInitErrorTools).not.toHaveBeenCalled();

    const resolveOrder = mockResolveAndEnterRepoDir.mock.invocationCallOrder[0];
    const loadOrder = mockLoadSettings.mock.invocationCallOrder[0];
    const authOrder = mockRunAuthPreflight.mock.invocationCallOrder[0];
    const repoOrder = mockGetRepoNwo.mock.invocationCallOrder[0];
    const preflightOrder = mockRunPreflight.mock.invocationCallOrder[0];
    const registerOrder = mockRegisterTools.mock.invocationCallOrder[0];

    expect(resolveOrder).toBeLessThan(loadOrder);
    expect(loadOrder).toBeLessThan(authOrder);
    expect(authOrder).toBeLessThan(repoOrder);
    expect(repoOrder).toBeLessThan(preflightOrder);
    expect(preflightOrder).toBeLessThan(registerOrder);
  });

  it('registers init-error tools when auth preflight fails', async () => {
    const startupError = new Error('auth missing');
    mockResolveAndEnterRepoDir.mockResolvedValue('/tmp/repo');
    mockLoadSettings.mockResolvedValue(undefined);
    mockRunAuthPreflight.mockRejectedValue(startupError);

    const server = await createServer();

    expect(server).toBe(mockServerInstances[0]);
    expect(mockGetRepoNwo).not.toHaveBeenCalled();
    expect(mockRunPreflight).not.toHaveBeenCalled();
    expect(mockRegisterTools).not.toHaveBeenCalled();
    expect(mockRegisterInitErrorTools).toHaveBeenCalledWith(server, startupError);
  });

  it('registers init-error tools when repo-dir resolution fails', async () => {
    const startupError = new Error('SHIPPER_REPO_DIR is not a git repository: /tmp/not-repo');
    mockResolveAndEnterRepoDir.mockRejectedValue(startupError);

    const server = await createServer();

    expect(server).toBe(mockServerInstances[0]);
    expect(mockLoadSettings).not.toHaveBeenCalled();
    expect(mockRunAuthPreflight).not.toHaveBeenCalled();
    expect(mockGetRepoNwo).not.toHaveBeenCalled();
    expect(mockRunPreflight).not.toHaveBeenCalled();
    expect(mockRegisterTools).not.toHaveBeenCalled();
    expect(mockRegisterInitErrorTools).toHaveBeenCalledWith(server, startupError);
  });
});
