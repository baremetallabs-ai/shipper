import { useEffect } from 'react';
import type { JSX } from 'react';
import { CircleCheckBig, CircleX, Info } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from './ui/alert.js';
import { Button } from './ui/button.js';
import { cn } from '../lib/utils.js';

export type BackgroundToastVariant = 'success' | 'error' | 'cancelled';

export interface BackgroundToast {
  id: string;
  variant: BackgroundToastVariant;
  title: string;
  description: string;
  issueUrl?: string;
  issueLabel?: string;
  retryable?: boolean;
}

interface BackgroundToastRegionProps {
  toasts: BackgroundToast[];
  onDismiss: (toastId: string) => void;
  onRetry?: (toastId: string) => void;
}

function ToastIcon({ variant }: { variant: BackgroundToastVariant }): JSX.Element {
  switch (variant) {
    case 'success':
      return <CircleCheckBig className="size-4" aria-hidden="true" />;
    case 'error':
      return <CircleX className="size-4" aria-hidden="true" />;
    case 'cancelled':
      return <Info className="size-4" aria-hidden="true" />;
  }
}

function ToastItem({
  toast,
  onDismiss,
  onRetry,
}: {
  toast: BackgroundToast;
  onDismiss: (toastId: string) => void;
  onRetry?: (toastId: string) => void;
}): JSX.Element {
  useEffect(() => {
    if (toast.variant !== 'success') {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      onDismiss(toast.id);
    }, 5_000);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [onDismiss, toast.id, toast.variant]);

  return (
    <Alert
      variant={toast.variant === 'error' ? 'destructive' : 'default'}
      className={cn(
        'background-toast shadow-lg',
        toast.variant === 'success' && 'border-success/40 bg-success/10 text-foreground',
        toast.variant === 'cancelled' && 'border-warning/40 bg-warning/10 text-foreground'
      )}
    >
      <ToastIcon variant={toast.variant} />
      <AlertTitle>{toast.title}</AlertTitle>
      <AlertDescription>
        <p>{toast.description}</p>
        {toast.issueUrl ? (
          <a
            href={toast.issueUrl}
            target="_blank"
            rel="noreferrer"
            className="text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            {toast.issueLabel ?? 'Open issue'}
          </a>
        ) : null}
        <div className="flex flex-wrap gap-2 pt-1">
          {toast.variant === 'error' && toast.retryable && onRetry ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                onRetry(toast.id);
              }}
            >
              Retry
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              onDismiss(toast.id);
            }}
          >
            Dismiss
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

export function BackgroundToastRegion({
  toasts,
  onDismiss,
  onRetry,
}: BackgroundToastRegionProps): JSX.Element | null {
  if (toasts.length === 0) {
    return null;
  }

  return (
    <section className="background-toast-region" aria-live="polite" aria-atomic="true">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} onRetry={onRetry} />
      ))}
    </section>
  );
}
