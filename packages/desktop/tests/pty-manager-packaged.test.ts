import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  bundledPty: {
    spawn: vi.fn(),
  },
  fs: {
    cpSync: vi.fn(),
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    mkdtempSync: vi.fn(),
    readFileSync: vi.fn(),
    renameSync: vi.fn(),
    rmSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
  packagedPty: {
    spawn: vi.fn(),
  },
  require: vi.fn(),
}));

vi.mock('node-pty', () => mocks.bundledPty);
vi.mock('node:fs', () => mocks.fs);
vi.mock('node:module', () => ({
  createRequire: () => mocks.require,
}));

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
const originalElectronVersion = Object.getOwnPropertyDescriptor(process.versions, 'electron');

const resourcesPath = '/Applications/Shipper.app/Contents/Resources';
const sourcePath = path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'node-pty');
const packageJsonPath = path.join(sourcePath, 'package.json');
const userDataPath = '/Users/test/Library/Application Support/Shipper';
const cacheRoot = path.join(userDataPath, 'native');
const cachePath = path.join(cacheRoot, 'node-pty-1.1.0-electron-41.3.0');
const markerFileName = '.shipper-node-pty-cache.json';
const markerPath = path.join(cachePath, markerFileName);
const marker = `${JSON.stringify({ packageVersion: '1.1.0', electronVersion: '41.3.0' }, null, 2)}\n`;

function createMockPtyProcess() {
  return {
    pid: 1234,
    onData: vi.fn(),
    onExit: vi.fn(),
    resize: vi.fn(),
    write: vi.fn(),
  };
}

function setPackagedDarwinProcess(): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: resourcesPath });
  Object.defineProperty(process.versions, 'electron', { configurable: true, value: '41.3.0' });
}

function restoreProcess(): void {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);

  if (originalResourcesPath) {
    Object.defineProperty(process, 'resourcesPath', originalResourcesPath);
  } else {
    Reflect.deleteProperty(process, 'resourcesPath');
  }

  if (originalElectronVersion) {
    Object.defineProperty(process.versions, 'electron', originalElectronVersion);
  } else {
    Reflect.deleteProperty(process.versions, 'electron');
  }
}

function setupPackagedRequire(): void {
  mocks.require.mockImplementation((moduleId: string) => {
    if (moduleId === 'electron') {
      return {
        app: {
          isPackaged: true,
          getPath: vi.fn(() => userDataPath),
        },
      };
    }

    if (moduleId === path.join(cachePath, 'lib', 'index.js')) {
      return mocks.packagedPty;
    }

    throw new Error(`Unexpected require: ${moduleId}`);
  });
}

describe('PtyManager packaged macOS node-pty cache', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    setPackagedDarwinProcess();
    setupPackagedRequire();
    mocks.fs.readFileSync.mockImplementation((filePath: string) => {
      if (filePath === packageJsonPath) return JSON.stringify({ version: '1.1.0' });
      if (filePath === markerPath) return marker;
      throw new Error(`Unexpected readFileSync: ${filePath}`);
    });
    mocks.packagedPty.spawn.mockImplementation(() => createMockPtyProcess());
  });

  afterEach(() => {
    restoreProcess();
  });

  it('publishes a complete cache directory atomically and reuses the loaded module', async () => {
    const tempPath = path.join(cacheRoot, '.node-pty-temp');
    mocks.fs.existsSync.mockReturnValue(false);
    mocks.fs.mkdtempSync.mockReturnValue(tempPath);

    const { PtyManager } = await import('../src/main/pty-manager.js');
    const manager = new PtyManager();

    manager.spawn('session-1', 'bash', [], { cols: 80, rows: 24 });
    manager.spawn('session-2', 'zsh', [], { cols: 80, rows: 24 });

    expect(mocks.fs.mkdirSync).toHaveBeenCalledWith(cacheRoot, { recursive: true });
    expect(mocks.fs.cpSync).toHaveBeenCalledTimes(1);
    expect(mocks.fs.cpSync).toHaveBeenCalledWith(sourcePath, tempPath, { recursive: true });
    expect(mocks.fs.writeFileSync).toHaveBeenCalledWith(
      path.join(tempPath, markerFileName),
      marker
    );
    expect(mocks.fs.renameSync).toHaveBeenCalledWith(tempPath, cachePath);
    expect(mocks.fs.rmSync).not.toHaveBeenCalled();
    expect(mocks.require).toHaveBeenCalledWith(path.join(cachePath, 'lib', 'index.js'));
    expect(mocks.bundledPty.spawn).not.toHaveBeenCalled();
    expect(mocks.packagedPty.spawn).toHaveBeenCalledTimes(2);
  });

  it('uses a concurrently published valid cache instead of deleting it', async () => {
    const tempPath = path.join(cacheRoot, '.node-pty-temp');
    let markerExists = false;
    const existingPathError = Object.assign(new Error('already exists'), { code: 'EEXIST' });

    mocks.fs.existsSync.mockImplementation((filePath: string) =>
      filePath === markerPath ? markerExists : false
    );
    mocks.fs.mkdtempSync.mockReturnValue(tempPath);
    mocks.fs.renameSync.mockImplementationOnce(() => {
      markerExists = true;
      throw existingPathError;
    });

    const { PtyManager } = await import('../src/main/pty-manager.js');
    const manager = new PtyManager();

    manager.spawn('session-1', 'bash', [], { cols: 80, rows: 24 });

    expect(mocks.fs.rmSync).toHaveBeenCalledWith(tempPath, { recursive: true, force: true });
    expect(mocks.fs.rmSync).not.toHaveBeenCalledWith(cachePath, expect.anything());
    expect(mocks.require).toHaveBeenCalledWith(path.join(cachePath, 'lib', 'index.js'));
    expect(mocks.packagedPty.spawn).toHaveBeenCalledTimes(1);
  });

  it('reports malformed package metadata before copying the native cache', async () => {
    mocks.fs.existsSync.mockReturnValue(false);
    mocks.fs.readFileSync.mockImplementation((filePath: string) => {
      if (filePath === packageJsonPath) return '{';
      throw new Error(`Unexpected readFileSync: ${filePath}`);
    });

    const { PtyManager } = await import('../src/main/pty-manager.js');
    const manager = new PtyManager();

    expect(() => {
      manager.spawn('session-1', 'bash', [], { cols: 80, rows: 24 });
    }).toThrow(`Unable to read node-pty package metadata from ${packageJsonPath}.`);
    expect(mocks.fs.cpSync).not.toHaveBeenCalled();
    expect(mocks.packagedPty.spawn).not.toHaveBeenCalled();
  });
});
