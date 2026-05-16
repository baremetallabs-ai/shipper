// @vitest-environment jsdom
/* global DataTransferItem, document, File, HTMLElement */

import { TextEncoder } from 'node:util';
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NEW_ISSUE_IMAGE_MIME_TYPES,
  NEW_ISSUE_MAX_IMAGE_BYTES,
  NEW_ISSUE_MAX_IMAGES,
} from '@baremetallabs-ai/shipper-core';

import { NewIssueDialog } from '../../src/renderer/components/new-issue-dialog.js';
import type { NewIssueCapabilities, NewIssueScreenshotPayload } from '../../src/renderer/types.js';

const defaultCapabilities: NewIssueCapabilities = {
  agent: 'codex',
  supportsImages: true,
  acceptedMimeTypes: [...NEW_ISSUE_IMAGE_MIME_TYPES],
  maxImageBytes: NEW_ISSUE_MAX_IMAGE_BYTES,
  maxImages: NEW_ISSUE_MAX_IMAGES,
};

let createObjectUrlMock: ReturnType<typeof vi.fn>;
let revokeObjectUrlMock: ReturnType<typeof vi.fn>;
let getNewIssueCapabilitiesMock: ReturnType<typeof vi.fn>;
let objectUrlCounter = 0;

function installShipperApi(capabilities: NewIssueCapabilities = defaultCapabilities): {
  getNewIssueCapabilities: ReturnType<typeof vi.fn>;
} {
  const getNewIssueCapabilities = vi.fn().mockResolvedValue(capabilities);
  getNewIssueCapabilitiesMock = getNewIssueCapabilities;
  Object.defineProperty(globalThis.window, 'shipperAPI', {
    configurable: true,
    value: {
      getNewIssueCapabilities,
    },
  });
  return { getNewIssueCapabilities };
}

