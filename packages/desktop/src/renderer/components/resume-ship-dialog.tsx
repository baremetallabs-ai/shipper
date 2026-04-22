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

interface ResumeShipDialogProps {
  issueNumber: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export function ResumeShipDialog({
  issueNumber,
  open,
  onOpenChange,
  onConfirm,
}: ResumeShipDialogProps): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>This issue is paused. Resume and ship anyway?</DialogTitle>
          <DialogDescription>
            {issueNumber === null
              ? 'Confirming will clear the desktop pause and start shipping.'
              : `Confirming will clear the desktop pause for #${issueNumber} and start shipping.`}
          </DialogDescription>
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
          <Button type="button" onClick={onConfirm}>
            Resume and ship
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
