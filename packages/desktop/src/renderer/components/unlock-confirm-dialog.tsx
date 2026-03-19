import { LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import type { JSX } from 'react';

import { Button } from './ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.js';

interface UnlockConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  issue: { number: number; title: string } | null;
  onConfirm: () => Promise<void>;
}

export function UnlockConfirmDialog({
  open,
  onOpenChange,
  issue,
  onConfirm,
}: UnlockConfirmDialogProps): JSX.Element {
  const [isUnlocking, setIsUnlocking] = useState(false);

  async function handleConfirm(): Promise<void> {
    if (issue === null || isUnlocking) {
      return;
    }

    setIsUnlocking(true);

    try {
      await onConfirm();
    } finally {
      setIsUnlocking(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Unlock issue</DialogTitle>
          <DialogDescription>
            {issue ? (
              <>
                <strong>
                  #{issue.number} - {issue.title}
                </strong>{' '}
                may still belong to a running agent. Removing the lock will not stop that agent, but
                it can allow concurrent work on the same issue.
              </>
            ) : (
              'This issue may still belong to a running agent. Removing the lock will not stop that agent, but it can allow concurrent work on the same issue.'
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
            disabled={isUnlocking}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => {
              void handleConfirm();
            }}
            disabled={issue === null || isUnlocking}
          >
            {isUnlocking ? <LoaderCircle className="size-4 animate-spin" /> : null}
            Unlock
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
