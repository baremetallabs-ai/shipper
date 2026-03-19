import { useEffect, useRef, useState } from 'react';
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
  repos: string[];
  activeRepo: string;
  onSubmit: (request: string, repo: string) => void;
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
  const formRef = useRef<HTMLFormElement>(null);
  const wasOpenRef = useRef(open);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setSelectedRepo(activeRepo);
    }

    wasOpenRef.current = open;
  }, [activeRepo, open]);

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

    onSubmit(trimmed, selectedRepo);
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
          <label className="mb-3 block">
            <span className="mb-1 block text-sm font-medium text-foreground">Repository</span>
            <select
              value={selectedRepo}
              onChange={(e) => {
                setSelectedRepo(e.target.value);
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
          <p className="mt-1 text-xs text-muted-foreground">
            Enter to submit, Shift+Enter for newline
          </p>
          <div className="mt-3 flex justify-end">
            <button
              type="submit"
              disabled={request.trim().length === 0}
              className="cursor-pointer rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-default disabled:opacity-50"
            >
              Launch
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
