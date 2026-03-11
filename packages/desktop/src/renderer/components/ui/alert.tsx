import type { ComponentProps, JSX } from 'react';

import { cn } from '../../lib/utils.js';

export function Alert({
  className,
  ...props
}: ComponentProps<'div'>): JSX.Element {
  return (
    <div
      role="alert"
      className={cn(
        'relative w-full rounded-xl border border-border/80 bg-card/90 px-4 py-3 text-sm text-card-foreground shadow-sm backdrop-blur-sm',
        className
      )}
      {...props}
    />
  );
}

export function AlertTitle({
  className,
  ...props
}: ComponentProps<'h5'>): JSX.Element {
  return <h5 className={cn('mb-1 font-semibold tracking-tight', className)} {...props} />;
}

export function AlertDescription({
  className,
  ...props
}: ComponentProps<'div'>): JSX.Element {
  return <div className={cn('text-sm text-muted-foreground', className)} {...props} />;
}
