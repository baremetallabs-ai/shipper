import { promisify } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGh, mockExecFileAsync } = vi.hoisted(() => ({
  mockGh: vi.fn<(args: string[]) => Promise<{ stdout: string; stderr: string }>>(),
  mockExecFileAsync:
    vi.fn<
      (
        cmd: string,
        args: string[],
        opts?: Record<string, unknown>
      ) => Promise<{ stdout: string; stderr: string }>
    >(),
}));

vi.mock('../../src/lib/gh.js', () => ({
  gh: (...args: unknown[]) => {
    return mockGh(...(args as [string[]]));
  },
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const execFile = Object.assign(
    (...args: unknown[]) => {
      void mockExecFileAsync(...(args as Parameters<typeof mockExecFileAsync>));
    },
    {
      [promisify.custom]: (...args: unknown[]) =>
        mockExecFileAsync(...(args as Parameters<typeof mockExecFileAsync>)),
    }
  );
  return { ...actual, execFile };
});

const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

const { checkLabels, runPrereqChecks, warnTrackedOutputFiles } =
  await import('../../src/lib/prerequisites.js');

beforeEach(() => {
  mockGh.mockReset();
  mockExecFileAsync.mockReset();
  stderrSpy.mockClear();
});

describe('checkLabels', () => {
  it('fails when shipper:pr-reviewed is the only missing workflow label', async () => {
    mockGh.mockResolvedValue({
      stdout: [
        'shipper:new',
        'shipper:groomed',
        'shipper:designed',
        'shipper:planned',
        'shipper:implemented',
        'shipper:pr-open',
        'shipper:ready',
      ].join('\n'),
      stderr: '',
    });

    await expect(checkLabels()).resolves.toEqual({
      ok: false,
      message: 'Missing label(s): shipper:pr-reviewed',
    });
  });

  it('passes when all workflow labels exist', async () => {
    mockGh.mockResolvedValue({
      stdout: [
        'shipper:new',
        'shipper:groomed',
        'shipper:designed',
        'shipper:planned',
        'shipper:implemented',
        'shipper:pr-open',
        'shipper:pr-reviewed',
        'shipper:ready',
      ].join('\n'),
      stderr: '',
    });

    await expect(checkLabels()).resolves.toEqual({
      ok: true,
      message: 'All required labels exist',
    });
  });
});

describe('warnTrackedOutputFiles', () => {
  it('writes one warning per tracked output or input file', async () => {
    mockExecFileAsync.mockResolvedValue({
      stdout: '.shipper/output/result.json\r\n.shipper/input/example.txt\r\n',
      stderr: '',
    });
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((() => true) as typeof process.stderr.write);

    await warnTrackedOutputFiles();

    expect(mockExecFileAsync).toHaveBeenCalledWith('git', [
      'ls-files',
      '--',
      '.shipper/output/',
      '.shipper/input/',
    ]);
    expect(stderrSpy).toHaveBeenCalledTimes(2);
    expect(stderrSpy).toHaveBeenNthCalledWith(
      1,
      "⚠ .shipper/output/result.json is tracked by git but should be gitignored. Run 'shipper init' and commit the result to fix this.\n"
    );
    expect(stderrSpy).toHaveBeenNthCalledWith(
      2,
      "⚠ .shipper/input/example.txt is tracked by git but should be gitignored. Run 'shipper init' and commit the result to fix this.\n"
    );

    stderrSpy.mockRestore();
  });

  it('stays silent when no tracked files are returned', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((() => true) as typeof process.stderr.write);

    await warnTrackedOutputFiles();

    expect(stderrSpy).not.toHaveBeenCalled();

    stderrSpy.mockRestore();
  });

  it('ignores .gitkeep entries', async () => {
    mockExecFileAsync.mockResolvedValue({
      stdout:
        '.shipper/output/.gitkeep\r\n.shipper/input/.gitkeep\r\n.shipper/output/result.json\r\n',
      stderr: '',
    });
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((() => true) as typeof process.stderr.write);

    await warnTrackedOutputFiles();

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      "⚠ .shipper/output/result.json is tracked by git but should be gitignored. Run 'shipper init' and commit the result to fix this.\n"
    );

    stderrSpy.mockRestore();
  });

  it('returns without writing when git ls-files fails', async () => {
    mockExecFileAsync.mockRejectedValue(new Error('git failed'));
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((() => true) as typeof process.stderr.write);

    await warnTrackedOutputFiles();

    expect(stderrSpy).not.toHaveBeenCalled();

    stderrSpy.mockRestore();
  });
});

describe('runPrereqChecks', () => {
  it('logs the failing prerequisite message and returns false', async () => {
    const result = await runPrereqChecks([
      () => Promise.resolve({ ok: true, message: 'fine' }),
      () => Promise.resolve({ ok: false, message: 'gh is not installed' }),
    ]);

    expect(result).toBe(false);
    expect(stderrSpy).toHaveBeenCalledWith('[shipper] Prereq failed: gh is not installed');
  });

  it('returns true without logging when all prerequisites pass', async () => {
    const result = await runPrereqChecks([
      () => Promise.resolve({ ok: true, message: 'fine' }),
      () => Promise.resolve({ ok: true, message: 'also fine' }),
    ]);

    expect(result).toBe(true);
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});
