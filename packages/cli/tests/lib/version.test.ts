import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getSettingsMock = vi.fn();

vi.mock('../../src/lib/settings.js', () => ({
  getSettings: () => getSettingsMock(),
}));

const exitMock = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
const errorMock = vi.spyOn(console, 'error').mockImplementation(() => {});

let savedVersion: string | undefined;
let savedSkip: string | undefined;

beforeEach(() => {
  savedVersion = process.env.SHIPPER_VERSION;
  savedSkip = process.env.SHIPPER_SKIP_VERSION_CHECK;
  delete process.env.SHIPPER_SKIP_VERSION_CHECK;
  getSettingsMock.mockReset();
  exitMock.mockClear();
  errorMock.mockClear();
  vi.resetModules();
});

afterEach(() => {
  if (savedVersion !== undefined) {
    process.env.SHIPPER_VERSION = savedVersion;
  } else {
    delete process.env.SHIPPER_VERSION;
  }
  if (savedSkip !== undefined) {
    process.env.SHIPPER_SKIP_VERSION_CHECK = savedSkip;
  } else {
    delete process.env.SHIPPER_SKIP_VERSION_CHECK;
  }
});

describe('checkVersionFreshness', () => {
  it('does not error when versions match', async () => {
    process.env.SHIPPER_VERSION = '1.0.0';
    const { checkVersionFreshness } = await import('../../src/lib/version.js');
    getSettingsMock.mockReturnValue({ cliVersion: '1.0.0' });
    checkVersionFreshness();
    expect(exitMock).not.toHaveBeenCalled();
  });

  it('exits with error when versions mismatch', async () => {
    process.env.SHIPPER_VERSION = '2.0.0';
    const { checkVersionFreshness } = await import('../../src/lib/version.js');
    getSettingsMock.mockReturnValue({ cliVersion: '1.0.0' });
    checkVersionFreshness();
    expect(exitMock).toHaveBeenCalledWith(1);
    expect(errorMock).toHaveBeenCalledWith(
      expect.stringContaining('Installed CLI version (2.0.0)')
    );
    expect(errorMock).toHaveBeenCalledWith(expect.stringContaining('initialized version (1.0.0)'));
  });

  it('exits with error when fingerprint is missing', async () => {
    process.env.SHIPPER_VERSION = '1.0.0';
    const { checkVersionFreshness } = await import('../../src/lib/version.js');
    getSettingsMock.mockReturnValue({});
    checkVersionFreshness();
    expect(exitMock).toHaveBeenCalledWith(1);
    expect(errorMock).toHaveBeenCalledWith(expect.stringContaining('No version fingerprint found'));
  });

  it('skips check when installed version is 0.0.0-dev', async () => {
    delete process.env.SHIPPER_VERSION;
    const { checkVersionFreshness } = await import('../../src/lib/version.js');
    getSettingsMock.mockReturnValue({ cliVersion: '1.0.0' });
    checkVersionFreshness();
    expect(exitMock).not.toHaveBeenCalled();
  });

  it('skips check when recorded version is 0.0.0-dev', async () => {
    process.env.SHIPPER_VERSION = '1.0.0';
    const { checkVersionFreshness } = await import('../../src/lib/version.js');
    getSettingsMock.mockReturnValue({ cliVersion: '0.0.0-dev' });
    checkVersionFreshness();
    expect(exitMock).not.toHaveBeenCalled();
  });

  it('skips check when SHIPPER_SKIP_VERSION_CHECK=1', async () => {
    process.env.SHIPPER_VERSION = '2.0.0';
    process.env.SHIPPER_SKIP_VERSION_CHECK = '1';
    const { checkVersionFreshness } = await import('../../src/lib/version.js');
    getSettingsMock.mockReturnValue({ cliVersion: '1.0.0' });
    checkVersionFreshness();
    expect(exitMock).not.toHaveBeenCalled();
  });
});
