import { X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClipboardEvent, JSX, KeyboardEvent, SyntheticEvent } from 'react';

import { getShipperApi } from '../lib/shipper-api.js';
import type { NewIssueImageMimeType } from '@baremetallabs-ai/shipper-core';
import type { NewIssueCapabilities, NewIssueScreenshotPayload } from '../types.js';
import { Button } from './ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.js';

interface NewIssueDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repos: string[];
  activeRepo: string;
  onSubmit: (request: string, repo: string, screenshots?: NewIssueScreenshotPayload[]) => void;
}

interface ScreenshotAttachment {
  id: string;
  mimeType: NewIssueImageMimeType;
  bytes: ArrayBuffer;
  objectUrl: string;
}

function createAttachmentId(): string {
  return globalThis.crypto.randomUUID();
}

function revokeAttachments(attachments: ScreenshotAttachment[]): void {
  for (const attachment of attachments) {
    URL.revokeObjectURL(attachment.objectUrl);
  }
}

export function NewIssueDialog({
  open,
  onOpenChange,
  repos,
  activeRepo,
  onSubmit,
}: NewIssueDialogProps): JSX.Element {
  const [request, setRequest] = useState('');
  const [selectedRepo, setSelectedRepo] = useState(activeRepo);
  const [attachments, setAttachments] = useState<ScreenshotAttachment[]>([]);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [previewAttachmentId, setPreviewAttachmentId] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<NewIssueCapabilities | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const attachmentsRef = useRef<ScreenshotAttachment[]>([]);
  const openRef = useRef(open);
  const selectedRepoRef = useRef(selectedRepo);
  const pasteGenerationRef = useRef(0);
  const previewCloseButtonRef = useRef<HTMLButtonElement>(null);
  const previewReturnFocusRef = useRef<HTMLElement | null>(null);

  openRef.current = open;
  selectedRepoRef.current = selectedRepo;

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    if (!open) {
      return;
    }

    let cancelled = false;
    setCapabilities(null);
    void getShipperApi()
      .getNewIssueCapabilities(selectedRepo)
      .then((nextCapabilities) => {
        if (!cancelled) {
          setCapabilities(nextCapabilities);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setCapabilities(null);
          console.warn(
            `[shipper] Failed to resolve New Issue capabilities: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open, selectedRepo]);

  useEffect(() => {
    return () => {
      pasteGenerationRef.current += 1;
      openRef.current = false;
      revokeAttachments(attachmentsRef.current);
    };
  }, []);

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      formRef.current?.requestSubmit();
    }
  }

  const clearAttachments = useCallback(() => {
    pasteGenerationRef.current += 1;
    revokeAttachments(attachmentsRef.current);
    attachmentsRef.current = [];
    setAttachments([]);
    setPreviewAttachmentId(null);
  }, []);

  const removeAttachment = useCallback((id: string) => {
    const removed = attachmentsRef.current.find((attachment) => attachment.id === id);
    if (removed) {
      URL.revokeObjectURL(removed.objectUrl);
    }
    attachmentsRef.current = attachmentsRef.current.filter((attachment) => attachment.id !== id);
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
    setPasteError(null);
    setPreviewAttachmentId((current) => (current === id ? null : current));
  }, []);

  useEffect(() => {
    if (!open) {
      setSelectedRepo(activeRepo);
      setPasteError(null);
      setCapabilities(null);
      clearAttachments();
    }
  }, [activeRepo, clearAttachments, open]);

  const handleDialogOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        setPasteError(null);
        setCapabilities(null);
        clearAttachments();
      }
      onOpenChange(nextOpen);
    },
    [clearAttachments, onOpenChange]
  );

  const isPasteCurrent = useCallback((generation: number, repo: string): boolean => {
    return (
      openRef.current &&
      pasteGenerationRef.current === generation &&
      selectedRepoRef.current === repo
    );
  }, []);

  const openPreview = useCallback((id: string) => {
    const activeElement = document.activeElement;
    previewReturnFocusRef.current = activeElement instanceof HTMLElement ? activeElement : null;
    setPreviewAttachmentId(id);
  }, []);

  const closePreview = useCallback(() => {
    const returnFocus = previewReturnFocusRef.current;
    previewReturnFocusRef.current = null;
    setPreviewAttachmentId(null);
    globalThis.queueMicrotask(() => {
      if (returnFocus && document.contains(returnFocus)) {
        returnFocus.focus();
      }
    });
  }, []);

  async function addImageFiles(
    files: Array<{ file: File; mimeType: NewIssueImageMimeType }>,
    repo: string,
    maxImages: number
  ): Promise<void> {
    const created: ScreenshotAttachment[] = [];
    const generation = pasteGenerationRef.current;
    try {
      for (const { file, mimeType } of files) {
        const bytes = await file.arrayBuffer();
        if (!isPasteCurrent(generation, repo)) {
          revokeAttachments(created);
          return;
        }

        created.push({
          id: createAttachmentId(),
          mimeType,
          bytes,
          objectUrl: URL.createObjectURL(file),
        });
      }

      if (!isPasteCurrent(generation, repo)) {
        revokeAttachments(created);
        return;
      }

      const commitResult = {
        accepted: false,
        rejectedForCapacity: false,
      };
      setAttachments((current) => {
        if (!isPasteCurrent(generation, repo)) {
          return current;
        }
        if (current.length + created.length > maxImages) {
          commitResult.rejectedForCapacity = true;
          return current;
        }

        commitResult.accepted = true;
        return [...current, ...created];
      });

      if (commitResult.accepted) {
        setPasteError(null);
        return;
      }

      revokeAttachments(created);
      if (commitResult.rejectedForCapacity && isPasteCurrent(generation, repo)) {
        setPasteError('Remove an existing screenshot before pasting another one.');
      }
    } catch {
      revokeAttachments(created);
      if (isPasteCurrent(generation, repo)) {
        setPasteError('Unable to read the pasted image. Try copying it again.');
      }
    }
  }

  function handlePaste(e: ClipboardEvent<HTMLElement>): void {
    if (!capabilities?.supportsImages) {
      return;
    }

    const imageItems = Array.from(e.clipboardData.items).filter((item) =>
      item.type.startsWith('image/')
    );
    if (imageItems.length === 0) {
      return;
    }

    e.preventDefault();

    if (attachmentsRef.current.length + imageItems.length > capabilities.maxImages) {
      setPasteError('Remove an existing screenshot before pasting another one.');
      return;
    }

    const files: Array<{ file: File; mimeType: NewIssueImageMimeType }> = [];
    for (const item of imageItems) {
      if (!capabilities.acceptedMimeTypes.includes(item.type as NewIssueImageMimeType)) {
        setPasteError('Only PNG, JPEG, and WebP screenshots can be attached.');
        return;
      }

      const file = item.getAsFile();
      if (!file) {
        setPasteError('Unable to read the pasted image. Try copying it again.');
        return;
      }
      if (file.size > capabilities.maxImageBytes) {
        setPasteError('Screenshots must be 10 MB or smaller.');
        return;
      }

      files.push({ file, mimeType: item.type as NewIssueImageMimeType });
    }

    void addImageFiles(files, selectedRepo, capabilities.maxImages);
  }

  function handleSubmit(e: SyntheticEvent): void {
    e.preventDefault();
    const trimmed = request.trim();
    if (!trimmed) return;

    const screenshots = capabilities?.supportsImages
      ? attachments.map(({ mimeType, bytes }) => ({ mimeType, bytes }))
      : [];
    onSubmit(trimmed, selectedRepo, screenshots.length > 0 ? screenshots : undefined);
    clearAttachments();
    setRequest('');
    handleDialogOpenChange(false);
  }

  const previewAttachment =
    previewAttachmentId === null
      ? undefined
      : attachments.find((attachment) => attachment.id === previewAttachmentId);
  const imageAttachmentsUnavailable = capabilities !== null && !capabilities.supportsImages;

  useEffect(() => {
    if (previewAttachment) {
      previewCloseButtonRef.current?.focus();
    }
  }, [previewAttachment]);

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent
        className="gap-0 p-0"
        onEscapeKeyDown={(event) => {
          if (previewAttachment) {
            event.preventDefault();
            closePreview();
          }
        }}
        onPaste={capabilities?.supportsImages ? handlePaste : undefined}
      >
        <DialogHeader className="border-b border-border px-6 py-5">
          <DialogTitle>New Issue</DialogTitle>
          <DialogDescription>
            Describe what you want to build. An agent will create a GitHub issue from your request.
          </DialogDescription>
        </DialogHeader>

        <form
          ref={formRef}
          onSubmit={handleSubmit}
          className="px-6 py-4"
          inert={previewAttachment ? true : undefined}
          aria-hidden={previewAttachment ? true : undefined}
        >
          <label className="mb-3 block">
            <span className="mb-1 block text-sm font-medium text-foreground">Repository</span>
            <select
              value={selectedRepo}
              onChange={(e) => {
                const nextRepo = e.target.value;
                if (nextRepo !== selectedRepo) {
                  selectedRepoRef.current = nextRepo;
                  clearAttachments();
                  setPasteError(null);
                  setCapabilities(null);
                }
                setSelectedRepo(nextRepo);
              }}
              disabled={repos.length === 1}
              className="border-input bg-card text-foreground focus-visible:border-ring focus-visible:ring-ring/50 block h-9 w-full rounded-md border px-3 py-1 text-sm transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {repos.map((repo) => (
                <option key={repo} value={repo}>
                  {repo}
                </option>
              ))}
            </select>
          </label>
          <textarea
            value={request}
            onChange={(e) => {
              setRequest(e.target.value);
            }}
            onKeyDown={handleKeyDown}
            placeholder="What do you want to build?"
            rows={4}
            className="w-full resize-none rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground transition-[color,box-shadow] placeholder:text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            autoFocus
          />
          {attachments.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2" aria-label="Attached screenshots">
              {attachments.map((attachment, index) => (
                <div key={attachment.id} className="group relative size-16">
                  <button
                    type="button"
                    onClick={() => {
                      openPreview(attachment.id);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        openPreview(attachment.id);
                      }
                    }}
                    className="relative size-16 overflow-hidden rounded-md border border-border bg-card outline-none transition-[border-color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    aria-label={`Preview screenshot ${index + 1}`}
                  >
                    <img
                      src={attachment.objectUrl}
                      alt=""
                      className="size-full object-cover"
                      draggable={false}
                    />
                    <span className="absolute bottom-1 left-1 grid size-5 place-items-center rounded-sm bg-background/90 text-[11px] font-semibold text-foreground shadow-sm">
                      {index + 1}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove screenshot ${index + 1}`}
                    onClick={() => {
                      removeAttachment(attachment.id);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        removeAttachment(attachment.id);
                      }
                    }}
                    className="absolute -top-1.5 -right-1.5 grid size-6 place-items-center rounded-full border border-border bg-background text-foreground opacity-0 shadow-sm transition-opacity hover:bg-accent focus:opacity-100 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 group-hover:opacity-100 group-focus-within:opacity-100"
                  >
                    <X className="size-3.5" aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          {pasteError ? <p className="mt-2 text-xs text-destructive">{pasteError}</p> : null}
          {imageAttachmentsUnavailable ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Image attachments aren&apos;t available for the {capabilities.agent} agent.
            </p>
          ) : null}
          <p className="mt-1 text-xs text-muted-foreground">
            Enter to submit, Shift+Enter for newline
          </p>
          <DialogFooter className="mt-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                handleDialogOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={request.trim().length === 0}>
              Launch
            </Button>
          </DialogFooter>
        </form>
        {previewAttachment ? (
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Screenshot preview"
            className="absolute inset-0 z-10 grid place-items-center rounded-sm bg-background/95 p-6"
            onClick={() => {
              closePreview();
            }}
            onKeyDownCapture={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                closePreview();
              } else if (event.key === 'Tab') {
                event.preventDefault();
                event.stopPropagation();
                previewCloseButtonRef.current?.focus();
              }
            }}
          >
            <div
              className="relative max-h-full max-w-full"
              onClick={(event) => {
                event.stopPropagation();
              }}
            >
              <img
                src={previewAttachment.objectUrl}
                alt="Screenshot preview"
                className="max-h-[min(70vh,34rem)] max-w-[min(80vw,46rem)] rounded-md border border-border object-contain shadow-xl"
              />
              <button
                ref={previewCloseButtonRef}
                type="button"
                aria-label="Close screenshot preview"
                onClick={() => {
                  closePreview();
                }}
                className="absolute -top-3 -right-3 grid size-8 place-items-center rounded-full border border-border bg-background text-foreground shadow-sm transition-colors hover:bg-accent focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
