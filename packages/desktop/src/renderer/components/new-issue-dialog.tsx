import { useRef, useState } from 'react';
import type { JSX, KeyboardEvent, SyntheticEvent } from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.js';

interface NewIssueDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (request: string) => void;
}

export function NewIssueDialog({ open, onOpenChange, onSubmit }: NewIssueDialogProps): JSX.Element {
  const [request, setRequest] = useState('');
  const formRef = useRef<HTMLFormElement>(null);

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      formRef.current?.requestSubmit();
    }
  }

  function handleSubmit(e: SyntheticEvent): void {
    e.preventDefault();
    const trimmed = request.trim();
    if (!trimmed) return;

    onSubmit(trimmed);
    setRequest('');
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0">
        <DialogHeader className="border-b border-border px-6 py-5">
          <DialogTitle>New Issue</DialogTitle>
          <DialogDescription>
            Describe what you want to build. An agent will create a GitHub issue from your request.
          </DialogDescription>
        </DialogHeader>

        <form ref={formRef} onSubmit={handleSubmit} className="px-6 py-4">
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
          <p className="mt-1 text-xs text-muted-foreground">
            Enter to submit, Shift+Enter for newline
          </p>
          <div className="mt-3 flex justify-end">
            <button
              type="submit"
              disabled={request.trim().length === 0}
              className="cursor-pointer rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              Launch
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
