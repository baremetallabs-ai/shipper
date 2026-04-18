import { LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import type { JSX } from 'react';

import { toErrorMessage } from '@dnsquared/shipper-core';
import { Button } from './ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.js';

interface CloseNotPlannedDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repo: string;
  issue: { number: number; title: string } | null;
  onSuccess: (issueNumber: number) => void;
  onError: (issueNumber: number, error: string) => void;
}

export function CloseNotPlannedDialog({
  open,
  onOpenChange,
  repo,
  issue,
  onSuccess,
  onError,
}: CloseNotPlannedDialogProps): JSX.Element {
  const [isClosing, setIsClosing] = useState(false);

  async function handleConfirm(): Promise<void> {
    if (issue === null || repo.length === 0 || isClosing) {
      return;
    }

    setIsClosing(true);

    try {
      const result = await window.shipperAPI.closeNotPlanned(repo, issue.number);
      if (!result.ok) {
        onError(issue.number, result.error);
        return;
      }

      onOpenChange(false);
      onSuccess(issue.number);
    } catch (error) {
      onError(issue.number, toErrorMessage(error));
    } finally {
      setIsClosing(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Close as not planned</DialogTitle>
          <DialogDescription>
            {issue ? (
              <>
                Are you sure you want to close{' '}
                <strong>
                  #{issue.number} - {issue.title}
                </strong>
                ? All <code>shipper:</code> labels will be removed.
              </>
            ) : (
              'Are you sure you want to close this issue as not planned? All workflow labels will be removed.'
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              onOpenChange(false);
            }}
            disabled={isClosing}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => {
              void handleConfirm();
            }}
            disabled={issue === null || repo.length === 0 || isClosing}
          >
            {isClosing ? <LoaderCircle className="size-4 animate-spin" /> : null}
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