async function waitForCapabilities(repo = 'owner/repo', minimumCallCount = 1): Promise<void> {
  await waitFor(() => {
    expect(
      getNewIssueCapabilitiesMock.mock.calls.filter(([calledRepo]) => calledRepo === repo).length
    ).toBeGreaterThanOrEqual(minimumCallCount);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function makeImageFile(type: string, name = `screenshot-${type.split('/')[1]}`): File {
  const file = new File([`bytes:${type}`], name, { type });
  const bytes = new TextEncoder().encode(`bytes:${type}`);
  Object.defineProperty(file, 'arrayBuffer', {
    configurable: true,
    value: vi.fn(() =>
      Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
    ),
  });
  return file;
}

function makeDeferredImageFile(
  type: string,
  name = `screenshot-${type.split('/')[1]}`
): { file: File; resolve: () => void } {
  const file = new File([`bytes:${type}`], name, { type });
  const bytes = new TextEncoder().encode(`bytes:${type}`);
  let resolveBuffer!: (value: ArrayBuffer) => void;
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const promise = new Promise<ArrayBuffer>((resolve) => {
    resolveBuffer = resolve;
  });
  Object.defineProperty(file, 'arrayBuffer', {
    configurable: true,
    value: vi.fn(() => promise),
  });
  return {
    file,
    resolve: () => {
      resolveBuffer(buffer);
    },
  };
}

function makeOversizedImageFile(): File {
  return new File([new Uint8Array(NEW_ISSUE_MAX_IMAGE_BYTES + 1)], 'huge.png', {
    type: 'image/png',
  });
}

function clipboardItem(file: File): DataTransferItem {
  return {
    type: file.type,
    getAsFile: () => file,
  } as unknown as DataTransferItem;
}

function pasteImages(target: HTMLElement, files: File[]): void {
  fireEvent.paste(target, {
    clipboardData: {
      items: files.map((file) => clipboardItem(file)),
    },
  });
}

function renderDialog({
  open = true,
  onOpenChange = vi.fn(),
  onSubmit = vi.fn(),
  repos = ['owner/repo'],
  activeRepo = 'owner/repo',
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onSubmit?: (request: string, repo: string, screenshots?: NewIssueScreenshotPayload[]) => void;
  repos?: string[];
  activeRepo?: string;
} = {}): ReturnType<typeof render> & {
  onOpenChange: (open: boolean) => void;
  onSubmit: (request: string, repo: string, screenshots?: NewIssueScreenshotPayload[]) => void;
} {
  const rendered = render(
    <NewIssueDialog
      open={open}
      onOpenChange={onOpenChange}
      repos={repos}
      activeRepo={activeRepo}
      onSubmit={onSubmit}
    />
  );
  return { ...rendered, onOpenChange, onSubmit };
}

beforeEach(() => {
  objectUrlCounter = 0;
  createObjectUrlMock = vi.fn(() => {
    objectUrlCounter += 1;
    return `blob:test-${objectUrlCounter}`;
  });
  revokeObjectUrlMock = vi.fn();
  Object.defineProperty(globalThis.URL, 'createObjectURL', {
    configurable: true,
    value: createObjectUrlMock,
  });
  Object.defineProperty(globalThis.URL, 'revokeObjectURL', {
    configurable: true,
    value: revokeObjectUrlMock,
  });
  installShipperApi();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('NewIssueDialog screenshots', () => {
  it.each([
    ['PNG', 'image/png'],
    ['JPEG', 'image/jpeg'],
    ['WebP', 'image/webp'],
  ])('adds a numbered thumbnail chip for pasted %s images', async (_label, mimeType) => {
    renderDialog();
    const textarea = screen.getByPlaceholderText('What do you want to build?');
    await waitForCapabilities();

    pasteImages(textarea, [makeImageFile(mimeType)]);

    expect(await screen.findByRole('button', { name: 'Preview screenshot 1' })).toBeTruthy();
    expect(screen.getByText('1')).toBeTruthy();
    expect(screen.queryByText(/aren't available/)).toBeNull();
  });

  it('rejects unsupported image MIME types with an inline error', async () => {
    renderDialog();
    const textarea = screen.getByPlaceholderText('What do you want to build?');
    await waitForCapabilities();

    pasteImages(textarea, [makeImageFile('image/bmp')]);

    expect(
      await screen.findByText('Only PNG, JPEG, and WebP screenshots can be attached.')
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Preview screenshot/ })).toBeNull();
  });

  it('rejects images larger than 10 MB with an inline error', async () => {
    renderDialog();
    const textarea = screen.getByPlaceholderText('What do you want to build?');
    await waitForCapabilities();

    pasteImages(textarea, [makeOversizedImageFile()]);

    expect(await screen.findByText('Screenshots must be 10 MB or smaller.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Preview screenshot/ })).toBeNull();
  });

  it('rejects a sixth image and accepts another paste after removal', async () => {
    renderDialog();
    const textarea = screen.getByPlaceholderText('What do you want to build?');
    await waitForCapabilities();

    pasteImages(
      textarea,
      Array.from({ length: 5 }, (_, index) => makeImageFile('image/png', `shot-${index}.png`))
    );
    expect(await screen.findByRole('button', { name: 'Preview screenshot 5' })).toBeTruthy();

    pasteImages(textarea, [makeImageFile('image/png', 'sixth.png')]);
    expect(
      await screen.findByText('Remove an existing screenshot before pasting another one.')
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Remove screenshot 2' }));
    expect(screen.queryByRole('button', { name: 'Remove screenshot 5' })).toBeNull();
    expect(revokeObjectUrlMock).toHaveBeenCalledWith('blob:test-2');

    pasteImages(textarea, [makeImageFile('image/png', 'replacement.png')]);
    expect(await screen.findByRole('button', { name: 'Remove screenshot 5' })).toBeTruthy();
  });

  it('rechecks the max screenshot count when async paste reads finish', async () => {
    renderDialog();
    const textarea = screen.getByPlaceholderText('What do you want to build?');
    await waitForCapabilities();

    const delayedFiles = Array.from({ length: 3 }, (_, index) =>
      makeDeferredImageFile('image/png', `slow-${index}.png`)
    );
    pasteImages(
      textarea,
      delayedFiles.map(({ file }) => file)
    );
    pasteImages(
      textarea,
      Array.from({ length: 3 }, (_, index) => makeImageFile('image/png', `fast-${index}.png`))
    );

    expect(await screen.findByRole('button', { name: 'Preview screenshot 3' })).toBeTruthy();

    await act(async () => {
      for (const delayed of delayedFiles) {
        delayed.resolve();
      }
      await Promise.resolve();
    });

    expect(
      await screen.findByText('Remove an existing screenshot before pasting another one.')
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Preview screenshot 4' })).toBeNull();
    expect(screen.getAllByRole('button', { name: /Preview screenshot/ })).toHaveLength(3);
  });

  it('removes a chip from the keyboard and renumbers remaining chips', async () => {
    renderDialog();
    const textarea = screen.getByPlaceholderText('What do you want to build?');
    await waitForCapabilities();

    pasteImages(textarea, [
      makeImageFile('image/png', 'first.png'),
      makeImageFile('image/png', 'second.png'),
    ]);
    const removeFirst = await screen.findByRole('button', { name: 'Remove screenshot 1' });

    removeFirst.focus();
    fireEvent.keyDown(removeFirst, { key: 'Enter' });

    expect(screen.queryByRole('button', { name: 'Remove screenshot 2' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove screenshot 1' })).toBeTruthy();
  });

  it('opens the preview from mouse and keyboard activation and closes it with Escape', async () => {
    renderDialog();
    const textarea = screen.getByPlaceholderText('What do you want to build?');
    await waitForCapabilities();

    pasteImages(textarea, [makeImageFile('image/png')]);
    const previewButton = await screen.findByRole('button', { name: 'Preview screenshot 1' });

    previewButton.focus();
    fireEvent.click(previewButton);
    expect(screen.getByAltText('Screenshot preview')).toBeTruthy();
    const previewDialog = screen.getByRole('dialog', { name: 'Screenshot preview' });
    const closeButton = screen.getByRole('button', { name: 'Close screenshot preview' });
    expect(document.activeElement).toBe(closeButton);

    fireEvent.keyDown(previewDialog, { key: 'Tab' });
    expect(document.activeElement).toBe(closeButton);

    fireEvent.keyDown(previewDialog, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByAltText('Screenshot preview')).toBeNull();
      expect(document.activeElement).toBe(previewButton);
    });

    fireEvent.keyDown(previewButton, { key: 'Enter' });
    expect(screen.getByAltText('Screenshot preview')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Screenshot preview' })).toBeTruthy();
  });

  it('keeps Launch gated by trimmed text with or without screenshots', async () => {
    renderDialog();
    const textarea = screen.getByPlaceholderText('What do you want to build?');
    const launch = screen.getByRole('button', { name: 'Launch' });
    await waitForCapabilities();

    expect(launch.hasAttribute('disabled')).toBe(true);
    pasteImages(textarea, [makeImageFile('image/png')]);
    expect(await screen.findByRole('button', { name: 'Preview screenshot 1' })).toBeTruthy();
    fireEvent.change(textarea, { target: { value: '   ' } });
    expect(launch.hasAttribute('disabled')).toBe(true);
    fireEvent.change(textarea, { target: { value: 'Fix this layout' } });
    expect(launch.hasAttribute('disabled')).toBe(false);
  });

  it('clears attachments on close and successful submit', async () => {
    const { rerender, onOpenChange } = renderDialog();
    const textarea = screen.getByPlaceholderText('What do you want to build?');
    await waitForCapabilities();

    pasteImages(textarea, [makeImageFile('image/png')]);
    expect(await screen.findByRole('button', { name: 'Preview screenshot 1' })).toBeTruthy();

    rerender(
      <NewIssueDialog
        open={false}
        onOpenChange={onOpenChange}
        repos={['owner/repo']}
        activeRepo="owner/repo"
        onSubmit={vi.fn()}
      />
    );
    rerender(
      <NewIssueDialog
        open
        onOpenChange={onOpenChange}
        repos={['owner/repo']}
        activeRepo="owner/repo"
        onSubmit={vi.fn()}
      />
    );
    expect(screen.queryByRole('button', { name: /Preview screenshot/ })).toBeNull();

    const reopenedTextarea = screen.getByPlaceholderText('What do you want to build?');
    await waitForCapabilities('owner/repo', 2);

    pasteImages(reopenedTextarea, [makeImageFile('image/png')]);
    expect(await screen.findByRole('button', { name: 'Preview screenshot 1' })).toBeTruthy();
    fireEvent.change(reopenedTextarea, { target: { value: 'Use this screenshot' } });
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(revokeObjectUrlMock).toHaveBeenCalled();
  });

  it('ignores completed paste reads after the dialog is closed', async () => {
    const { rerender, onOpenChange, onSubmit } = renderDialog();
    const textarea = screen.getByPlaceholderText('What do you want to build?');
    await waitForCapabilities();

    const delayed = makeDeferredImageFile('image/png', 'slow.png');
    pasteImages(textarea, [delayed.file]);

    rerender(
      <NewIssueDialog
        open={false}
        onOpenChange={onOpenChange}
        repos={['owner/repo']}
        activeRepo="owner/repo"
        onSubmit={onSubmit}
      />
    );

    await act(async () => {
      delayed.resolve();
      await Promise.resolve();
    });

    rerender(
      <NewIssueDialog
        open
        onOpenChange={onOpenChange}
        repos={['owner/repo']}
        activeRepo="owner/repo"
        onSubmit={onSubmit}
      />
    );
    await waitForCapabilities('owner/repo', 2);

    expect(screen.queryByRole('button', { name: /Preview screenshot/ })).toBeNull();
    expect(createObjectUrlMock).not.toHaveBeenCalled();
  });

  it('shows the non-capable agent hint and suppresses image paste behavior', async () => {
    installShipperApi({
      ...defaultCapabilities,
      agent: 'claude',
      supportsImages: false,
    });
    renderDialog();

    expect(
      await screen.findByText("Image attachments aren't available for the claude agent.")
    ).toBeTruthy();

    pasteImages(screen.getByPlaceholderText('What do you want to build?'), [
      makeImageFile('image/png'),
    ]);

    expect(screen.queryByRole('button', { name: /Preview screenshot/ })).toBeNull();
    expect(screen.queryByText(/Only PNG/)).toBeNull();
  });

  it('clears pasted screenshots when switching to a non-capable repo', async () => {
    const onSubmit = vi.fn();
    renderDialog({ onSubmit, repos: ['owner/repo', 'owner/claude'] });
    const textarea = screen.getByPlaceholderText('What do you want to build?');
    await waitForCapabilities('owner/repo');

    pasteImages(textarea, [makeImageFile('image/png')]);
    expect(await screen.findByRole('button', { name: 'Preview screenshot 1' })).toBeTruthy();

    getNewIssueCapabilitiesMock.mockResolvedValueOnce({
      ...defaultCapabilities,
      agent: 'claude',
      supportsImages: false,
    });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'owner/claude' } });

    expect(revokeObjectUrlMock).toHaveBeenCalledWith('blob:test-1');
    expect(screen.queryByRole('button', { name: /Preview screenshot/ })).toBeNull();
    expect(
      await screen.findByText("Image attachments aren't available for the claude agent.")
    ).toBeTruthy();

    fireEvent.change(textarea, { target: { value: 'Text-only issue' } });
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));

    expect(onSubmit).toHaveBeenCalledWith('Text-only issue', 'owner/claude', undefined);
  });

  it('submits screenshot payloads in chip order without object URLs', async () => {
    const onSubmit = vi.fn();
    renderDialog({ onSubmit });
    const textarea = screen.getByPlaceholderText('What do you want to build?');
    await waitForCapabilities();

    pasteImages(textarea, [
      makeImageFile('image/png', 'first.png'),
      makeImageFile('image/jpeg', 'second.jpg'),
    ]);
    expect(await screen.findByRole('button', { name: 'Preview screenshot 2' })).toBeTruthy();
    fireEvent.change(textarea, { target: { value: 'Fix the screenshot issue' } });
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));

    const screenshots = onSubmit.mock.calls[0]?.[2] as NewIssueScreenshotPayload[];
    expect(onSubmit).toHaveBeenCalledWith('Fix the screenshot issue', 'owner/repo', screenshots);
    expect(screenshots.map((screenshot) => screenshot.mimeType)).toEqual([
      'image/png',
      'image/jpeg',
    ]);
    expect(Buffer.from(screenshots[0]?.bytes ?? new ArrayBuffer(0)).toString()).toBe(
      'bytes:image/png'
    );
    expect('objectUrl' in screenshots[0]).toBe(false);
  });
});
