import { useEffect, useRef } from 'react';
import type { JSX } from 'react';

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

  useEffect(() => {
    if (!open || !contentRef.current) {
      return;
    }

    contentRef.current.scrollTop = contentRef.current.scrollHeight;
  }, [content, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(calc(100vw-2rem),56rem)] gap-0 p-0">
        <DialogHeader className="border-b border-border px-6 py-5">
          <DialogTitle>{title}</DialogTitle>
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
