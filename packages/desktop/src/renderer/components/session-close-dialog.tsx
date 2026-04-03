import type { JSX } from 'react';

import type { TerminalSession } from '../types.js';
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
  session: TerminalSession | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export function SessionCloseDialog({
  session,
  onOpenChange,
  onConfirm,
}: SessionCloseDialogProps): JSX.Element {
  return (
    <Dialog open={session !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {session?.status === 'exited' ? 'Close terminal tab?' : 'Close live terminal session?'}
          </DialogTitle>
          <DialogDescription>
            {session
              ? session.status === 'exited'
                ? `"${session.label}" has already exited. Closing will remove its tab.`
                : `Closing "${session.label}" will kill the live process and remove its tab.`
              : 'Closing this session will remove its tab.'}
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
          <Button
            type="button"
            variant={session?.status === 'exited' ? 'default' : 'destructive'}
            onClick={onConfirm}
          >
            {session?.status === 'exited' ? 'Close tab' : 'Kill session'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
