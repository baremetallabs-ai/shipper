import type { JSX } from 'react';

import type { PendingTerminalClose } from '../types.js';
import { Button } from './ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.js';

interface SessionCloseDialogProps {
  pendingClose: PendingTerminalClose | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export function SessionCloseDialog({
  pendingClose,
  onOpenChange,
  onConfirm,
}: SessionCloseDialogProps): JSX.Element {
  const title =
    pendingClose?.reason === 'force-kill-finalizing'
      ? 'Force-kill finalizing session?'
      : 'Discard terminal progress?';
  const description =
    pendingClose?.reason === 'force-kill-finalizing'
      ? 'Post-session processing may not complete.'
      : pendingClose
        ? `No result.json exists yet for "${pendingClose.session.label}". Closing will terminate the agent and discard progress.`
        : 'Closing this session will remove its tab.';
  const confirmLabel =
    pendingClose?.reason === 'force-kill-finalizing' ? 'Force kill' : 'Discard progress';

  return (
    <Dialog open={pendingClose !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
