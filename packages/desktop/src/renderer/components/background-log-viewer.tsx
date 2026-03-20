import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';

import { Button } from './ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.js';

interface BackgroundLogViewerProps {
  open: boolean;
  title: string;
  content: string;
  onOpenChange: (open: boolean) => void;
}

export function BackgroundLogViewer({
  open,
  title,
  content,
  onOpenChange,
}: BackgroundLogViewerProps): JSX.Element {
  const contentRef = useRef<HTMLPreElement | null>(null);
  const resetCopiedTimeoutRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const [copied, setCopied] = useState(false);

  function clearCopiedTimeout(): void {
    if (resetCopiedTimeoutRef.current === null) {
      return;
    }

    window.clearTimeout(resetCopiedTimeoutRef.current);
    resetCopiedTimeoutRef.current = null;
  }

  function handleCopy(): void {
    if (content.length === 0) {
      return;
    }

    clearCopiedTimeout();
    void navigator.clipboard
      .writeText(content)
      .then(() => {
        setCopied(true);
        resetCopiedTimeoutRef.current = window.setTimeout(() => {
          setCopied(false);
          resetCopiedTimeoutRef.current = null;
        }, 2000);
      })
      .catch((error: unknown) => {
        setCopied(false);
        console.error('Failed to copy logs to clipboard.', error);
      });
  }

  useEffect(() => {
    if (!open || !contentRef.current) {
      return;
    }

    contentRef.current.scrollTop = contentRef.current.scrollHeight;
  }, [content, open]);

  useEffect(() => {
    if (open) {
      return;
    }

    clearCopiedTimeout();
    setCopied(false);
  }, [open]);

  useEffect(() => {
    return () => {
      clearCopiedTimeout();
    };
  }, []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(calc(100vw-2rem),56rem)] gap-0 p-0">
        <DialogHeader className="border-b border-border px-6 py-5">
          <div className="flex items-center gap-2">
            <DialogTitle className="flex-1">{title}</DialogTitle>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground"
              disabled={content.length === 0}
              onClick={handleCopy}
              aria-label="Copy logs to clipboard"
            >
              {copied ? (
                <Check className="size-4" aria-hidden="true" />
              ) : (
                <Copy className="size-4" aria-hidden="true" />
              )}
            </Button>
          </div>
          <DialogDescription>
            Live and buffered output for the selected background command.
          </DialogDescription>
        </DialogHeader>

        <pre
          ref={contentRef}
          className="background-log-viewer max-h-[70vh] overflow-auto px-6 py-5 text-sm whitespace-pre-wrap text-foreground"
        >
          {content.length > 0 ? content : 'No log output yet.'}
        </pre>
      </DialogContent>
    </Dialog>
  );
}
