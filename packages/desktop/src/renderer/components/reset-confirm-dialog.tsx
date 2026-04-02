import { LoaderCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';

import type { WorkflowStage } from '@dnsquared/shipper-core';
import { toErrorMessage } from '../../../../core/src/lib/errors.js';

import { Alert, AlertDescription, AlertTitle } from './ui/alert.js';
import { Button } from './ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.js';

type ArtifactScanSummary = Extract<
  Awaited<ReturnType<Window['shipperAPI']['scanReset']>>,
  { ok: true }
>['scan'];

interface ResetConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repo: string;
  issueNumber: number | null;
  targetStage: WorkflowStage | null;
  onResetStart: (issueNumber: number) => void;
  onResetSuccess: (issueNumber: number) => void;
  onResetFailure: (issueNumber: number) => void;
}

function SummarySection({
  title,
  items,
  emptyState,
  formatItem = (item) => item,
}: {
  title: string;
  items: string[];
  emptyState: string;
  formatItem?: (item: string) => string;
}): JSX.Element {
  return (
    <section className="space-y-2">
      <h4 className="text-sm font-medium text-foreground">{title}</h4>
      {items.length > 0 ? (
        <ul className="space-y-1 text-sm text-muted-foreground">
          {items.map((item) => (
            <li key={item} className="break-all">
              {formatItem(item)}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{emptyState}</p>
      )}
    </section>
  );
}

export function ResetConfirmDialog({
  open,
  onOpenChange,
  repo,
  issueNumber,
  targetStage,
  onResetStart,
  onResetSuccess,
  onResetFailure,
}: ResetConfirmDialogProps): JSX.Element {
  const [scan, setScan] = useState<ArtifactScanSummary | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const activeRequestIdRef = useRef(0);

  useEffect(() => {
    activeRequestIdRef.current += 1;
    const requestId = activeRequestIdRef.current;

    setScan(null);
    setScanError(null);
    setResetError(null);
    setIsResetting(false);

    if (!open || !repo || issueNumber === null || targetStage === null) {
      setIsScanning(false);
      return;
    }

    let cancelled = false;
    setIsScanning(true);

    void window.shipperAPI
      .scanReset(repo, issueNumber, targetStage)
      .then((result) => {
        if (cancelled || activeRequestIdRef.current !== requestId) {
          return;
        }

        if (!result.ok) {
          setScanError(result.error);
          return;
        }

        setScan(result.scan);
      })
      .catch((error: unknown) => {
        if (cancelled || activeRequestIdRef.current !== requestId) {
          return;
        }

        setScanError(toErrorMessage(error));
      })
      .finally(() => {
        if (!cancelled && activeRequestIdRef.current === requestId) {
          setIsScanning(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [issueNumber, open, repo, targetStage]);

  async function handleConfirm(): Promise<void> {
    if (issueNumber === null || targetStage === null || isResetting) {
      return;
    }

    setResetError(null);
    setIsResetting(true);
    onResetStart(issueNumber);

    try {
      const result = await window.shipperAPI.executeReset(repo, issueNumber, targetStage);
      if (!result.ok) {
        setResetError(result.error);
        onResetFailure(issueNumber);
        return;
      }

      onOpenChange(false);
      onResetSuccess(issueNumber);
    } catch (error) {
      setResetError(toErrorMessage(error));
      onResetFailure(issueNumber);
    } finally {
      setIsResetting(false);
    }
  }

  const prSummaries = scan?.prs.map((pr) => `#${pr.number} (${pr.headRefName})`) ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(80vh,42rem)] w-[min(calc(100vw-2rem),42rem)] gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-6 py-5">
          <DialogTitle>Reset Issue</DialogTitle>
          <DialogDescription>
            Review the cleanup that will happen before resetting this issue to{' '}
            <code>{targetStage ? `shipper:${targetStage}` : 'an earlier stage'}</code>.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-6 py-4">
          {scanError ? (
            <Alert variant="destructive">
              <AlertTitle>Could not load reset summary</AlertTitle>
              <AlertDescription>{scanError}</AlertDescription>
            </Alert>
          ) : null}

          {resetError ? (
            <Alert variant="destructive">
              <AlertTitle>Reset failed</AlertTitle>
              <AlertDescription>{resetError}</AlertDescription>
            </Alert>
          ) : null}

          {isScanning ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" />
              Loading cleanup summary...
            </div>
          ) : null}

          {!isScanning && scan ? (
            <div className="space-y-4">
              <section className="rounded-sm border border-border bg-card px-4 py-3">
                <p className="text-sm text-muted-foreground">Target stage</p>
                <p className="mt-1 text-sm font-medium text-foreground">
                  <code>{scan.targetLabel}</code>
                </p>
              </section>

              <SummarySection
                title="Labels to remove"
                items={scan.labelsToRemove}
                emptyState="No labels will be removed."
              />
              <SummarySection
                title="Pull requests to close"
                items={prSummaries}
                emptyState="No pull requests will be closed."
              />
              <SummarySection
                title="Remote branches to delete"
                items={scan.branchesToDelete}
                emptyState="No remote branches will be deleted."
              />
              <SummarySection
                title="Local branches to delete"
                items={scan.localBranches}
                emptyState="No local branches will be deleted."
              />
              <SummarySection
                title="Worktrees to remove"
                items={scan.localWorktrees}
                emptyState="No worktrees will be removed."
              />

              <section className="space-y-2">
                <h4 className="text-sm font-medium text-foreground">Comments to delete</h4>
                <p className="text-sm text-muted-foreground">
                  {scan.commentCount === 0
                    ? 'No issue comments will be deleted.'
                    : `${scan.commentCount} issue comment${scan.commentCount === 1 ? '' : 's'} will be deleted.`}
                </p>
              </section>
            </div>
          ) : null}
        </div>

        <DialogFooter className="border-t border-border px-6 py-4">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              onOpenChange(false);
            }}
            disabled={isResetting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => {
              void handleConfirm();
            }}
            disabled={isScanning || isResetting || scan === null || scanError !== null}
          >
            {isResetting ? <LoaderCircle className="size-4 animate-spin" /> : null}
            Reset
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
